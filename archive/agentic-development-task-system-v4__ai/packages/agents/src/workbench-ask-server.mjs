#!/usr/bin/env node
/**
 * workbench-ask MCP server.
 *
 * Spawned by the `claude` CLI (via --mcp-config) and named as the
 * --permission-prompt-tool. It exposes ONE tool, `workbench_ask`, which the CLI
 * calls (a) for tool-permission boundaries and (b) when the agent deliberately
 * asks the operator a structured question.
 *
 * It does not decide anything itself: it RELAYS the call to the daemon's
 * internal /ask endpoint and long-polls — the daemon persists the question,
 * surfaces it to the human over SSE, and holds the HTTP response open until the
 * human answers. This server then maps that answer back into the contract the
 * CLI expects (confirmed in the spike):
 *   permission: content[0].text = JSON {behavior:"allow",updatedInput} | {behavior:"deny",message}
 *   question:   content[0].text = free-text verbatim, or a fenced json block
 *               {selected:[...]} for option choices (lossless multi-select)
 *
 * Transport is line-delimited JSON-RPC 2.0 over stdio — no deps.
 *
 * Env:
 *   WORKBENCH_DAEMON_URL  base URL of the daemon (e.g. http://127.0.0.1:4317)
 *   WORKBENCH_RUN_ID      the AgentRun this server is gating
 */
import process from 'node:process';

const DAEMON_URL = process.env.WORKBENCH_DAEMON_URL;
const RUN_ID = process.env.WORKBENCH_RUN_ID;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

/**
 * Structured log to STDERR (stdout is the JSON-RPC channel — must stay clean).
 * Dep-free on purpose: this script is run by the `claude` CLI via the bare node
 * binary, so it can't import pino. Lines are JSON tagged with `runId` so they
 * land on the same trace as the daemon's run logger and the `/ask` request log.
 * The CLI captures this stderr into the run transcript.
 */
function logLine(level, msg, extra) {
  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      component: 'ask-server',
      runId: RUN_ID,
      msg,
      ...extra,
    }) + '\n',
  );
}

const TOOL = {
  name: 'workbench_ask',
  description:
    'Ask the human operator to approve a tool use or answer a structured question, ' +
    'and wait for their decision. For permission prompts the CLI fills tool_name/input; ' +
    'for a deliberate question, pass header + question (+ options for multiple choice).',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string', description: 'Tool being permission-checked (CLI-supplied).' },
      input: { type: 'object', description: 'Proposed tool input (CLI-supplied).' },
      header: { type: 'string', description: 'Short chip label for a deliberate question.' },
      question: { type: 'string', description: 'The question text.' },
      options: {
        type: 'array',
        items: {
          type: 'object',
          properties: { label: { type: 'string' }, description: { type: 'string' } },
        },
      },
      multiSelect: { type: 'boolean' },
    },
  },
};

/** Relay a tool call to the daemon and await the human's answer. */
async function relay(args) {
  const isPermission = typeof args.tool_name === 'string' && args.question === undefined;

  const body = isPermission
    ? {
        header: 'Permission',
        question: `Allow ${args.tool_name}?`,
        options: [
          { label: 'allow', description: `Permit ${args.tool_name}` },
          { label: 'deny', description: `Block ${args.tool_name}` },
        ],
        multiSelect: false,
        permission: { toolName: args.tool_name, toolInput: args.input ?? {} },
      }
    : {
        header: args.header ?? 'Question',
        question: args.question ?? '(no question text)',
        options: Array.isArray(args.options) ? args.options : null,
        multiSelect: Boolean(args.multiSelect),
      };

  logLine('info', isPermission ? 'relay permission prompt' : 'relay question', {
    kind: isPermission ? 'permission' : 'question',
    tool: isPermission ? args.tool_name : undefined,
  });
  const res = await fetch(`${DAEMON_URL}/internal/agent/runs/${RUN_ID}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`daemon /ask returned ${res.status}`);
  const { answer } = await res.json();
  logLine('info', 'relay answered', {
    selected: 'selected' in answer ? answer.selected : undefined,
  });

  if (isPermission) {
    const allowed = 'selected' in answer && answer.selected.includes('allow');
    const payload = allowed
      ? { behavior: 'allow', updatedInput: args.input ?? {} }
      : { behavior: 'deny', message: 'denied by operator' };
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  }
  // Deliberate question: return the answer to the agent. Selected options are
  // returned as a structured json block (not a comma-joined string) so a
  // multi-select answer round-trips unambiguously even if a label contains a
  // comma or newline; free text is returned verbatim.
  const text =
    'selected' in answer
      ? `The operator selected:\n\`\`\`json\n${JSON.stringify({ selected: answer.selected })}\n\`\`\``
      : String(answer.text ?? '');
  return { content: [{ type: 'text', text }] };
}

async function handle(req) {
  const { id, method, params } = req;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'workbench-ask', version: '0.1.0' },
      },
    });
    return;
  }
  if (method === 'notifications/initialized') return;

  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [TOOL] } });
    return;
  }

  if (method === 'tools/call') {
    try {
      const result = await relay(params?.arguments ?? {});
      send({ jsonrpc: '2.0', id, result });
    } catch (err) {
      // On relay failure, fail closed so the run can't silently proceed. The
      // shape differs by path: a permission check expects a deny object; a
      // deliberate question expects answer *text* (a deny object would be fed
      // back as if it were the answer).
      const args = params?.arguments ?? {};
      const isPermission = typeof args.tool_name === 'string' && args.question === undefined;
      logLine('error', 'relay failed (failing closed)', {
        error: String(err),
        kind: isPermission ? 'permission' : 'question',
      });
      const text = isPermission
        ? JSON.stringify({ behavior: 'deny', message: `ask relay failed: ${err}` })
        : `(ask relay failed: ${err})`;
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text }] },
      });
    }
    return;
  }

  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl = buf.indexOf('\n');
  while (nl !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    nl = buf.indexOf('\n');
    if (!line) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      continue; // skip a malformed frame rather than crash the gate server
    }
    void handle(req);
  }
});

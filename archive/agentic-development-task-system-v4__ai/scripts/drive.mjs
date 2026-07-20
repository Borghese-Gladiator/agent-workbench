#!/usr/bin/env node
/**
 * drive — the SINGLE driver that runs Agent Workbench end-to-end against an
 * isolated daemon, for any scenario, in one of three output modes. Replaces the
 * three former drivers (demo.mjs, live-e2e.mjs, proof-run.mjs).
 *
 * A scenario is a JSON file under scripts/scenarios/ describing the project + the
 * task request (a template; {ticketId}/{ticketUrl}/{repo} are substituted). You
 * pick a scenario, optionally override the prompt/title/repo from the CLI, and
 * pick a mode that decides what the run produces:
 *
 *   record   spawn the web UI + a Playwright recorder that walks the human gates
 *            and records a .webm of the product (+ shows the built result).
 *   headless drive the gates over the API only (no browser); report artifacts.
 *   proof    drive a deterministic seed repo and emit a durable PASS/FAIL bundle
 *            (CI gate). Mock runtime by default; --live for real claude + PR.
 *
 *   node scripts/drive.mjs --scenario tictactoe                 # record (default)
 *   node scripts/drive.mjs --scenario tictactoe --mode headless
 *   node scripts/drive.mjs --scenario enterprise --ticket CORE-242 --repo app
 *   node scripts/drive.mjs --scenario proof --mode proof        # == `pnpm proof`
 *   node scripts/drive.mjs --scenario proof --mode proof --live
 *
 * Record against your ALREADY-RUNNING stack so the task + artifacts persist in the
 * real DB (no throwaway daemon spun up, nothing torn down):
 *   pnpm dev                                                   # start daemon :4417 + web :5317
 *   node scripts/drive.mjs --scenario enterprise --ticket CORE-242 --attach
 *
 * Override any scenario field from the CLI:
 *   --prompt "<request>"   replace the task request (the headline feature here)
 *   --title  "<title>"     replace the task title
 *   --target <dir>         fresh-repo target (create scenarios)
 *   --runtime claude|mock  agent runtime
 *   --dev / --test / --typecheck <cmd>   project commands
 *   --port / --web-port <n>              ports
 *   --pace <ms>            recorder read-beat
 *   --no-record            record mode -> drive headless instead
 *   --keep                 keep data dir / target after exit
 *   --attach               record against an already-running daemon + web; persists
 *                          the task + artifacts in the real DB (spawns/cleans nothing)
 *   --daemon-url / --web-url <url>   attach targets (default :4417 / :5317)
 *   --dry-run              print the fully-resolved config as JSON and exit (no daemon)
 *
 * Requirements (live runs): `claude` CLI logged in; enterprise needs the seeded
 * repo at ~/Klaviyo/Repos/<repo>, `gh` authed, and Linear MCP for the agent.
 */
import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  backoff,
  expandHome,
  fireGate,
  flag,
  git,
  has,
  makeApi,
  makeFreshRepo,
  makeMcpApi,
  mcpTool,
  pollTask,
  waitForHealth,
  waitForRunToFinish,
  waitUntilStage,
} from './lib/driver-core.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCENARIO_DIR = join(REPO_ROOT, 'scripts', 'scenarios');
const log = (...m) => console.log('[drive]', ...m);

// ---------------------------------------------------------------------------
// scenario resolution
// ---------------------------------------------------------------------------

/** Normalize a --ticket value to a bare ticket id (CORE-242). Throws on garbage. */
function normalizeTicket(raw) {
  const v = (raw ?? '').trim();
  if (!v) throw new Error('this scenario requires --ticket <id|url>');
  const fromUrl = v.match(/\/issue\/([A-Za-z]+-\d+)/);
  if (fromUrl) return fromUrl[1].toUpperCase();
  if (/^[A-Za-z]+-\d+$/.test(v)) return v.toUpperCase();
  throw new Error(`--ticket "${v}" is not a Linear id or issue URL (expected e.g. CORE-242)`);
}

/** Apply {placeholder} substitution across a string using the vars map. */
function subst(str, vars) {
  return str.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

/** Join a request that may be a string or an array of lines, then substitute. */
function renderRequest(req, vars) {
  const text = Array.isArray(req) ? req.join('\n') : String(req);
  return subst(text, vars);
}

/**
 * Load a scenario JSON and resolve it into a concrete run config, applying CLI /
 * env overrides. The result is fully self-describing — a mode handler reads only
 * from it (no re-parsing argv for scenario data).
 */
function resolveScenario(name) {
  const file = join(SCENARIO_DIR, `${name}.json`);
  if (!existsSync(file)) {
    const avail = readdirSync(SCENARIO_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .join(', ');
    throw new Error(`unknown scenario "${name}" (available: ${avail})`);
  }
  const s = JSON.parse(readFileSync(file, 'utf8'));

  // --- vars available to request/title/path templates ---
  const vars = {};
  const req = s.requires ?? {};
  if (req.ticket) {
    const ticketId = normalizeTicket(flag('ticket') ?? process.env.DRIVE_TICKET);
    vars.ticketId = ticketId;
    vars.ticketUrl = `https://linear.app/klaviyo/issue/${ticketId}`;
  }
  if (Array.isArray(req.repo)) {
    const repo = (
      flag('repo') ??
      process.env.DRIVE_REPO ??
      req.defaultRepo ??
      req.repo[0]
    ).toLowerCase();
    if (!req.repo.includes(repo)) {
      throw new Error(
        `--repo "${repo}" is not valid for ${name} (expected ${req.repo.join(' | ')})`,
      );
    }
    vars.repo = repo;
  }

  // --- task request: template + optional per-repo append, then --prompt override ---
  let request = renderRequest(s.task.request, vars);
  const append = s.task.requestAppend?.[vars.repo];
  if (append) request += `\n${renderRequest(append, vars)}`;
  const promptOverride = flag('prompt') ?? process.env.DRIVE_PROMPT;
  if (promptOverride) request = promptOverride;

  const title = flag('title') ?? process.env.DRIVE_TITLE ?? subst(s.task.title, vars);

  // --- project config (create-fresh vs match-seeded) ---
  const project = { ...s.project };
  if (project.target) project.target = expandHome(flag('target') ?? project.target);
  if (project.matchRepo) project.matchRepo = expandHome(subst(project.matchRepo, vars));
  for (const [cliFlag, key] of [
    ['dev', 'devCommand'],
    ['test', 'testCommand'],
    ['typecheck', 'typecheckCommand'],
    ['runtime', 'agentRuntime'],
  ]) {
    const v = flag(cliFlag);
    if (v !== undefined) project[key] = v;
  }
  if (has('live') && project.agentRuntime === 'mock') project.agentRuntime = 'claude';

  // --- mode / slug ---
  let mode = flag('mode') ?? process.env.DRIVE_MODE ?? s.defaultMode ?? 'headless';
  if (mode === 'record' && has('no-record')) mode = 'headless';
  // A per-ticket slug keeps enterprise runs (and their videos) distinct per ticket.
  const slug = vars.ticketId ? `${name}-${vars.ticketId.toLowerCase()}` : name;

  return {
    name,
    slug,
    mode,
    vars,
    resultMode: s.resultMode ?? 'pr',
    // Optional "play" block for server-backed apps the recorder must boot to show
    // (e.g. a Vite dev server + a WS game server, reached at a sub-route). When
    // absent, resultMode:"play" falls back to opening the worktree's index.html
    // over file:// — fine for a static no-build app (tic-tac-toe), useless for a
    // framework/server app whose modules only resolve under a dev server.
    play: s.play ?? null,
    project,
    task: { title, request },
  };
}

// ---------------------------------------------------------------------------
// daemon / web boot
// ---------------------------------------------------------------------------

function spawnDaemon(port, dataDir) {
  const proc = spawn('pnpm', ['--filter', '@workbench/daemon', 'start'], {
    cwd: REPO_ROOT,
    env: { ...process.env, WORKBENCH_PORT: String(port), WORKBENCH_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => process.stdout.write(`  [daemon] ${d}`));
  proc.stderr.on('data', (d) => process.stderr.write(`  [daemon] ${d}`));
  return proc;
}

function spawnWeb(daemonPort, webPort) {
  const proc = spawn('pnpm', ['--filter', '@workbench/web', 'dev'], {
    cwd: REPO_ROOT,
    env: { ...process.env, WORKBENCH_PORT: String(daemonPort), VITE_PORT: String(webPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => process.stdout.write(`  [web] ${d}`));
  proc.stderr.on('data', (d) => process.stderr.write(`  [web] ${d}`));
  return proc;
}

/** Create the project (fresh repo) or find the seeded one by repo path. */
async function ensureProject(api, cfg, repoDir) {
  if (cfg.project.create) {
    const { body } = await api('POST', '/projects', {
      name: cfg.project.name,
      repoPath: repoDir,
      defaultBranch: cfg.project.defaultBranch ?? 'main',
      agentRuntime: cfg.project.agentRuntime,
      deliveryPolicy: cfg.project.deliveryPolicy,
      devCommand: cfg.project.devCommand,
      testCommand: cfg.project.testCommand,
      typecheckCommand: cfg.project.typecheckCommand,
    });
    if (!body?.id) throw new Error(`project create failed: ${JSON.stringify(body)}`);
    return body;
  }
  // Match the auto-seeded project by repoPath.
  if (!existsSync(cfg.project.matchRepo)) {
    throw new Error(
      `scenario "${cfg.name}" needs the repo at ${cfg.project.matchRepo} ` +
        `(the daemon seeds the enterprise project from it on boot)`,
    );
  }
  const { body: projects } = await api('GET', '/projects');
  const match = (projects ?? []).find(
    (p) => resolve(p.repoPath) === resolve(cfg.project.matchRepo),
  );
  if (!match) {
    throw new Error(
      `could not find the seeded project for ${cfg.project.matchRepo}; ` +
        `projects: ${(projects ?? []).map((p) => p.name).join(', ')}`,
    );
  }
  log(`using seeded project: ${match.name} (${match.deliveryPolicy})`);
  return match;
}

// ---------------------------------------------------------------------------
// mode: record  (web UI + Playwright recorder)
// ---------------------------------------------------------------------------

function findWebms(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findWebms(full));
    else if (entry.name.endsWith('.webm')) out.push(full);
  }
  return out;
}

/** Promote Playwright's nested video to a stable demo-artifacts/<slug>/<slug>.webm. */
function promoteVideo(outputDir, slug) {
  const webms = findWebms(join(outputDir, 'test-results'));
  if (webms.length === 0) return null;
  webms.sort((a, b) => statSync(b).size - statSync(a).size);
  const dest = join(outputDir, `${slug}.webm`);
  copyFileSync(webms[0], dest);
  return dest;
}

function runRecorder(cfg, tid, webUrl, base, outputDir, pace, playCwd) {
  // For a server-backed "play" result, tell the recorder how to boot + reach the
  // built app: the commands to run, the cwd to run them in (the project repo,
  // where the merged code lives), and the URL to navigate to once they're up.
  const playEnv =
    cfg.resultMode === 'play' && cfg.play && playCwd
      ? {
          DEMO_PLAY_URL: cfg.play.url,
          DEMO_PLAY_READY_URL: cfg.play.readyUrl ?? cfg.play.url,
          DEMO_PLAY_SERVERS: JSON.stringify(cfg.play.servers ?? []),
          DEMO_PLAY_CWD: playCwd,
        }
      : {};
  return new Promise((resolveDone, rejectDone) => {
    const rec = spawn(
      'pnpm',
      [
        '--filter',
        '@workbench/web',
        'exec',
        'playwright',
        'test',
        '-c',
        'demo-harness/playwright.config.ts',
      ],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          DEMO_WEB_URL: webUrl,
          DEMO_API_BASE: base,
          DEMO_TASK_ID: tid,
          DEMO_SCENARIO: cfg.slug,
          DEMO_RESULT_MODE: cfg.resultMode,
          DEMO_OUTPUT_DIR: outputDir,
          DEMO_PACE_MS: String(pace),
          ...playEnv,
        },
        stdio: 'inherit',
      },
    );
    rec.on('exit', (code) =>
      code === 0 ? resolveDone() : rejectDone(new Error(`recorder exited ${code}`)),
    );
  });
}

async function modeRecord(cfg, ports, dataDir) {
  const { port, webPort, pace } = ports;
  const base = `http://127.0.0.1:${port}/api`;
  const webUrl = `http://localhost:${webPort}`;
  const outputDir = join(REPO_ROOT, 'demo-artifacts', cfg.slug);
  mkdirSync(outputDir, { recursive: true });
  log(`recording -> ${outputDir}`);

  const daemon = spawnDaemon(port, dataDir);
  const web = spawnWeb(port, webPort);
  let driver = { api: makeApi(base), mcp: null, close: async () => {} };
  const cleanup = () => {
    void driver.close();
    daemon.kill('SIGTERM');
    web.kill('SIGTERM');
    if (!has('keep')) rmSync(dataDir, { recursive: true, force: true });
  };

  try {
    await waitForHealth(daemon, 'daemon', async () => (await fetch(`${base}/health`)).ok);
    log('daemon healthy');
    await waitForHealth(web, 'web', async () => (await fetch(webUrl)).ok);
    log('web healthy');

    // Drive reads + create_* through the MCP (dogfood). Gates still fire via the
    // raw non-awaited POST; the MCP layer falls back to fetch for unmapped paths.
    driver = await makeMcpApi(base, REPO_ROOT);
    log(driver.mcp ? 'driving through @workbench/mcp' : `MCP unavailable (${driver.mcpError})`);
    const api = driver.api;

    const repoDir = cfg.project.create ? freshRepoFor(cfg) : null;
    const project = await ensureProject(api, cfg, repoDir);
    log(`project ${project.id}`);

    const { body: task } = await api('POST', '/tasks', {
      projectId: project.id,
      title: cfg.task.title,
      rawRequest: cfg.task.request,
    });
    if (!task?.id) throw new Error(`task create failed: ${JSON.stringify(task)}`);
    const tid = task.id;
    log(`task ${tid}  ->  ${webUrl}/tasks/${tid}`);

    // Kick the brief so the first gate is reachable, then record the UI walking gates.
    fireGate(base, tid, 'generate-brief');

    let recorderError = null;
    log('recording the UI through every gate (runs the full real build) ...');
    try {
      await runRecorder(cfg, tid, webUrl, base, outputDir, pace, project.repoPath ?? repoDir);
    } catch (e) {
      recorderError = e;
      log(`recorder did not finish cleanly: ${e?.message ?? e}`);
    }

    const { body: detail } = await api('GET', `/tasks/${tid}`);
    log(`final stage: ${detail?.task?.stage}/${detail?.task?.status}`);
    if (detail?.delivery?.prUrl) log(`PR: ${detail.delivery.prUrl}`);

    const finalVideo = promoteVideo(outputDir, cfg.slug);
    if (finalVideo) log(`VIDEO: ${finalVideo}`);
    else log(`no video under ${outputDir}/test-results (did the recorder run?)`);

    if (recorderError) throw recorderError;
    log('done.');
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// mode: attach  (record against an ALREADY-RUNNING daemon + web)
// ---------------------------------------------------------------------------

/**
 * Poll an already-running service. Unlike `waitForHealth` there is no child proc
 * to watch — if it never comes up we fail fast telling the user to start their
 * stack, because attach mode must NEVER spawn a competing daemon against the
 * real DB.
 */
async function requireHealthy(label, url, check, { tries = 8, intervalMs = 250 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      if (await check()) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `${label} is not reachable at ${url}. Start your stack first (\`pnpm dev\`), ` +
      `then re-run with --attach.`,
  );
}

/**
 * Record against the daemon + web the user is ALREADY running (defaults
 * 127.0.0.1:4417 / localhost:5317). Spawns nothing, owns no data dir, and never
 * cleans up — the task + artifacts persist in the real DB because they were
 * created there directly. The enterprise payoff: keep the task and its artifacts.
 */
async function modeAttach(cfg, attach, pace) {
  const base = `${attach.daemonUrl}/api`;
  const webUrl = attach.webUrl;
  const outputDir = join(REPO_ROOT, 'demo-artifacts', cfg.slug);
  mkdirSync(outputDir, { recursive: true });
  log(`attach: daemon ${attach.daemonUrl}  web ${webUrl}  -> recording ${outputDir}`);

  await requireHealthy('daemon', attach.daemonUrl, async () => (await fetch(`${base}/health`)).ok);
  log('daemon healthy');
  await requireHealthy('web', webUrl, async () => (await fetch(webUrl)).ok);
  log('web healthy');

  let driver = { api: makeApi(base), mcp: null, close: async () => {} };
  try {
    driver = await makeMcpApi(base, REPO_ROOT);
    log(driver.mcp ? 'driving through @workbench/mcp' : `MCP unavailable (${driver.mcpError})`);
    const api = driver.api;

    // Attach never creates a fresh repo; the enterprise scenario matches the
    // seeded project in the running daemon's DB.
    const repoDir = cfg.project.create ? freshRepoFor(cfg) : null;
    const project = await ensureProject(api, cfg, repoDir);
    log(`project ${project.id}`);

    const { body: task } = await api('POST', '/tasks', {
      projectId: project.id,
      title: cfg.task.title,
      rawRequest: cfg.task.request,
    });
    if (!task?.id) throw new Error(`task create failed: ${JSON.stringify(task)}`);
    const tid = task.id;
    log(`task ${tid}  ->  ${webUrl}/tasks/${tid}`);

    fireGate(base, tid, 'generate-brief');

    let recorderError = null;
    log('recording the UI through every gate (runs the full real build) ...');
    try {
      await runRecorder(cfg, tid, webUrl, base, outputDir, pace, project.repoPath ?? repoDir);
    } catch (e) {
      recorderError = e;
      log(`recorder did not finish cleanly: ${e?.message ?? e}`);
    }

    const { body: detail } = await api('GET', `/tasks/${tid}`);
    log(`final stage: ${detail?.task?.stage}/${detail?.task?.status}`);
    if (detail?.delivery?.prUrl) log(`PR: ${detail.delivery.prUrl}`);
    log(`task ${tid} and its artifacts persisted in the running daemon's DB`);

    const finalVideo = promoteVideo(outputDir, cfg.slug);
    if (finalVideo) log(`VIDEO: ${finalVideo}`);
    else log(`no video under ${outputDir}/test-results (did the recorder run?)`);

    if (recorderError) throw recorderError;
    log('done.');
  } finally {
    // Attach mode owns nothing: only close the MCP client. Never kill the
    // daemon/web, never rm a data dir.
    await driver.close();
  }
}

// ---------------------------------------------------------------------------
// mode: headless  (API-only drive, report artifacts)
// ---------------------------------------------------------------------------

async function modeHeadless(cfg, ports, dataDir) {
  const { port } = ports;
  const base = `http://127.0.0.1:${port}/api`;
  const rawApi = makeApi(base);
  const daemon = spawnDaemon(port, dataDir);

  try {
    await waitForHealth(
      daemon,
      'daemon',
      async () => (await rawApi('GET', '/health')).status === 200,
    );
    log('daemon healthy');

    // Switch to the MCP-backed driver once the daemon is up (dogfood).
    const driver = await makeMcpApi(base, REPO_ROOT);
    log(driver.mcp ? 'driving through @workbench/mcp' : `MCP unavailable (${driver.mcpError})`);
    const api = driver.api;

    const repoDir = cfg.project.create ? freshRepoFor(cfg) : null;
    const project = await ensureProject(api, cfg, repoDir);
    log(`project ${project.id}`);

    const { body: task } = await api('POST', '/tasks', {
      projectId: project.id,
      title: cfg.task.title,
      rawRequest: cfg.task.request,
    });
    if (!task?.id) throw new Error(`task create failed: ${JSON.stringify(task)}`);
    const tid = task.id;
    log(`task ${tid}`);

    log('POST generate-brief ...');
    fireGate(base, tid, 'generate-brief');
    await waitUntilStage(api, tid, 'human_brief_approval', 'brief', 600_000, log, { base });

    log('POST approve-brief (-> discovery + plan) ...');
    fireGate(base, tid, 'approve-brief');
    await waitUntilStage(api, tid, 'human_plan_approval', 'plan', 900_000, log, { base });

    log('POST approve-plan (-> implementation + QA video + self-review) ...');
    fireGate(base, tid, 'approve-plan');
    await waitUntilStage(api, tid, 'human_review', 'build+qa', 1_800_000, log, { base });

    const { body: detail } = await api('GET', `/tasks/${tid}`);
    log(`final stage: ${detail?.task?.stage}/${detail?.task?.status}`);
    const demo = (detail?.artifacts ?? []).find((a) => a.kind === 'demo_evidence');
    if (demo) {
      const { body: full } = await api('GET', `/artifacts/${demo.id}`);
      log('--- demo_evidence ---');
      console.log(full?.body ?? '(empty)');
      log('---------------------');
    } else {
      log('no demo_evidence artifact found');
    }

    const assetsDir = join(dataDir, 'artifacts', tid, 'demo-assets');
    if (existsSync(assetsDir)) {
      log(`captured demo-assets in ${assetsDir}:`);
      for (const f of readdirSync(assetsDir)) log(`  - ${f}`);
    } else {
      log(`no demo-assets captured at ${assetsDir}`);
    }
    log(`task id: ${tid}  (daemon left running on :${port} — Ctrl-C to stop)`);
    await new Promise(() => {}); // keep daemon up for inspection
  } catch (e) {
    log(`ERROR: ${e?.message ?? e}`);
    log(`daemon left running on :${port} for inspection — Ctrl-C to stop`);
    await new Promise(() => {});
  }
}

// ---------------------------------------------------------------------------
// mode: proof  (deterministic durable bundle + PASS/FAIL verdict, CI gate)
// ---------------------------------------------------------------------------

function writeFileSafe(p, content) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

function renderReport(m, diff) {
  const gates = m.gates.map((g) => `- **${g.gate}** — ${g.decision} (${g.at})`).join('\n');
  const val = m.validation.length
    ? m.validation.map((v) => `- \`${v.command}\` — **${v.status}**`).join('\n')
    : '- (none configured)';
  const diffPreview = diff.split('\n').slice(0, 40).join('\n');
  return `# Proof Run — ${m.verdict}

- **Task:** ${m.taskId} — ${m.project}
- **Mode:** ${m.mode} (runtime: ${m.runtime})
- **Reached:** ${m.reachedStage} / ${m.finalStatus}
- **Duration:** ${(m.durationMs / 1000).toFixed(1)}s
- **Delivery:** ${m.delivery.status ?? 'n/a'}${m.delivery.prUrl ? ` — ${m.delivery.prUrl}` : ''}

## Gates
${gates}

## Validation (real command results)
${val}

## Worktree diff (first 40 lines)
\`\`\`diff
${diffPreview}
\`\`\`

_Verdict is PASS only when the task reached closeout/done, no validation
command failed, and delivery did not fail. Every value above comes from a real
side effect recorded during the run._
`;
}

async function modeProof(cfg, ports) {
  const { port } = ports;
  const base = `http://127.0.0.1:${port}/api`;
  const rawApi = makeApi(base);
  const LIVE = has('live');
  const KEEP = has('keep');
  const outFlagIdx = process.argv.indexOf('--out');
  const OUT_ROOT =
    outFlagIdx >= 0 ? resolve(process.argv[outFlagIdx + 1]) : join(REPO_ROOT, 'data', 'proof-runs');

  const work = mkdtempSync(join(tmpdir(), 'wb-proof-'));
  const dataDir = join(work, 'data');
  mkdirSync(dataDir, { recursive: true });
  const repo = makeFreshRepo(join(work, 'seed-repo'), {
    label: 'Proof Run',
    seedCheck: true,
    failCheck: !!process.env.PROOF_FAIL_CHECK,
  });
  const startedAt = new Date();
  log(`mode=proof runtime=${cfg.project.agentRuntime} port=${port}`);
  log(`seed repo: ${repo}`);

  const proc = spawnDaemon(port, dataDir);
  let bundleDir;
  let verdict = 'FAIL';
  let driver = { api: rawApi, mcp: null, close: async () => {} };
  try {
    await waitForHealth(
      proc,
      'daemon',
      async () => (await rawApi('GET', '/health')).status === 200,
      {
        tries: 100,
        intervalMs: 200,
      },
    );
    log('daemon healthy');

    // Dogfood: reads + create_* go through @workbench/mcp; gates stay raw POSTs.
    driver = await makeMcpApi(base, REPO_ROOT);
    log(driver.mcp ? 'driving through @workbench/mcp' : `MCP unavailable (${driver.mcpError})`);
    const api = driver.api;

    const { body: project } = await api('POST', '/projects', {
      name: cfg.project.name,
      repoPath: repo,
      defaultBranch: 'main',
      agentRuntime: cfg.project.agentRuntime,
      deliveryPolicy: cfg.project.deliveryPolicy,
      testCommand: cfg.project.testCommand,
      typecheckCommand: cfg.project.typecheckCommand,
    });
    const { body: task } = await api('POST', '/tasks', {
      projectId: project.id,
      title: cfg.task.title,
      rawRequest: cfg.task.request,
    });
    const tid = task.id;
    log(`task ${tid} created`);

    const GATE_STAGES = new Set([
      'human_brief_approval',
      'human_plan_approval',
      'human_review',
      'human_delivery_approval',
    ]);
    const gates = [
      'generate-brief',
      'approve-brief',
      'approve-plan',
      'review/complete',
      'approve-delivery',
    ];
    for (const g of gates) {
      const before = (await api('GET', `/tasks/${tid}`)).body?.task;
      const fromStage = before?.stage;
      const r = await api('POST', `/tasks/${tid}/${g}`);
      if (r.status !== 0 && r.status !== 200) {
        log(`  ${g} did not clear (${r.status}: ${JSON.stringify(r.body)}) — stopping drive`);
        break;
      }
      if (r.dropped) log(`  ${g} kicked (POST connection dropped as expected; polling…)`);

      const settled = await pollTask(api, tid, (t) => {
        if (t.status === 'done' || t.status === 'abandoned') return true;
        if (t.stage === fromStage) return false;
        return GATE_STAGES.has(t.stage);
      });
      // Drain any still-active run so the next kick can't double-fire. Prefer the
      // SSE run-complete signal (reacts the instant the run ends); fall back to
      // backoff-polling runs/active if SSE is unavailable or drops. When the MCP
      // is driving, go through its wait_for_run tool (dogfood); else the raw SSE.
      const drained = driver.mcp
        ? (await mcpTool(driver.mcp, 'wait_for_run', { taskId: tid, timeoutMs: 10 * 60_000 }))
            .outcome
        : await waitForRunToFinish(base, tid, { timeoutMs: 10 * 60_000 });
      if (drained === 'fallback') {
        let active = (await api('GET', `/tasks/${tid}/agent/runs/active`)).body?.run;
        const drainDeadline = Date.now() + 10 * 60_000;
        const drainBackoff = backoff();
        while (active && Date.now() < drainDeadline) {
          await drainBackoff.wait();
          active = (await api('GET', `/tasks/${tid}/agent/runs/active`)).body?.run;
        }
      }
      log(`  ${g} -> ${settled?.stage}/${settled?.status}`);
      if (settled?.status === 'done' || settled?.status === 'abandoned') break;
      if (settled && !GATE_STAGES.has(settled.stage)) {
        log(`  parked at non-gate ${settled.stage}/${settled.status} — stopping drive`);
        break;
      }
    }

    const { body: detail } = await api('GET', `/tasks/${tid}`);
    const diffRes = await api('GET', `/tasks/${tid}/worktree/diff`);
    const diff = diffRes.body?.diff ?? '(no worktree diff available)';

    const ts = startedAt.toISOString().replace(/[:.]/g, '-');
    bundleDir = join(OUT_ROOT, `${ts}__${tid}`);
    mkdirSync(bundleDir, { recursive: true });

    for (const art of detail.artifacts) {
      const { body: full } = await api('GET', `/artifacts/${art.id}`);
      writeFileSafe(join(bundleDir, 'artifacts', `${art.kind}.md`), full?.body ?? '');
    }
    for (const v of detail.validationRuns ?? []) {
      writeFileSafe(
        join(bundleDir, 'validation', `${v.id}.log`),
        `# ${v.command}\nstatus: ${v.status}\n`,
      );
    }
    writeFileSafe(join(bundleDir, 'git', 'branch.txt'), `${detail.worktree?.branch ?? ''}\n`);
    writeFileSafe(join(bundleDir, 'git', 'final.diff'), diff);
    writeFileSafe(
      join(bundleDir, 'git', 'pr-url.txt'),
      `${detail.delivery?.prUrl ?? '(dry-run / no PR)'}\n`,
    );
    for (const run of detail.agentRuns ?? []) {
      const ev = await api('GET', `/tasks/${tid}/agent/runs/${run.id}`);
      const events = ev.body?.events ?? [];
      writeFileSafe(
        join(bundleDir, 'agent', `events-${run.id}.ndjson`),
        `${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
      );
    }
    writeFileSafe(
      join(bundleDir, 'timeline.json'),
      JSON.stringify({ stageRuns: detail.stageRuns, approvals: detail.approvals }, null, 2),
    );

    const finishedAt = new Date();
    const validation = (detail.validationRuns ?? []).map((v) => ({
      command: v.command,
      status: v.status,
    }));
    const anyValidationFailed = validation.some((v) => v.status === 'failed');
    const deliveryFailed = detail.delivery?.status === 'failed';
    const reached = detail.task.stage;
    const finalStatus = detail.task.status;
    verdict =
      reached === 'closeout' && finalStatus === 'done' && !anyValidationFailed && !deliveryFailed
        ? 'PASS'
        : 'FAIL';

    const manifest = {
      taskId: tid,
      project: project.name,
      runtime: cfg.project.agentRuntime,
      mode: LIVE ? 'live' : 'mock',
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt - startedAt,
      reachedStage: reached,
      finalStatus,
      gates: (detail.approvals ?? []).map((a) => ({
        gate: a.gate,
        decision: a.decision,
        at: a.decidedAt,
      })),
      validation,
      delivery: { status: detail.delivery?.status ?? null, prUrl: detail.delivery?.prUrl ?? null },
      verdict,
    };
    writeFileSafe(join(bundleDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    writeFileSafe(join(bundleDir, 'REPORT.md'), renderReport(manifest, diff));
    log(`bundle: ${bundleDir}`);
    log(`VERDICT: ${verdict}`);
  } finally {
    await driver.close();
    proc.kill('SIGTERM');
    if (!KEEP) rmSync(work, { recursive: true, force: true });
  }
  process.exit(verdict === 'PASS' ? 0 : 1);
}

// ---------------------------------------------------------------------------
// fresh-repo helper for record/headless create scenarios
// ---------------------------------------------------------------------------

function freshRepoFor(cfg) {
  const target = cfg.project.target;
  const keep = has('keep-target') || !!process.env.DRIVE_KEEP_TARGET || cfg.project.wipe === false;
  log(`${keep ? 'existing repo (no wipe)' : 'fresh repo'}: ${target}`);
  const repo = makeFreshRepo(target, { keep, label: cfg.project.name ?? cfg.name });
  // Only stamp the builder README on a freshly-created throwaway repo. When we're
  // building INSIDE an existing repo (keep), leave its base branch untouched —
  // the build lands on the worktree branch, not main.
  if (!keep) {
    writeFileSync(join(repo, 'README.md'), `# ${cfg.name} (built by Agent Workbench)\n`);
    try {
      git(repo, 'add', '.');
      git(repo, '-c', 'commit.gpgsign=false', 'commit', '-q', '--amend', '--no-edit');
    } catch {
      /* nothing staged — fine */
    }
  }
  return repo;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const name = flag('scenario') ?? process.env.DRIVE_SCENARIO ?? 'tictactoe';
  const cfg = resolveScenario(name);

  const ports = {
    port: Number(flag('port') ?? process.env.DRIVE_PORT ?? (cfg.mode === 'proof' ? 4500 : 4602)),
    webPort: Number(flag('web-port') ?? process.env.DRIVE_WEB_PORT ?? 5318),
    pace: Number(flag('pace') ?? process.env.DRIVE_PACE_MS ?? 1500),
  };

  if (has('dry-run')) {
    console.log(JSON.stringify({ ...cfg, ports }, null, 2));
    return;
  }

  log(`scenario: ${cfg.slug}  mode: ${cfg.mode}`);
  if (cfg.mode === 'proof') {
    await modeProof(cfg, ports);
    return;
  }

  // Attach: record against the daemon + web the user is already running, so the
  // task and its artifacts persist in the real DB. Spawns nothing; owns no data dir.
  if (has('attach')) {
    const attach = {
      daemonUrl: (flag('daemon-url') ?? process.env.DRIVE_DAEMON_URL ?? 'http://127.0.0.1:4417')
        .trim()
        .replace(/\/$/, ''),
      webUrl: (flag('web-url') ?? process.env.DRIVE_WEB_URL ?? 'http://localhost:5317')
        .trim()
        .replace(/\/$/, ''),
    };
    await modeAttach(cfg, attach, ports.pace);
    return;
  }

  const dataDir = join(REPO_ROOT, 'data', `${cfg.mode}-${cfg.slug}`);
  mkdirSync(dataDir, { recursive: true });
  log(`daemon :${ports.port}  data ${dataDir}`);
  if (cfg.mode === 'record') await modeRecord(cfg, ports, dataDir);
  else await modeHeadless(cfg, ports, dataDir);
}

main().catch((e) => {
  console.error('[drive] ERROR:', e?.message ?? e);
  process.exitCode = 1;
});

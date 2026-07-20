import {
  AGENT_RUNTIMES,
  type AgentRuntime,
  type DeliveryPolicy,
  type DetectedCommands,
  type Project,
} from '@workbench/core';
import { ChevronRight, Plus, Wand2 } from 'lucide-react';
import { cloneElement, isValidElement, useEffect, useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { usePageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Panel, PanelHeader } from '@/components/ui/panel';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api } from '../api.js';

const EMPTY = {
  name: '',
  description: '',
  repoPath: '',
  defaultBranch: 'main',
  // Defaults to Claude; selectable among the real runtimes. The 'mock' runtime
  // is seed/test-only and intentionally not offered in the UI.
  agentRuntime: 'claude' as AgentRuntime,
  // Flat runtime-config inputs; assembled into `runtimeConfig` at submit. Which
  // ones are shown is driven by RUNTIME_CONFIG_FIELDS[agentRuntime].
  cfgModel: '',
  cfgBinary: '',
  deliveryPolicy: 'merge_to_master' as DeliveryPolicy,
  testCommand: '',
  lintCommand: '',
  typecheckCommand: '',
  e2eCommand: '',
  devCommand: '',
};

/**
 * Per-runtime config inputs surfaced in the create form. Mirrors each runtime
 * profile's `configFields` (kept in the web layer so the browser bundle doesn't
 * import the node-only agents package). `key` maps to a flat `cfg*` form field.
 */
const RUNTIME_CONFIG_FIELDS: Record<
  AgentRuntime,
  { key: 'cfgModel' | 'cfgBinary'; label: string; placeholder: string; required?: boolean }[]
> = {
  mock: [],
  claude: [
    { key: 'cfgModel', label: 'Model (optional)', placeholder: 'opus (default) / sonnet / haiku' },
  ],
  pi: [
    // Optional: the Pi profile has per-stage Ollama defaults (qwen3-coder:30b for
    // build stages, llama3.2 for the heavy review stages). A value here overrides
    // them for every stage.
    {
      key: 'cfgModel',
      label: 'Model (optional — overrides per-stage defaults)',
      placeholder: 'ollama/qwen3-coder:30b',
    },
    { key: 'cfgBinary', label: 'pi binary (optional)', placeholder: 'pi' },
  ],
  codex: [
    { key: 'cfgModel', label: 'Model (optional)', placeholder: 'gpt-5.2-codex (codex default)' },
    { key: 'cfgBinary', label: 'codex binary (optional)', placeholder: 'codex' },
  ],
};

/** Human labels for the delivery policy dropdown / table cell. */
const DELIVERY_POLICY_LABELS: Record<DeliveryPolicy, string> = {
  create_pr: 'Create PR',
  merge_to_master: 'Merge to master',
};

/** Human labels for the agent-runtime dropdown. */
const AGENT_RUNTIME_LABELS: Record<AgentRuntime, string> = {
  mock: 'Mock (test only)',
  claude: 'Claude Code',
  pi: 'Pi Coding Agent',
  codex: 'OpenAI Codex',
};

/**
 * Runtimes offered in the create-project form. 'mock' is seed/test-only and
 * deliberately excluded; everything else (claude, pi, …) is a real runtime.
 */
const SELECTABLE_RUNTIMES: AgentRuntime[] = AGENT_RUNTIMES.filter((r) => r !== 'mock');

/** The build commands we surface, in column order. */
const BUILD_COMMANDS: { key: keyof typeof EMPTY; label: string }[] = [
  { key: 'testCommand', label: 'test' },
  { key: 'lintCommand', label: 'lint' },
  { key: 'typecheckCommand', label: 'typecheck' },
  { key: 'e2eCommand', label: 'e2e' },
  { key: 'devCommand', label: 'dev' },
];

export function Projects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = () =>
    api
      .listProjects()
      .then(setProjects)
      .catch((e) => setError(String(e)));
  useEffect(() => {
    load();
  }, []);

  // Alphabetical by name (case-insensitive), per the registry spec.
  const sorted = useMemo(
    () =>
      [...projects].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      ),
    [projects],
  );

  usePageHeader({
    title: 'Projects',
    action: (
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" />
        New project
      </Button>
    ),
  });

  return (
    <div>
      {error && <div className="mb-3 text-sm text-danger">{error}</div>}

      {sorted.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No projects yet. Use <strong>New project</strong> to add one.
        </p>
      ) : (
        <Panel>
          <PanelHeader
            title="Registry"
            action={
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {sorted.length} {sorted.length === 1 ? 'project' : 'projects'}
              </span>
            }
          />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Project Name</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Repository Path</TableHead>
                <TableHead>Runtime</TableHead>
                <TableHead>Delivery</TableHead>
                <TableHead>Build Commands</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">
                    <Link
                      to={`/?project=${p.id}`}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      {p.name}
                    </Link>
                  </TableCell>
                  <TableCell className="max-w-xs text-xs text-muted-foreground">
                    {p.description?.trim() ? p.description : <span>—</span>}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    <code>{p.repoPath}</code>
                  </TableCell>
                  <TableCell>{AGENT_RUNTIME_LABELS[p.agentRuntime] ?? p.agentRuntime}</TableCell>
                  <TableCell className="text-xs">
                    {DELIVERY_POLICY_LABELS[p.deliveryPolicy] ?? p.deliveryPolicy}
                  </TableCell>
                  <TableCell>
                    <BuildCommandList project={p} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Panel>
      )}

      <ProjectFormDialog
        open={open}
        onOpenChange={setOpen}
        onCreated={async () => {
          setOpen(false);
          await load();
        }}
      />
    </div>
  );
}

/** Inline list of a project's defined build commands; shows "—" when none set. */
function BuildCommandList({ project }: { project: Project }) {
  const defined = BUILD_COMMANDS.filter(({ key }) =>
    (project[key as keyof Project] as string)?.trim(),
  );
  if (defined.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-col gap-0.5 text-xs">
      {defined.map(({ key, label }) => (
        <div key={key}>
          <span className="text-muted-foreground">{label}: </span>
          <code>{project[key as keyof Project] as string}</code>
        </div>
      ))}
    </div>
  );
}

/** Create-project modal. (Edit awaits a daemon PATCH endpoint.) */
function ProjectFormDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({ ...EMPTY });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detectNote, setDetectNote] = useState<string | null>(null);

  // Reset the form each time the dialog opens.
  useEffect(() => {
    if (open) {
      setForm({ ...EMPTY });
      setError(null);
      setCommandsOpen(false);
      setDetectNote(null);
    }
  }, [open]);

  const set =
    (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));

  const setValue = (k: keyof typeof form) => (value: string) =>
    setForm((f) => ({ ...f, [k]: value }));

  // Scan the repo path's package.json and fill in any build commands the user
  // hasn't already typed. Only empty fields are overwritten so a manual entry is
  // never clobbered. Expands the section so the user can see what landed.
  const detect = async () => {
    if (!form.repoPath.trim()) {
      setDetectNote('Enter a repo path first.');
      return;
    }
    setDetecting(true);
    setDetectNote(null);
    try {
      const found = await api.detectCommands(form.repoPath.trim());
      setForm((f) => {
        const next = { ...f };
        let filled = 0;
        for (const { key } of BUILD_COMMANDS) {
          const cmdKey = key as keyof DetectedCommands;
          const value = found[cmdKey];
          if (value && !(f[cmdKey] as string).trim()) {
            next[cmdKey] = value;
            filled++;
          }
        }
        setDetectNote(
          filled > 0
            ? `Filled ${filled} command${filled === 1 ? '' : 's'} from package.json.`
            : 'No commands found in package.json.',
        );
        return next;
      });
      setCommandsOpen(true);
    } catch (err) {
      setDetectNote(String(err));
    } finally {
      setDetecting(false);
    }
  };

  const definedCount = BUILD_COMMANDS.filter(({ key }) => (form[key] as string).trim()).length;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const { cfgModel, cfgBinary, ...rest } = form;
      // Assemble the flat cfg* inputs into runtimeConfig, keeping only fields the
      // selected runtime actually surfaces, and only when non-empty.
      const shownKeys = RUNTIME_CONFIG_FIELDS[form.agentRuntime].map((f) => f.key);
      const runtimeConfig: { model?: string; binary?: string } = {};
      if (shownKeys.includes('cfgModel') && cfgModel.trim()) runtimeConfig.model = cfgModel.trim();
      if (shownKeys.includes('cfgBinary') && cfgBinary.trim())
        runtimeConfig.binary = cfgBinary.trim();
      await api.createProject({ ...rest, runtimeConfig });
      onCreated();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>Register a repo as a workbench project.</DialogDescription>
        </DialogHeader>
        {error && <div className="text-sm text-danger">{error}</div>}
        <form onSubmit={submit} className="space-y-3">
          <Field label="Name *">
            <Input value={form.name} onChange={set('name')} required />
          </Field>
          <Field label="Description">
            <Textarea
              value={form.description}
              onChange={set('description')}
              placeholder="What is this project?"
            />
          </Field>
          <Field label="Repo path *">
            <Input
              value={form.repoPath}
              onChange={set('repoPath')}
              placeholder="/path/to/repo"
              required
            />
          </Field>
          <Field label="Default branch *">
            <Input value={form.defaultBranch} onChange={set('defaultBranch')} required />
          </Field>
          <Field label="Agent runtime">
            <Select value={form.agentRuntime} onValueChange={setValue('agentRuntime')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SELECTABLE_RUNTIMES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {AGENT_RUNTIME_LABELS[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {RUNTIME_CONFIG_FIELDS[form.agentRuntime].map((f) => (
            <Field key={f.key} label={f.label}>
              <Input
                value={form[f.key]}
                onChange={set(f.key)}
                placeholder={f.placeholder}
                required={f.required}
              />
            </Field>
          ))}
          <Field label="Delivery policy">
            <Select value={form.deliveryPolicy} onValueChange={setValue('deliveryPolicy')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="merge_to_master">Merge to master</SelectItem>
                <SelectItem value="create_pr">Create PR</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <div className="rounded-md border border-border">
            <div className="flex items-center justify-between gap-2 px-3 py-2">
              <button
                type="button"
                onClick={() => setCommandsOpen((o) => !o)}
                aria-expanded={commandsOpen}
                className="flex items-center gap-1.5 text-sm font-medium"
              >
                <ChevronRight
                  className={`h-4 w-4 text-muted-foreground transition-transform ${
                    commandsOpen ? 'rotate-90' : ''
                  }`}
                />
                Build commands
                <span className="text-xs font-normal text-muted-foreground">
                  {definedCount > 0 ? `(${definedCount} set)` : '(optional)'}
                </span>
              </button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={detect}
                disabled={detecting}
              >
                <Wand2 className="h-3.5 w-3.5" />
                {detecting ? 'Detecting…' : 'Auto-detect'}
              </Button>
            </div>
            {detectNote && <p className="px-3 pb-2 text-xs text-muted-foreground">{detectNote}</p>}
            {commandsOpen && (
              <div className="space-y-3 border-t border-border px-3 py-3">
                <Field label="Test command">
                  <Input
                    value={form.testCommand}
                    onChange={set('testCommand')}
                    placeholder="npm test"
                  />
                </Field>
                <Field label="Lint command">
                  <Input value={form.lintCommand} onChange={set('lintCommand')} />
                </Field>
                <Field label="Typecheck command">
                  <Input value={form.typecheckCommand} onChange={set('typecheckCommand')} />
                </Field>
                <Field label="E2E command">
                  <Input value={form.e2eCommand} onChange={set('e2eCommand')} />
                </Field>
                <Field label="Dev command">
                  <Input value={form.devCommand} onChange={set('devCommand')} />
                </Field>
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={saving}>{saving ? 'Saving…' : 'Create project'}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Label + control, with the label associated to the control via a generated id
 * so the field is reachable by its accessible name (getByLabelText / a11y).
 */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const id = useId();
  const control = isValidElement(children)
    ? cloneElement(children as React.ReactElement, { id })
    : children;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {control}
    </div>
  );
}

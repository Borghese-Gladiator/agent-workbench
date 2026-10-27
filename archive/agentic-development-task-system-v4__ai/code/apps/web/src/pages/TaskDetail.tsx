import {
  ARTIFACT_KIND_LABELS,
  ARTIFACT_KIND_STAGE,
  type Artifact,
  type ArtifactKind,
  agentRunDurationMs,
  formatDuration,
  STAGE_LABELS,
  STAGES,
  type Stage,
  type StageRun,
  stageGroupLabel,
  stageIndex,
  stageNeedsHumanApproval,
  stageRunDurationMs,
  taskElapsedMs,
} from '@workbench/core';
import { Ban, ChevronRight, PanelLeftClose, PanelLeftOpen, Square, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Decoration,
  Diff,
  type FileData,
  Hunk,
  markEdits,
  parseDiff,
  tokenize,
  type ViewType,
} from 'react-diff-view';
import 'react-diff-view/style/index.css';
import { useNavigate, useParams } from 'react-router-dom';
import { MarkdownEditor } from '@/components/MarkdownEditor';
import { usePageHeader } from '@/components/PageHeader';
import { QuestionCard } from '@/components/QuestionCard';
import { RunTerminal } from '@/components/RunTerminal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/panel';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { type CostSummary, costSegments, hasCostData, sumRunCost } from '@/lib/cost';
import { cn } from '@/lib/utils';
import {
  type AgentQuestion,
  type AgentQuestionAnswer,
  type AgentRun,
  api,
  type DemoAsset,
  type GitStatus,
  type TaskDetail,
} from '../api.js';
import { actionsForStage, type StageAction } from '../stage-actions.js';

/** The single primary artifact kind a stage produces (inverse of ARTIFACT_KIND_STAGE). */
const STAGE_PRIMARY_KIND: Partial<Record<Stage, ArtifactKind>> = Object.fromEntries(
  Object.entries(ARTIFACT_KIND_STAGE).map(([kind, stage]) => [stage, kind as ArtifactKind]),
) as Partial<Record<Stage, ArtifactKind>>;

/** Artifact kinds a human can edit in place (agent-written prose). */
const EDITABLE_KINDS = new Set<ArtifactKind>(['task_brief', 'execution_plan']);

/**
 * Gates where the human is reviewing the worktree's code changes (post-QA), so
 * the full diff is worth showing. The brief/plan gates precede any code, so they
 * get no diff panel.
 */
const WORKTREE_REVIEW_STAGES = new Set<Stage>(['human_review', 'human_delivery_approval']);

/** Rail icon for each QA proof-asset kind. */
const ASSET_ICON: Record<DemoAsset['kind'], string> = {
  video: '🎬',
  image: '🖼️',
  trace: '🧪',
  other: '📎',
};

/** Persisted lifecycle-rail collapse state (sticks across reloads). */
const LIFECYCLE_COLLAPSE_KEY = 'workbench:lifecycle-collapsed';
function useLifecycleCollapsed(): [boolean, (v: boolean) => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(LIFECYCLE_COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const set = useCallback((v: boolean) => {
    setCollapsed(v);
    try {
      localStorage.setItem(LIFECYCLE_COLLAPSE_KEY, v ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  }, []);
  return [collapsed, set];
}

export function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedStage, setSelectedStage] = useState<string | null>(null);
  // Whether the user MANUALLY pinned a stage in the rail. The follow-along
  // auto-open also sets `selectedStage` (to title the center viewer), but that
  // must NOT count as a pin — only a manual rail click should hide the live
  // panel / freeze the auto-open jump.
  const [manuallyPinned, setManuallyPinned] = useState(false);
  // The artifact currently shown dead-center (selected from a stage or the list).
  const [centerArtifact, setCenterArtifact] = useState<(Artifact & { body: string }) | null>(null);
  // The QA proof assets (videos/screenshots/traces) captured for this task, and the
  // one (if any) currently shown dead-center. Mutually exclusive with centerArtifact.
  const [assets, setAssets] = useState<DemoAsset[]>([]);
  const [centerAsset, setCenterAsset] = useState<DemoAsset | null>(null);
  const [reviewComment, setReviewComment] = useState('');
  // The worktree diff shown on the post-QA review gates, fetched lazily when the
  // task parks at one. `null` while not loaded / not applicable.
  const [worktreeDiff, setWorktreeDiff] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [activeRun, setActiveRun] = useState<{ id: string; stage: string } | null>(null);
  // The newest run on this task regardless of status. When no run is in flight
  // the terminal stays pinned to this (replaying its transcript) so the live
  // stream — not the structured artifact — remains the primary, persistent view.
  const [latestRun, setLatestRun] = useState<AgentRun | null>(null);
  // Whether the collapsed transcript of a finished run is expanded. Defaults
  // closed so the produced artifact stays the primary content; resets per run.
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  // A run we already saw terminate: an in-flight poll response may still carry
  // it, and re-mounting a finished run would flicker the terminal.
  const lastTerminalRunIdRef = useRef<string | null>(null);
  // Set when a LIVE run just ended, so the next auto-opened artifact scrolls into
  // view and briefly flashes — making the produced markdown the obvious result
  // rather than leaving the user staring at the (now-collapsed) transcript.
  const runJustFinishedRef = useRef(false);
  const centerWrapRef = useRef<HTMLDivElement | null>(null);
  const [highlightArtifact, setHighlightArtifact] = useState(false);
  const [questions, setQuestions] = useState<AgentQuestion[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmAbandon, setConfirmAbandon] = useState(false);
  const [confirmSkipWorktree, setConfirmSkipWorktree] = useState(false);
  // Human's opt-out of the feature E2E stage, chosen at the plan-approval gate.
  const [skipE2e, setSkipE2e] = useState(false);
  // Live cost/turns/tokens from the active run's `cost` events (drives the header).
  const [runCost, setRunCost] = useState<CostSummary | null>(null);
  // Collapse the lifecycle rail to a thin dot strip (persisted across reloads).
  const [lifecycleCollapsed, setLifecycleCollapsed] = useLifecycleCollapsed();
  // The live agent terminal is a default-open disclosure so it can be folded
  // away to make the produced artifact the primary content.
  const [liveTermOpen, setLiveTermOpen] = useState(true);
  // A coarse clock that advances while the task is active, so the task-elapsed
  // and in-progress-stage durations keep ticking up without a data refetch.
  const [now, setNow] = useState(() => Date.now());

  // Task Detail owns its own header → suppress the contextual top bar.
  usePageHeader(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [d, q, { runs }, { assets: a }] = await Promise.all([
        api.getTask(id),
        api.unansweredQuestions(id),
        api.listRuns(id),
        api.listAssets(id),
      ]);
      setDetail(d);
      setQuestions(q);
      setAssets(a);
      // Newest run (list is oldest-first) — pins the terminal when nothing's live.
      setLatestRun(runs.length ? runs[runs.length - 1]! : null);
    } catch (e) {
      setError(String(e));
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll for the daemon's active run while the task is live. When one appears
  // (or the next stage's run replaces it during auto-advance), the terminal
  // attaches to its SSE stream — the server replays history, so attaching
  // mid-run loses nothing. A null poll never clears the terminal; it clears
  // itself on its terminal event (guaranteed by the daemon).
  const taskStatus = detail?.task.status;
  useEffect(() => {
    if (!id || taskStatus !== 'active') return;
    let cancelled = false;
    const tick = async () => {
      try {
        const { run } = await api.getActiveRun(id);
        if (cancelled || !run) return;
        if (run.id === lastTerminalRunIdRef.current) return; // stale in-flight poll
        setActiveRun((prev) => (prev?.id === run.id ? prev : { id: run.id, stage: run.stage }));
      } catch {
        /* daemon hiccup — the next tick retries */
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id, taskStatus]);

  // Fetch the full worktree diff when the task parks at a post-QA review gate
  // with a live worktree, so the reviewer can see the actual code changes. Keyed
  // on stage + worktree id so it refetches after a bounce-and-rerun or a fresh
  // worktree. Cleared whenever the gate/worktree no longer applies.
  const taskStage = detail?.task.stage;
  const worktreeId = detail?.worktree?.id ?? null;
  const worktreeActive =
    detail?.worktree &&
    detail.worktree.status !== 'abandoned' &&
    detail.worktree.status !== 'removed';
  const showWorktreeReview =
    !!id &&
    !!taskStage &&
    WORKTREE_REVIEW_STAGES.has(taskStage as Stage) &&
    taskStatus === 'active' &&
    !!worktreeActive;
  // taskStage + worktreeId aren't read in the body; they're deps on purpose so
  // the diff refetches after a bounce-and-rerun (same gate, fresh worktree).
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional refetch keys
  useEffect(() => {
    if (!showWorktreeReview || !id) {
      setWorktreeDiff(null);
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    api
      .worktreeDiff(id)
      .then(({ diff }) => {
        if (!cancelled) setWorktreeDiff(diff);
      })
      .catch(() => {
        if (!cancelled) setWorktreeDiff(null);
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, showWorktreeReview, taskStage, worktreeId]);

  // Live-refresh the lifecycle (stage / status / artifacts / gate) over SSE.
  // The daemon emits a `changed` notification on every transition and new
  // artifact; we just refetch the canonical bundle — the event carries no
  // payload, so duplicate or out-of-order events are harmless. This is what
  // makes a stage advance, a produced artifact, or a gate-park appear WITHOUT a
  // manual reload. The 2s `tick` poll above remains a reconciling fallback if an
  // event is ever dropped. Kept open regardless of status so a final park still
  // refreshes. Debounced so a burst of writes coalesces into one fetch.
  useEffect(() => {
    if (!id) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const es = new EventSource(api.taskEventsUrl(id));
    const onChanged = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 150);
    };
    es.addEventListener('changed', onChanged);
    return () => {
      if (timer) clearTimeout(timer);
      es.removeEventListener('changed', onChanged);
      es.close();
    };
  }, [id, load]);

  // Tick the elapsed clock once a second while the task is active so live
  // durations advance. Terminal tasks have a fixed elapsed, so we stop ticking.
  useEffect(() => {
    if (taskStatus !== 'active') return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [taskStatus]);

  // A new run gets a fresh cost counter.
  const activeRunId = activeRun?.id ?? null;
  useEffect(() => setRunCost(null), [activeRunId]);

  const toggleLifecycle = () => setLifecycleCollapsed(!lifecycleCollapsed);

  // Collapse the transcript whenever the displayed run changes — each finished
  // stage starts with its artifact primary and the transcript tucked away.
  const displayRunId = activeRun?.id ?? latestRun?.id ?? null;
  useEffect(() => setTranscriptOpen(false), [displayRunId]);

  // Wall-clock of the session whose transcript is on screen, looked up from the
  // persisted agentRuns by the displayed run id. A still-running session ticks
  // against `now`; a finished one is fixed. Null when the run isn't persisted
  // yet (the very first poll can precede its agentRuns row).
  const displayRunDuration = useMemo(() => {
    if (!displayRunId) return null;
    const run = detail?.agentRuns.find((r) => r.id === displayRunId);
    if (!run) return null;
    const ms = agentRunDurationMs(run, now);
    return ms == null ? null : formatDuration(ms);
  }, [detail, displayRunId, now]);

  // What the terminal renders: the in-flight run if there is one, else the
  // newest finished run (replayed read-only). This keeps the streamed transcript
  // on screen after completion and across reloads.
  const displayRun: { id: string; stage: string; live: boolean } | null = activeRun
    ? { id: activeRun.id, stage: activeRun.stage, live: true }
    : latestRun
      ? { id: latestRun.id, stage: latestRun.stage, live: false }
      : null;

  // The stage of the in-flight run (≡ the current active stage while it streams).
  const liveStage = displayRun?.live ? displayRun.stage : null;
  // The user is "viewing current" when they haven't pinned a past stage (default
  // follow-along) OR the stage they pinned IS the live one. When they've pinned a
  // DIFFERENT stage we hide the live panel and freeze the auto-open jump, so a
  // stage advance never yanks them off the older stage they're inspecting.
  const pinnedToPastStage = manuallyPinned && selectedStage != null && selectedStage !== liveStage;
  const viewingCurrent = !pinnedToPastStage;

  // Persisted cost of the most-recent finished run, so the header shows
  // cost/turns/tokens when no run is actively streaming (reload / after a run).
  const latestRunCost = useMemo<CostSummary | null>(() => {
    const runs = detail?.agentRuns ?? [];
    for (let i = runs.length - 1; i >= 0; i--) {
      const r = runs[i];
      if (r && hasCostData(r)) return r;
    }
    return null;
  }, [detail]);

  // Whole-task roll-up: sum of every run's cost/turns/tokens. Shown in the
  // header so one glance = total task spend.
  const taskTotalCost = useMemo<CostSummary | null>(() => {
    const runs = detail?.agentRuns ?? [];
    const summed = sumRunCost(runs);
    return hasCostData(summed) ? summed : null;
  }, [detail]);

  // Cost of the SELECTED stage: summed across all its runs (a stage can run
  // more than once — rejection / review bounce each spawn a fresh AgentRun).
  // Null when no run for that stage carried cost data.
  const costForStage = useMemo<CostSummary | null>(() => {
    if (!selectedStage) return null;
    const runs = (detail?.agentRuns ?? []).filter((r) => r.stage === selectedStage);
    if (runs.length === 0) return null;
    const summed = sumRunCost(runs);
    return hasCostData(summed) ? summed : null;
  }, [detail, selectedStage]);

  // How many runs the selected stage had (drives the "N runs" prefix).
  const selectedStageRunCount = useMemo(() => {
    if (!selectedStage) return 0;
    return (detail?.agentRuns ?? []).filter((r) => r.stage === selectedStage).length;
  }, [detail, selectedStage]);

  // The latest brief / plan artifact (auto-opened when the stage advances).
  const briefMeta = useMemo(() => latestOfKind(detail, 'task_brief'), [detail]);
  const planMeta = useMemo(() => latestOfKind(detail, 'execution_plan'), [detail]);

  // Each artifact attributed to the stage that produced it (StageRun-faithful),
  // so the left rail can nest artifacts under the right stage even after reruns.
  const artifactsByStage = useMemo(() => groupArtifactsByStage(detail), [detail]);

  // Total wall-clock spent in each stage, summed across re-entries (a bounce
  // adds a second StageRun for the same stage). An in-progress run measures to
  // `now`, so the current stage's figure ticks up live.
  const durationByStage = useMemo(
    () => stageDurations(detail?.stageRuns ?? [], now),
    [detail, now],
  );

  // Group consecutive stages that share a rail group label (e.g. static_checks +
  // feature_e2e -> one "Verification" node). A group of one renders exactly like
  // a plain stage; a multi-stage group renders as an expandable node with each
  // stage as a sub-step.
  const railGroups = useMemo(() => {
    const groups: { label: string; stages: Stage[] }[] = [];
    for (const stage of STAGES) {
      const label = stageGroupLabel(stage);
      const last = groups.at(-1);
      if (last && last.label === label) last.stages.push(stage);
      else groups.push({ label, stages: [stage] });
    }
    return groups;
  }, []);

  // Per-kind version numbers (V1, V2, …) for artifacts that have siblings of the
  // same kind — e.g. a rejected-then-regenerated brief. Lets the rail and the
  // center header disambiguate "Task Brief V1" from "V2".
  const artifactVersions = useMemo(() => artifactVersionMap(detail?.artifacts ?? []), [detail]);

  // When a run has finished, its produced artifact is the primary content (the
  // transcript collapses below it). Auto-open that artifact so the human sees
  // the result, not an empty center. Brief/plan still take precedence.
  const finishedStage = displayRun && !displayRun.live ? displayRun.stage : null;
  const finishedRunArtifact = useMemo(() => {
    if (!finishedStage) return null;
    const kind = STAGE_PRIMARY_KIND[finishedStage as Stage];
    return kind ? latestOfKind(detail, kind) : null;
  }, [detail, finishedStage]);

  // Auto-open the freshest produced artifact in the center when one appears or
  // changes (brief/plan first, else the finished run's artifact). Keyed by id so
  // a regenerate or a new stage's artifact re-opens.
  const autoOpenId = planMeta?.id ?? briefMeta?.id ?? finishedRunArtifact?.id ?? null;
  // Mirror the "pinned to a past stage" flag into a ref so the auto-open effect can
  // read it WITHOUT re-running when the pin toggles — we only want it to skip the
  // forced jump, not re-fire on selection changes.
  const pinnedToPastStageRef = useRef(pinnedToPastStage);
  pinnedToPastStageRef.current = pinnedToPastStage;
  useEffect(() => {
    if (!autoOpenId) return;
    // Parked on an older stage: a new artifact / stage advance must NOT move the
    // view. The agent keeps running; the rail updates; the center stays put.
    if (pinnedToPastStageRef.current) return;
    let cancelled = false;
    api
      .getArtifact(autoOpenId)
      .then((a) => {
        if (!cancelled) {
          setCenterArtifact(a);
          setSelectedStage(ARTIFACT_KIND_STAGE[a.kind] ?? null);
          // If a live run just finished, draw the eye to the freshly produced
          // artifact: scroll it into view and flash a highlight that fades.
          if (runJustFinishedRef.current) {
            runJustFinishedRef.current = false;
            setHighlightArtifact(true);
            requestAnimationFrame(() => {
              centerWrapRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
            window.setTimeout(() => setHighlightArtifact(false), 1600);
          }
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [autoOpenId]);

  const runAction = async (action: StageAction) => {
    if (!id) return;
    setError(null);
    // Reject actions require a reason (brief + plan gates).
    if (action.requiresComment && !reviewComment.trim()) {
      setError('A reason is required to reject.');
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = {};
      const comment = reviewComment.trim();
      if (comment) body.comment = comment;
      if (action.bounceTarget) body.target = action.bounceTarget;
      // The plan-approval gate carries the optional E2E-skip choice.
      if (action.endpoint === 'approve-plan') body.skipE2e = skipE2e;
      await api.action(id, action.endpoint, body);
      setReviewComment('');
      await load();
    } catch (e) {
      setError(String(e));
      await load();
    } finally {
      setBusy(false);
    }
  };

  // Open an artifact dead-center (from the right-hand list or a stage click).
  // Both callers are explicit user actions, so this counts as a manual pin (the
  // follow-along auto-open sets the center state inline, not via this path).
  const viewArtifact = async (artifactId: string) => {
    try {
      const a = await api.getArtifact(artifactId);
      setCenterAsset(null);
      setCenterArtifact(a);
      setSelectedStage(ARTIFACT_KIND_STAGE[a.kind] ?? null);
      setManuallyPinned(true);
    } catch (e) {
      setError(String(e));
    }
  };

  // Open a QA proof asset (video/screenshot/trace) dead-center, pinned to the
  // feature_e2e stage that produced it. Mirrors viewArtifact's manual-pin path.
  const viewAsset = (asset: DemoAsset) => {
    setCenterArtifact(null);
    setCenterAsset(asset);
    setSelectedStage('feature_e2e');
    setManuallyPinned(true);
  };

  // Persist an edited brief/plan body, then refresh the center copy.
  const saveArtifact = async (artifactId: string, body: string) => {
    setError(null);
    setBusy(true);
    try {
      const updated = await api.updateArtifact(artifactId, body);
      setCenterArtifact(updated);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // Select a lifecycle stage → show its input dead-center (intake = raw prompt).
  const selectStage = async (stage: Stage) => {
    if (selectedStage === stage) {
      setSelectedStage(null);
      setManuallyPinned(false);
      setCenterArtifact(null);
      setCenterAsset(null);
      return;
    }
    setCenterAsset(null);
    setSelectedStage(stage);
    // A rail click is an explicit pin: if it lands on a past stage it hides the
    // live panel; landing on the live stage leaves `pinnedToPastStage` false.
    setManuallyPinned(true);
    if (stage === 'intake') {
      setCenterArtifact(null); // raw prompt is rendered directly (no artifact id)
      return;
    }
    const kind = STAGE_PRIMARY_KIND[stage];
    const art = kind ? latestOfKind(detail, kind) : null;
    if (art) await viewArtifact(art.id);
    else setCenterArtifact(null);
  };

  // The artifacts + QA assets a single stage produced, as a nested <ul>. Shared
  // by singleton rail rows and the sub-steps of a grouped rail node.
  const renderStageArtifacts = (stage: Stage) => {
    const stageArtifacts = artifactsByStage.get(stage) ?? [];
    const stageAssets = stage === 'feature_e2e' ? assets : [];
    if (stageArtifacts.length === 0 && stageAssets.length === 0) return null;
    return (
      <ul className="mt-2 space-y-1.5">
        {stageArtifacts.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              onClick={() => viewArtifact(a.id)}
              className={cn(
                'w-full rounded-md border bg-secondary px-2.5 py-1.5 text-left text-xs transition-colors hover:border-primary',
                centerArtifact?.id === a.id && 'border-primary',
              )}
            >
              📄 {ARTIFACT_KIND_LABELS[a.kind]}
              {artifactVersions.has(a.id) && (
                <span className="ml-1.5 text-muted-foreground">
                  V{artifactVersions.get(a.id)}
                </span>
              )}
            </button>
          </li>
        ))}
        {/* QA proof: each captured video/screenshot/trace opens in the center
            panel (videos play, images render inline). */}
        {stageAssets.map((asset) => (
          <li key={asset.name}>
            <button
              type="button"
              onClick={() => viewAsset(asset)}
              className={cn(
                'w-full truncate rounded-md border bg-secondary px-2.5 py-1.5 text-left text-xs transition-colors hover:border-primary',
                centerAsset?.name === asset.name && 'border-primary',
              )}
              title={asset.name}
            >
              {ASSET_ICON[asset.kind]} {asset.name}
            </button>
          </li>
        ))}
      </ul>
    );
  };

  // One sub-step row inside a grouped rail node (e.g. "Static Checks" /
  // "Project E2E" under "Verification"): the stage's precise label + its nested
  // artifacts. Clicking the label selects that stage (drives the center panel).
  const renderStageSubStep = (stage: Stage) => (
    <div key={stage} className="mt-2 pl-3">
      <button
        type="button"
        onClick={() => selectStage(stage)}
        className={cn(
          'text-left text-xs font-medium hover:underline',
          selectedStage === stage ? 'text-primary' : 'text-muted-foreground',
        )}
      >
        {STAGE_LABELS[stage]}
        {durationByStage.has(stage) && (
          <span className="ml-1.5 tabular-nums text-muted-foreground">
            {formatDuration(durationByStage.get(stage)!)}
          </span>
        )}
      </button>
      {renderStageArtifacts(stage)}
    </div>
  );

  // Return to the live (current) stage: clear the pin so the follow-along
  // auto-open re-populates the center with the current stage's artifact and the
  // live streaming panel re-appears.
  const jumpToCurrent = () => {
    setSelectedStage(null);
    setManuallyPinned(false);
    setCenterArtifact(null);
    setCenterAsset(null);
  };

  const deleteTask = async () => {
    if (!id) return;
    setBusy(true);
    try {
      await api.deleteTask(id);
      navigate('/');
    } catch (e) {
      setError(String(e));
      setBusy(false);
      setConfirmDelete(false);
    }
  };

  // Stop the in-flight agent session — kills the spawned CLI and flips the run
  // to failed. The task stays put (its stage/status are unchanged); the operator
  // can then resume, abandon, or take a gate action.
  const stopSession = async () => {
    if (!id || !activeRun) return;
    setError(null);
    setBusy(true);
    try {
      await api.stopRun(id, activeRun.id);
      await load();
    } catch (e) {
      setError(String(e));
      await load();
    } finally {
      setBusy(false);
    }
  };

  // Abandon the task — terminal (abandoned) status from any stage. Stops any
  // live session server-side first.
  const abandonTask = async () => {
    if (!id) return;
    setConfirmAbandon(false);
    setError(null);
    setBusy(true);
    try {
      await api.action(id, 'abandon', {});
      await load();
    } catch (e) {
      setError(String(e));
      await load();
    } finally {
      setBusy(false);
    }
  };

  /** Approve the brief and skip worktree creation (commit directly to main). */
  const approveBriefDirect = async () => {
    if (!id) return;
    setConfirmSkipWorktree(false);
    setError(null);
    setBusy(true);
    try {
      await api.action(id, 'approve-brief', { skipWorktree: true });
      await load();
    } catch (e) {
      setError(String(e));
      await load();
    } finally {
      setBusy(false);
    }
  };

  /** Answer a mid-run question; the paused run resumes server-side. */
  const answerQuestion = async (questionId: string, answer: AgentQuestionAnswer) => {
    if (!id) return;
    setError(null);
    try {
      await api.answerQuestion(id, questionId, answer);
      await load();
    } catch (e) {
      setError(String(e));
    }
  };

  if (error && !detail) return <div className="text-sm text-danger">{error}</div>;
  if (!detail) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const { task, project, worktree, delivery, selfTargeting } = detail;
  const elapsedMs = taskElapsedMs(task, now);
  const currentIdx = stageIndex(task.stage);
  const actions = actionsForStage(task.stage, task.status);
  const hasWorktree = worktree && worktree.status !== 'abandoned' && worktree.status !== 'removed';
  const atGate = stageNeedsHumanApproval(task.stage) && task.status === 'active';
  const terminal = task.status === 'done' || task.status === 'abandoned';
  const hasOpenQuestions = questions.length > 0;
  // A stage/artifact is being inspected dead-center (intake shows raw prompt).
  const inspecting = !!centerArtifact || !!centerAsset || selectedStage === 'intake';

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col">
      {/* Header: title + a single compact meta line. Everything secondary
          (status as a dot, stage, id, cost) lives on one row; destructive and
          rare actions are tucked into the overflow menu. */}
      <header className="flex items-start justify-between gap-3 border-b px-6 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold">{task.title}</h2>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span
              role="img"
              className={cn('h-2 w-2 shrink-0 rounded-full', statusDotClass(task.status))}
              title={task.status}
              aria-label={task.status}
            />
            {project?.name && <span className="font-medium text-foreground">{project.name}</span>}
            <span aria-hidden>·</span>
            <span>{STAGE_LABELS[task.stage]}</span>
            <span aria-hidden>·</span>
            <code className="text-[11px]">{task.id}</code>
            <span aria-hidden>·</span>
            <InlineCost running={!!activeRunId} cost={runCost ?? latestRunCost} />
            {taskTotalCost && (
              <>
                <span aria-hidden>·</span>
                <span title="Total cost across every agent run in this task">
                  task · {costSegments(taskTotalCost).join(' · ')}
                </span>
              </>
            )}
            {elapsedMs != null && (
              <>
                <span aria-hidden>·</span>
                <span
                  className="tabular-nums"
                  title={
                    task.status === 'active'
                      ? 'Time since the task was created'
                      : 'Total time the task was active'
                  }
                >
                  {formatDuration(elapsedMs)}
                </span>
              </>
            )}
            {atGate && (
              <Badge variant="approval" className="ml-1">
                needs approval
              </Badge>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* Stop the live agent session — only while a run is in flight. */}
          {activeRun && (
            <Button
              variant="outline"
              size="sm"
              aria-label="Stop agent session"
              title="Stop agent session"
              disabled={busy}
              onClick={stopSession}
            >
              <Square className="h-3.5 w-3.5" />
              Stop session
            </Button>
          )}
          {/* Abandon the task outright (any non-terminal stage). */}
          {!terminal && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-destructive"
              aria-label="Abandon task"
              title="Abandon task"
              disabled={busy}
              onClick={() => setConfirmAbandon(true)}
            >
              <Ban className="h-4 w-4" />
              Abandon
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            aria-label="Delete task"
            title="Delete task"
            disabled={busy}
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </header>

      {error && <div className="border-b px-6 py-2 text-sm text-danger">{error}</div>}

      <div className="flex flex-1 overflow-hidden">
        {/* Collapsed lifecycle: a thin fixed-width dot strip, rendered OUTSIDE
            the resizable group (the imperative collapse API is unreliable under
            jsdom and adds no value over a plain swap). */}
        {lifecycleCollapsed && (
          <div className="w-12 shrink-0 border-r">
            <LifecycleDotStrip
              stages={STAGES}
              currentIdx={currentIdx}
              taskStatus={task.status}
              selectedStage={selectedStage}
              onExpandSelect={(stage) => {
                setLifecycleCollapsed(false);
                void selectStage(stage);
              }}
              onToggle={toggleLifecycle}
            />
          </div>
        )}

        <ResizablePanelGroup direction="horizontal" className="flex-1">
          {/* Expanded left rail — lifecycle timeline with artifacts nested under
              each stage. When collapsed, this panel is omitted entirely and the
              dot strip above takes its place. */}
          {!lifecycleCollapsed && (
            <ResizablePanel defaultSize={28} minSize={18}>
              <div className="flex h-full flex-col overflow-y-auto px-4 py-4">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Lifecycle
                  </span>
                  <button
                    type="button"
                    onClick={toggleLifecycle}
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    title="Collapse lifecycle"
                    aria-label="Collapse lifecycle"
                  >
                    <PanelLeftClose className="h-4 w-4" />
                  </button>
                </div>
                <ul>
                  {railGroups.map((group) => {
                    // A group of one renders exactly like a plain stage. A
                    // multi-stage group (e.g. "Verification" = Static Checks +
                    // Project E2E) renders an expandable header whose children are
                    // its stage sub-steps, each with its own nested artifacts.
                    const groupStages = group.stages;
                    // Groups always have >= 1 stage by construction (railGroups).
                    const primaryStage = groupStages[0]!;
                    const indices = groupStages.map((s) => stageIndex(s));
                    const firstIdx = Math.min(...indices);
                    const lastIdx = Math.max(...indices);
                    const state =
                      lastIdx < currentIdx || task.status === 'done'
                        ? 'completed'
                        : firstIdx <= currentIdx && currentIdx <= lastIdx
                          ? 'current'
                          : 'pending';
                    const groupArtifacts = groupStages.flatMap(
                      (s) => artifactsByStage.get(s) ?? [],
                    );
                    // QA proof assets belong to the feature_e2e stage that captured them.
                    const groupAssets = groupStages.includes('feature_e2e') ? assets : [];
                    const childCount = groupArtifacts.length + groupAssets.length;
                    const isMulti = groupStages.length > 1;
                    // Selected when the group's own label is selected, or (for a
                    // multi-group) any of its sub-step stages is selected.
                    const selected = isMulti
                      ? groupStages.some((s) => selectedStage === s) ||
                        selectedStage === group.label
                      : selectedStage === primaryStage;
                    const expandable = isMulti || childCount > 0;
                    const expanded = selected && expandable;
                    // Clicking a multi-group selects its FIRST stage (so the center
                    // panel + duration resolve to a concrete stage); a singleton
                    // selects its stage as before.
                    const onSelect = () => selectStage(primaryStage);
                    const groupDuration = groupStages.reduce(
                      (sum, s) => sum + (durationByStage.get(s) ?? 0),
                      0,
                    );
                    return (
                      <li key={group.label} className="relative border-l-2 pb-3 pl-4">
                        <span
                          className={cn(
                            'absolute -left-[6px] top-1 h-2.5 w-2.5 rounded-full bg-border',
                            state === 'current' && 'bg-primary',
                            state === 'completed' && 'bg-ok',
                          )}
                        />
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={onSelect}
                            className={cn(
                              'flex items-center gap-1.5 text-left text-sm hover:underline',
                              state === 'current' && 'font-semibold',
                              selected && 'text-primary',
                            )}
                          >
                            {expandable && (
                              <ChevronRight
                                className={cn(
                                  'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                                  expanded && 'rotate-90',
                                )}
                              />
                            )}
                            <span>{group.label}</span>
                          </button>
                          {childCount > 0 && (
                            <span className="rounded-full bg-muted px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                              {childCount}
                            </span>
                          )}
                          {state === 'current' && (
                            <Badge variant="active" className="ml-0.5">
                              current
                            </Badge>
                          )}
                          {groupDuration > 0 && (
                            <span
                              className="ml-auto shrink-0 pl-1 text-[10px] tabular-nums text-muted-foreground"
                              title={
                                state === 'current'
                                  ? 'Time in this stage so far'
                                  : 'Time spent in this stage'
                              }
                            >
                              {formatDuration(groupDuration)}
                            </span>
                          )}
                        </div>
                        {/* Expanded: a multi-group shows each stage as a sub-step
                            (with its own artifacts nested); a singleton shows its
                            artifacts directly. */}
                        {expanded &&
                          (isMulti
                            ? groupStages.map((s) => renderStageSubStep(s))
                            : renderStageArtifacts(primaryStage))}
                      </li>
                    );
                  })}
                </ul>

                {hasWorktree && (
                  <div className="mt-auto border-t pt-3">
                    <WorktreeInfo taskId={id!} worktree={worktree!} onError={setError} />
                  </div>
                )}
              </div>
            </ResizablePanel>
          )}

          {!lifecycleCollapsed && <ResizableHandle withHandle />}

          {/* Center — state-driven primary content (fills the remaining width). */}
          <ResizablePanel defaultSize={72} minSize={40}>
            <div className="flex h-full flex-col">
              <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
                {/* Per-stage cost: what the selected stage cost (summed across
                  its runs). Sits at the top so clicking a stage answers "how
                  much did this cost?" immediately. */}
                {selectedStage && costForStage && (
                  <StageCostBar
                    stageLabel={STAGE_LABELS[selectedStage as Stage] ?? selectedStage}
                    runCount={selectedStageRunCount}
                    cost={costForStage}
                  />
                )}
                {/* Live agent run — the read-only terminal streams events over SSE
                  while a run is in flight. The server replays persisted events on
                  attach, so attaching mid-run (or after a reload) loses nothing.
                  Questions pause a live run; a live `result`/`error` re-pins it as
                  finished via onTerminal. */}
                {displayRun && id && displayRun.live && viewingCurrent && (
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950/40">
                    <button
                      type="button"
                      onClick={() => setLiveTermOpen((o) => !o)}
                      aria-expanded={liveTermOpen}
                      className="flex w-full cursor-pointer select-none items-center gap-1 px-3 py-2 text-left font-mono text-xs text-zinc-400 hover:text-zinc-200"
                    >
                      <span>{liveTermOpen ? '▾' : '▸'}</span>
                      agent · {STAGE_LABELS[displayRun.stage as Stage] ?? displayRun.stage} ·
                      streaming
                      {displayRunDuration && (
                        <span className="tabular-nums text-zinc-500">· {displayRunDuration}</span>
                      )}
                    </button>
                    {/* Kept mounted while collapsed (hidden via CSS) so the SSE
                      stream and cost events keep flowing — folding is purely a
                      view choice, never a detach. */}
                    <div className={cn('px-2 pb-2', !liveTermOpen && 'hidden')}>
                      <RunTerminal
                        key={displayRun.id}
                        taskId={id}
                        runId={displayRun.id}
                        stage={STAGE_LABELS[displayRun.stage as Stage] ?? displayRun.stage}
                        live
                        onCost={setRunCost}
                        onQuestion={load}
                        onTerminal={() => {
                          lastTerminalRunIdRef.current = displayRun.id;
                          // A live run just finished: cue the artifact scroll/flash once
                          // its produced artifact auto-opens after the reload below.
                          runJustFinishedRef.current = true;
                          setActiveRun(null);
                          load();
                        }}
                      />
                    </div>
                  </div>
                )}

                {/* Parked on a past stage while a run streams: the live panel is
                  hidden so the agent's advance never yanks the view. Offer an
                  explicit way back to the live (current) stage. */}
                {liveStage && !viewingCurrent && (
                  <div className="flex items-center justify-between gap-3 rounded-lg border border-primary/40 bg-primary/5 px-4 py-3">
                    <span className="text-sm text-muted-foreground">
                      A run is live on{' '}
                      <span className="font-medium text-foreground">
                        {STAGE_LABELS[liveStage as Stage] ?? liveStage}
                      </span>
                      .
                    </span>
                    <Button size="sm" onClick={jumpToCurrent}>
                      Jump to current stage
                    </Button>
                  </div>
                )}

                {/* Mid-run questions (the interactive gate). */}
                {questions.map((q) => (
                  <QuestionCard key={q.id} question={q} onAnswer={answerQuestion} />
                ))}

                {/* Finished run: the produced artifact is the primary content, so
                  the transcript collapses into a closed disclosure below it. The
                  terminal mounts only while expanded — artifact-first, and no idle
                  SSE attach per finished run. Expanding replays read-only. */}
                {displayRun && id && !displayRun.live && (
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950/40">
                    <button
                      type="button"
                      onClick={() => setTranscriptOpen((o) => !o)}
                      aria-expanded={transcriptOpen}
                      className="flex w-full cursor-pointer select-none items-center gap-1 px-3 py-2 text-left font-mono text-xs text-zinc-400 hover:text-zinc-200"
                    >
                      <span>{transcriptOpen ? '▾' : '▸'}</span>
                      agent transcript ·{' '}
                      {STAGE_LABELS[displayRun.stage as Stage] ?? displayRun.stage}
                      {displayRunDuration && (
                        <span className="tabular-nums text-zinc-500">· {displayRunDuration}</span>
                      )}
                    </button>
                    {transcriptOpen && (
                      <div className="px-2 pb-2">
                        <RunTerminal
                          key={displayRun.id}
                          taskId={id}
                          runId={displayRun.id}
                          stage={STAGE_LABELS[displayRun.stage as Stage] ?? displayRun.stage}
                          live={false}
                          onCost={setRunCost}
                          onQuestion={load}
                          onTerminal={() => {
                            lastTerminalRunIdRef.current = displayRun.id;
                            setActiveRun(null);
                            load();
                          }}
                        />
                      </div>
                    )}
                  </div>
                )}

                {/* Inspecting a stage/artifact dead-center. When the task is also
                  paused at a gate, the approval block renders directly below so
                  the human can review the (auto-opened) brief/plan and decide
                  without leaving the view. */}
                {inspecting && (
                  <div
                    ref={centerWrapRef}
                    className={cn(
                      'scroll-mt-4 rounded-lg transition-shadow duration-700',
                      highlightArtifact &&
                        'ring-2 ring-primary ring-offset-2 ring-offset-background',
                    )}
                  >
                    {centerAsset ? (
                      <MediaViewer
                        asset={centerAsset}
                        src={api.assetUrl(id!, centerAsset.name)}
                        onClose={() => {
                          setCenterAsset(null);
                          setSelectedStage(null);
                          setManuallyPinned(false);
                        }}
                      />
                    ) : (
                      <CenterViewer
                        title={
                          centerArtifact
                            ? ARTIFACT_KIND_LABELS[centerArtifact.kind] +
                              (artifactVersions.has(centerArtifact.id)
                                ? ` V${artifactVersions.get(centerArtifact.id)}`
                                : '')
                            : 'Raw intake'
                        }
                        body={centerArtifact?.body ?? task.rawRequest}
                        editable={!!centerArtifact && EDITABLE_KINDS.has(centerArtifact.kind)}
                        busy={busy}
                        onSave={
                          centerArtifact
                            ? (body) => saveArtifact(centerArtifact.id, body)
                            : undefined
                        }
                        onClose={() => {
                          setCenterArtifact(null);
                          setSelectedStage(null);
                          setManuallyPinned(false);
                        }}
                      />
                    )}
                  </div>
                )}

                {inspecting && atGate ? (
                  <ApprovalGate
                    task={task}
                    actions={actions}
                    busy={busy}
                    blocked={hasOpenQuestions}
                    onAct={runAction}
                    comment={reviewComment}
                    onCommentChange={setReviewComment}
                    diff={showWorktreeReview ? worktreeDiff : null}
                    diffLoading={showWorktreeReview && diffLoading}
                    onSkipWorktree={
                      task.stage === 'human_brief_approval' && !selfTargeting
                        ? () => setConfirmSkipWorktree(true)
                        : undefined
                    }
                    skipE2e={skipE2e}
                    onSkipE2eChange={
                      task.stage === 'human_plan_approval' ? setSkipE2e : undefined
                    }
                  />
                ) : inspecting ? null : !hasWorktree ? (
                  <WorktreeCreate
                    busy={busy}
                    onCreate={() => withBusy(() => api.createWorktree(id!))}
                  />
                ) : atGate ? (
                  <ApprovalGate
                    task={task}
                    actions={actions}
                    busy={busy}
                    blocked={hasOpenQuestions}
                    onAct={runAction}
                    comment={reviewComment}
                    onCommentChange={setReviewComment}
                    diff={showWorktreeReview ? worktreeDiff : null}
                    diffLoading={showWorktreeReview && diffLoading}
                    onSkipWorktree={
                      task.stage === 'human_brief_approval' && !selfTargeting
                        ? () => setConfirmSkipWorktree(true)
                        : undefined
                    }
                    skipE2e={skipE2e}
                    onSkipE2eChange={
                      task.stage === 'human_plan_approval' ? setSkipE2e : undefined
                    }
                  />
                ) : terminal ? (
                  <DoneSummary
                    stage={task.stage}
                    status={task.status}
                    delivery={delivery?.target ?? null}
                  />
                ) : (
                  // Actions stay disabled while a run is live — even if the kicking
                  // POST's connection dropped, the daemon is still working and a
                  // second kick would double-run the stage.
                  <RunCenter actions={actions} busy={busy || !!activeRun} onAct={runAction} />
                )}
              </div>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      <Dialog open={confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this task?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This removes the task, its artifacts, runs, and approvals. Any active worktree is
            removed from disk. This cannot be undone.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmDelete(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={deleteTask} disabled={busy}>
              {busy ? 'Deleting…' : 'Delete task'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmAbandon} onOpenChange={(o) => !o && setConfirmAbandon(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Abandon this task?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This stops any running agent session and marks the task <strong>abandoned</strong> — a
            terminal state. The task, its artifacts, and any worktree are kept (use Delete to remove
            them). This cannot be undone.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmAbandon(false)} disabled={busy}>
              Keep task
            </Button>
            <Button variant="destructive" onClick={abandonTask} disabled={busy}>
              {busy ? 'Abandoning…' : 'Abandon task'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmSkipWorktree} onOpenChange={(o) => !o && setConfirmSkipWorktree(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Skip worktree — commit directly to main?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            No isolated branch will be created. All implementation commits will land directly on{' '}
            <code>{detail?.project?.defaultBranch ?? 'the default branch'}</code>. This is intended
            for small, low-risk changes only.
          </p>
          <p className="mt-2 text-sm font-medium text-destructive">
            This cannot be undone once approved.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmSkipWorktree(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="default" onClick={approveBriefDirect} disabled={busy}>
              {busy ? 'Approving…' : 'Approve (commit to main)'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );

  // Local helper that wraps a worktree op with busy + reload.
  async function withBusy(op: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await op();
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
}

/** Latest artifact of a kind for the task, or null. */
function latestOfKind(detail: TaskDetail | null, kind: ArtifactKind): Artifact | null {
  if (!detail) return null;
  const of = detail.artifacts.filter((a) => a.kind === kind);
  return of.length ? of[of.length - 1]! : null;
}

/**
 * Inline cost/turns/tokens counter for the compact header meta row. Keeps a
 * literal `cost` label and the `N turns · $X · …tokens` figure on one line, for
 * the live (or most-recent) single run.
 */
function InlineCost({ running, cost }: { running: boolean; cost: CostSummary | null }) {
  const segments = costSegments(cost);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span>cost</span>
      {running && !cost ? (
        <Skeleton className="h-3 w-14" />
      ) : (
        <span className="tabular-nums">{segments.length ? segments.join(' · ') : '—'}</span>
      )}
    </span>
  );
}

/**
 * Per-stage cost bar shown at the top of the center panel when a stage is
 * selected. Sums every run for that stage and renders the full breakdown
 * (cost · turns · in/out/cached tokens) so a glance answers "what did this
 * stage cost?". `cached` (cache-read) is the spend lever on resumed sessions.
 */
function StageCostBar({
  stageLabel,
  runCount,
  cost,
}: {
  stageLabel: string;
  runCount: number;
  cost: CostSummary;
}) {
  const segments = costSegments(cost);
  return (
    <div
      data-testid="stage-cost-bar"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
    >
      <span className="font-medium text-foreground">{stageLabel}</span>
      {runCount > 1 && (
        <>
          <span aria-hidden>·</span>
          <span>{runCount} runs</span>
        </>
      )}
      {segments.length > 0 && (
        <>
          <span aria-hidden>·</span>
          <span className="tabular-nums">{segments.join(' · ')}</span>
        </>
      )}
    </div>
  );
}

/** Tailwind class for the small status dot in the header meta row. */
function statusDotClass(status: string) {
  switch (status) {
    case 'active':
      return 'bg-primary';
    case 'done':
      return 'bg-ok';
    case 'abandoned':
      return 'bg-muted-foreground';
    default:
      return 'bg-border';
  }
}

/**
 * Collapsed lifecycle rail — a thin vertical strip of state dots (one per
 * stage). Each dot stays clickable: clicking it expands the rail and selects
 * that stage. A top toggle re-expands the rail directly.
 */
function LifecycleDotStrip({
  stages,
  currentIdx,
  taskStatus,
  selectedStage,
  onExpandSelect,
  onToggle,
}: {
  stages: readonly Stage[];
  currentIdx: number;
  taskStatus: string;
  selectedStage: string | null;
  onExpandSelect: (stage: Stage) => void;
  onToggle: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center gap-1 overflow-y-auto py-3">
      <button
        type="button"
        onClick={onToggle}
        className="mb-1 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        title="Expand lifecycle"
        aria-label="Expand lifecycle"
      >
        <PanelLeftOpen className="h-4 w-4" />
      </button>
      {stages.map((stage, i) => {
        const state =
          i < currentIdx || taskStatus === 'done'
            ? 'completed'
            : i === currentIdx
              ? 'current'
              : 'pending';
        return (
          <button
            key={stage}
            type="button"
            onClick={() => onExpandSelect(stage)}
            title={STAGE_LABELS[stage]}
            aria-label={STAGE_LABELS[stage]}
            className="flex h-5 w-5 items-center justify-center rounded-full hover:bg-muted"
          >
            <span
              className={cn(
                'h-2.5 w-2.5 rounded-full bg-border',
                state === 'current' && 'bg-primary ring-2 ring-primary/30',
                state === 'completed' && 'bg-ok',
                selectedStage === stage && 'ring-2 ring-primary',
              )}
            />
          </button>
        );
      })}
    </div>
  );
}

/**
 * Dead-center viewer for a stage's input/artifact. Editable kinds (brief/plan)
 * render an editable markdown surface with a Save button; everything else is
 * read-only text. A top-right Copy button copies the raw text.
 */
function CenterViewer({
  title,
  body,
  editable,
  busy,
  onSave,
  onClose,
}: {
  title: string;
  body: string;
  editable: boolean;
  busy: boolean;
  onSave?: (body: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(body);
  const [copied, setCopied] = useState(false);
  useEffect(() => setDraft(body), [body]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <Panel>
      <PanelHeader
        title={title}
        action={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        }
      />
      <PanelBody>
        {editable && onSave ? (
          <>
            <MarkdownEditor value={body} editable onChange={setDraft} />
            <div className="mt-3 flex justify-end">
              <Button size="sm" disabled={busy || draft === body} onClick={() => onSave(draft)}>
                {busy ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </>
        ) : (
          <div className="max-h-[70vh] overflow-auto">
            <MarkdownEditor value={body} editable={false} />
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}

/**
 * Renders a QA proof asset dead-center: videos play inline, images render inline,
 * and traces (which can't be embedded) offer a download to open in Playwright's
 * trace viewer. Header mirrors CenterViewer (title + Close).
 */
function MediaViewer({
  asset,
  src,
  onClose,
}: {
  asset: DemoAsset;
  src: string;
  onClose: () => void;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="truncate text-base font-semibold" title={asset.name}>
          {ASSET_ICON[asset.kind]} {asset.name}
        </h3>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <a href={src} download={asset.name}>
              Download
            </a>
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
      <div className="flex max-h-[70vh] items-center justify-center overflow-auto rounded-md border bg-background p-3.5">
        {asset.kind === 'video' ? (
          // biome-ignore lint/a11y/useMediaCaption: QA screen recording has no captions track.
          <video controls src={src} className="max-h-[66vh] max-w-full">
            Your browser cannot play this video.
          </video>
        ) : asset.kind === 'image' ? (
          <img src={src} alt={asset.name} className="max-h-[66vh] max-w-full object-contain" />
        ) : (
          <div className="py-8 text-center text-sm text-muted-foreground">
            <p>This {asset.kind === 'trace' ? 'Playwright trace' : 'file'} can't be previewed.</p>
            <p className="mt-1">
              Download it and open with{' '}
              <code className="rounded bg-muted px-1">npx playwright show-trace</code>.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/** New-task state: worktree creation is the first, prominent action. */
function WorktreeCreate({ busy, onCreate }: { busy: boolean; onCreate: () => void }) {
  return (
    <div className="mx-auto max-w-md py-10 text-center">
      <h3 className="text-base font-semibold">Create the worktree</h3>
      <p className="mt-1.5 text-sm text-muted-foreground">
        A per-task git worktree is the first step. The agent works in an isolated branch.
      </p>
      <Button className="mt-4" disabled={busy} onClick={onCreate}>
        Create worktree
      </Button>
    </div>
  );
}

/**
 * The 4 gate-clearing approval endpoints. Disabled while a run has an open
 * question (the daemon also 409s).
 */
const APPROVAL_ENDPOINTS = new Set([
  'approve-brief',
  'approve-plan',
  'review/complete',
  'approve-delivery',
]);

/** Paused at a gate — the approval block is dead-center. */
function ApprovalGate({
  task,
  actions,
  busy,
  blocked,
  onAct,
  comment,
  onCommentChange,
  diff,
  diffLoading,
  onSkipWorktree,
  skipE2e,
  onSkipE2eChange,
}: {
  task: TaskDetail['task'];
  actions: StageAction[];
  busy: boolean;
  blocked: boolean;
  onAct: (a: StageAction) => void;
  comment: string;
  onCommentChange: (value: string) => void;
  /** Full worktree diff to surface on post-QA review gates; null elsewhere. */
  diff?: string | null;
  /** Whether the diff is still being fetched. */
  diffLoading?: boolean;
  /** When provided, renders a secondary "Skip worktree" action on this gate. */
  onSkipWorktree?: () => void;
  /** When provided (plan gate), renders the "skip Project E2E" checkbox. */
  skipE2e?: boolean;
  onSkipE2eChange?: (value: boolean) => void;
}) {
  // A reject action needs a reason; the gate hints when one is required.
  const rejectNeedsReason = actions.some((a) => a.requiresComment);
  // Widen the gate when a diff panel is in play so the code is readable.
  const showsDiff = diff != null || diffLoading;
  return (
    <div className={`mx-auto py-6 ${showsDiff ? 'max-w-4xl' : 'max-w-xl'}`}>
      <h3 className="text-base font-semibold">Approval required</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        {STAGE_LABELS[task.stage]} — review and decide.
      </p>
      <div className="mt-3 rounded-md border bg-secondary p-3 font-mono text-xs">
        Stage: {task.stage}
      </div>
      {showsDiff && <WorktreeDiffPanel diff={diff ?? null} loading={!!diffLoading} />}
      <div className="mt-3 space-y-1.5">
        <label className="text-sm text-muted-foreground" htmlFor="review-comment">
          {rejectNeedsReason
            ? 'Reason / comment (required to reject)'
            : 'Review comment (optional)'}
        </label>
        <Textarea
          id="review-comment"
          placeholder="Notes for the record…"
          value={comment}
          onChange={(e) => onCommentChange(e.target.value)}
        />
      </div>
      {onSkipE2eChange && (
        <label className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={!!skipE2e}
            onChange={(e) => onSkipE2eChange(e.target.checked)}
          />
          Skip Project E2E tests (static checks still run)
        </label>
      )}
      <div className="mt-4 flex gap-2">
        {actions.map((a) => {
          const gated = blocked && APPROVAL_ENDPOINTS.has(a.endpoint);
          const needsReason = a.requiresComment && !comment.trim();
          return (
            <Button
              key={a.bounceTarget ? `${a.endpoint}:${a.bounceTarget}` : a.endpoint}
              variant={
                a.tone === 'primary' ? 'default' : a.tone === 'danger' ? 'destructive' : 'outline'
              }
              disabled={busy || gated || needsReason}
              title={
                gated
                  ? 'Answer the open question(s) first'
                  : needsReason
                    ? 'Enter a reason to reject'
                    : undefined
              }
              onClick={() => onAct(a)}
            >
              {a.label}
            </Button>
          );
        })}
        {onSkipWorktree && (
          <Button
            variant="outline"
            disabled={busy || blocked}
            title={
              blocked
                ? 'Answer the open question(s) first'
                : 'Approve and commit directly to the default branch (no isolated worktree)'
            }
            onClick={onSkipWorktree}
          >
            Skip worktree (commit to main)
          </Button>
        )}
      </div>
      {blocked && (
        <p className="mt-2 text-xs text-muted-foreground">
          This gate is blocked until the open question(s) above are answered.
        </p>
      )}
    </div>
  );
}

/** Collapsible "Full diff" disclosure shown on post-QA review gates. */
function WorktreeDiffPanel({ diff, loading }: { diff: string | null; loading: boolean }) {
  const files = useMemo(() => (diff ? parseDiff(diff) : []), [diff]);
  const [viewType, setViewType] = useState<ViewType>('unified');
  const totals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const f of files) {
      for (const h of f.hunks) {
        for (const c of h.changes) {
          if (c.type === 'insert') additions++;
          else if (c.type === 'delete') deletions++;
        }
      }
    }
    return { additions, deletions };
  }, [files]);
  return (
    <details className="mt-3 rounded-md border bg-card" open>
      <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium">
        Full diff
        {!loading && diff != null && (
          <span className="ml-2 font-normal text-muted-foreground">
            {files.length === 0 ? (
              'no changes'
            ) : (
              <>
                {files.length} file{files.length === 1 ? '' : 's'} changed
                <span className="ml-2 text-emerald-600 dark:text-emerald-400">
                  +{totals.additions}
                </span>{' '}
                <span className="text-rose-600 dark:text-rose-400">−{totals.deletions}</span>
              </>
            )}
          </span>
        )}
      </summary>
      <div className="border-t px-3 py-2">
        {loading ? (
          <Skeleton className="h-40 w-full" />
        ) : files.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            No changes in the worktree relative to its base branch.
          </p>
        ) : (
          <>
            <div className="mb-2 flex justify-end">
              <div className="inline-flex overflow-hidden rounded-md border text-xs">
                {(['unified', 'split'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setViewType(v)}
                    className={cn(
                      'px-2 py-1 capitalize',
                      viewType === v
                        ? 'bg-secondary font-medium'
                        : 'text-muted-foreground hover:bg-secondary/50',
                    )}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>
            <div className="max-h-[60vh] space-y-3 overflow-auto">
              {files.map((file) => (
                <DiffFile
                  key={file.oldRevision + file.newRevision + (file.newPath || file.oldPath)}
                  file={file}
                  viewType={viewType}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </details>
  );
}

/** One file's diff: collapsible header (path + counts) over a react-diff-view table. */
function DiffFile({ file, viewType }: { file: FileData; viewType: ViewType }) {
  const [open, setOpen] = useState(true);
  const path = file.type === 'delete' ? file.oldPath : file.newPath;
  const { additions, deletions } = useMemo(() => {
    let a = 0;
    let d = 0;
    for (const h of file.hunks) {
      for (const c of h.changes) {
        if (c.type === 'insert') a++;
        else if (c.type === 'delete') d++;
      }
    }
    return { additions: a, deletions: d };
  }, [file]);
  // Word-level intra-line highlighting on top of the line-level diff.
  const tokens = useMemo(
    () => tokenize(file.hunks, { enhancers: [markEdits(file.hunks)] }),
    [file],
  );
  return (
    <div className="overflow-hidden rounded-md border">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 bg-secondary/60 px-3 py-1.5 text-left text-xs"
      >
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
        <span className="font-mono">{path}</span>
        {file.type === 'add' && <Badge variant="outline">new</Badge>}
        {file.type === 'delete' && <Badge variant="outline">deleted</Badge>}
        {file.type === 'rename' && <Badge variant="outline">renamed</Badge>}
        <span className="ml-auto text-emerald-600 dark:text-emerald-400">+{additions}</span>
        <span className="text-rose-600 dark:text-rose-400">−{deletions}</span>
      </button>
      {open && (
        <div className="diff-view-wrap overflow-x-auto text-xs">
          <Diff viewType={viewType} diffType={file.type} hunks={file.hunks} tokens={tokens}>
            {(hunks) =>
              hunks.flatMap((hunk) => [
                <Decoration key={`deco-${hunk.content}`}>
                  <div className="bg-secondary/40 px-3 py-0.5 font-mono text-sky-600 dark:text-sky-400">
                    {hunk.content}
                  </div>
                </Decoration>,
                <Hunk key={hunk.content} hunk={hunk} />,
              ])
            }
          </Diff>
        </div>
      )}
    </div>
  );
}

/**
 * Active-stage state: offer the human-kickable streaming runs for the agent
 * stages plus any stage actions.
 */
function RunCenter({
  actions,
  busy,
  onAct,
}: {
  actions: StageAction[];
  busy: boolean;
  onAct: (a: StageAction) => void;
}) {
  return (
    <div>
      <h3 className="mb-2 text-base font-semibold">Stage agent</h3>
      <p className="mb-2 text-sm text-muted-foreground">
        Stages run automatically — live output for the current stage streams above while the agent
        works.
      </p>
      <RunControls actions={actions} busy={busy} onAct={onAct} />
    </div>
  );
}

/** Calm read-only summary for done / abandoned tasks. */
function DoneSummary({
  stage,
  status,
  delivery,
}: {
  stage: string;
  status: string;
  delivery: string | null;
}) {
  return (
    <div className="mx-auto max-w-md py-10 text-center">
      <h3 className="text-base font-semibold">
        {status === 'done' ? 'Task complete' : 'Task abandoned'}
      </h3>
      <p className="mt-1.5 text-sm text-muted-foreground">
        Final stage: {STAGE_LABELS[stage as keyof typeof STAGE_LABELS] ?? stage}.
      </p>
      {delivery && <p className="mt-1 text-sm text-muted-foreground">Delivery: {delivery}</p>}
    </div>
  );
}

/** Stage action buttons + run controls. */
function RunControls({
  actions,
  busy,
  onAct,
}: {
  actions: StageAction[];
  busy: boolean;
  onAct: (a: StageAction) => void;
}) {
  if (actions.length === 0) return null;
  return (
    <div className="mt-4 flex flex-wrap gap-2 border-t pt-3">
      {actions.map((a) => (
        <Button
          key={a.bounceTarget ? `${a.endpoint}:${a.bounceTarget}` : a.endpoint}
          size="sm"
          variant={
            a.tone === 'primary' ? 'default' : a.tone === 'danger' ? 'destructive' : 'outline'
          }
          disabled={busy}
          onClick={() => onAct(a)}
        >
          {a.label}
        </Button>
      ))}
    </div>
  );
}

/**
 * Map artifact id -> version number (1-based) for artifacts whose `kind` has 2+
 * instances on the task. `artifacts` is assumed createdAt-ordered (the store
 * returns it that way), so the running counter is chronological. Single-instance
 * kinds are omitted — they need no version suffix.
 */
function artifactVersionMap(artifacts: Artifact[]): Map<string, number> {
  const totalByKind = new Map<ArtifactKind, number>();
  for (const a of artifacts) totalByKind.set(a.kind, (totalByKind.get(a.kind) ?? 0) + 1);
  const versionById = new Map<string, number>();
  const seenByKind = new Map<ArtifactKind, number>();
  for (const a of artifacts) {
    const n = (seenByKind.get(a.kind) ?? 0) + 1;
    seenByKind.set(a.kind, n);
    if ((totalByKind.get(a.kind) ?? 0) > 1) versionById.set(a.id, n);
  }
  return versionById;
}

/**
 * Attribute each artifact to the lifecycle stage it belongs under, returned as
 * a `stage → artifacts` map preserving creation order within each stage. The
 * owning StageRun's stage wins (faithful to reruns/bounces); otherwise we fall
 * back to the artifact kind's natural stage, so cross-cutting logs/diffs and
 * any null `stageRunId` still land somewhere sensible.
 */
function groupArtifactsByStage(detail: TaskDetail | null): Map<Stage, Artifact[]> {
  const byStage = new Map<Stage, Artifact[]>();
  if (!detail) return byStage;
  const runStage = new Map<string, Stage>(detail.stageRuns.map((r) => [r.id, r.stage]));
  for (const a of detail.artifacts) {
    const stage =
      (a.stageRunId ? runStage.get(a.stageRunId) : undefined) ?? ARTIFACT_KIND_STAGE[a.kind];
    if (!stage) continue;
    const list = byStage.get(stage);
    if (list) list.push(a);
    else byStage.set(stage, [a]);
  }
  return byStage;
}

/**
 * Sum wall-clock per stage across all its StageRuns (re-entries from a bounce
 * each add a run for the same stage). In-progress runs measure to `now`.
 */
function stageDurations(stageRuns: StageRun[], now: number): Map<Stage, number> {
  const byStage = new Map<Stage, number>();
  for (const run of stageRuns) {
    const d = stageRunDurationMs(run, now);
    if (d == null) continue;
    byStage.set(run.stage, (byStage.get(run.stage) ?? 0) + d);
  }
  return byStage;
}

/** Slim worktree summary + git ops, in the left rail. */
function WorktreeInfo({
  taskId,
  worktree,
  onError,
}: {
  taskId: string;
  worktree: NonNullable<TaskDetail['worktree']>;
  onError: (e: string) => void;
}) {
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);

  const refresh = async () => {
    try {
      setGitStatus(await api.worktreeStatus(taskId));
    } catch (e) {
      onError(String(e));
    }
  };

  return (
    <div className="text-xs">
      <div className="mb-2 font-semibold uppercase tracking-wider text-muted-foreground">
        Worktree
      </div>
      <div className="space-y-0.5">
        <div>
          <span className="text-muted-foreground">branch </span>
          <code>{worktree.branch}</code>
        </div>
        <div>
          <span className="text-muted-foreground">status </span>
          {worktree.status}
        </div>
      </div>
      <Button variant="outline" size="sm" className="mt-2" onClick={refresh}>
        Refresh status
      </Button>
      {gitStatus && (
        <div className="mt-2 text-muted-foreground">
          {gitStatus.clean ? 'clean' : `${gitStatus.changedFiles.length} changed`} · ahead{' '}
          {gitStatus.ahead} / behind {gitStatus.behind}
        </div>
      )}
    </div>
  );
}

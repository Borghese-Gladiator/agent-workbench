"""On-disk layout for staged runs.

A "staged run" has the directory layout introduced by TODO §1 (Renovate task
workflow): canonical outputs live under stages/<stage>/, superseded outputs
under archive/<stage>/, and HUMAN_REVIEW.md replaces handoff.md.

A "flat run" is anything created before the renovate change — outputs sit at
the run root. Flat runs are read-only forever; new runs are always staged.

Public surface (read by transitions.py and the CLI commands):

    LAYOUT_FLAT, LAYOUT_STAGED         layout labels
    detect_layout(cfg, run_id)         returns one of the two labels
    is_staged_run(cfg, run_id)         True iff stages/ exists at run root
    init_staged_layout(cfg, run_id)    called by new-run; creates stages/
    stage_dir(cfg, run_id, stage)      path of stages/<stage>/
    archive_dir(cfg, run_id, stage)    path of archive/<stage>/
    human_review_path(cfg, run_id)     path of HUMAN_REVIEW.md at run root

    on_transition(cfg, run_id, from_state, to_state, evidence)
        Called by the transition engine after set_status. Moves the just-
        produced outputs into stages/<from_state>/, returns the evidence-key
        rewrites the engine should apply before recording TransitionApplied.
        Idempotent: re-running it on already-staged files is a no-op.

    archive_for_bounce(cfg, run_id)
        Called by cmd_bounce before the transition. Moves the current
        stages/4_building/ and stages/5_validating/ contents into
        archive/<N>_<stage>/<file>-v<N>.md (or qa-v<N>/ for the qa subdir).

    prune_empty_dirs(cfg, run_id)
        Removes empty subtrees under stages/, archive/, and any qa/ within.

    validate_human_review_sections(cfg, run_id)
        Returns a list of missing required headings; empty list = OK.

The module never reads or writes metadata.yaml; it only moves files and reports.
"""
from __future__ import annotations

import pathlib
import re
import shutil

from lib import metadata as metadata_mod
from lib.config import Config


LAYOUT_FLAT = "flat"
LAYOUT_STAGED = "staged"


REQUIRED_HUMAN_REVIEW_HEADINGS = (
    "## Files",
    "## Summary of changes",
    "## Testing",
    "## Run timeline",
)


# Stage execution order. The on-disk directory for a stage is
# "<N>_<stage>" so `ls` sorts stages by lifecycle flow instead of
# alphabetically (TODO #1 from docs/TODO.md). Runs created before this
# change keep their unnumbered directory names — `stage_dir` reads what's
# on disk first and only falls back to the numbered name for new runs.
_STAGE_NUMBER: dict[str, int] = {
    "draft": 1,
    "shaping": 2,
    "planning": 3,
    "building": 4,
    "validating": 5,
    "followups": 6,
}


def _stage_dirname(stage: str) -> str:
    n = _STAGE_NUMBER.get(stage)
    return f"{n}_{stage}" if n is not None else stage


# ---------- layout detection ----------

def _run_root(cfg: Config, run_id: str) -> pathlib.Path:
    return metadata_mod.run_dir(cfg, run_id)


def is_staged_run(cfg: Config, run_id: str) -> bool:
    return (_run_root(cfg, run_id) / "stages").is_dir()


def detect_layout(cfg: Config, run_id: str) -> str:
    return LAYOUT_STAGED if is_staged_run(cfg, run_id) else LAYOUT_FLAT


# ---------- path helpers ----------

def stage_dir(
    cfg: Config,
    run_id: str,
    stage: str,
    *,
    run_root: pathlib.Path | None = None,
) -> pathlib.Path:
    """Path of stages/<stage>/ for the given run.

    Pass ``run_root`` to skip the metadata-driven re-resolution of where the
    run lives on disk. The board's hot path uses this — it already holds a
    resolved ``Run.run_dir`` and shouldn't pay the cost again.
    """
    root = run_root if run_root is not None else _run_root(cfg, run_id)
    return _resolve_stage_dir(root / "stages", stage)


def archive_dir(cfg: Config, run_id: str, stage: str) -> pathlib.Path:
    return _resolve_stage_dir(_run_root(cfg, run_id) / "archive", stage)


def _resolve_stage_dir(parent: pathlib.Path, stage: str) -> pathlib.Path:
    # In-flight runs created before numbered dirnames landed keep their
    # unnumbered directory: if it exists, use it; otherwise default to the
    # numbered name for new runs.
    legacy = parent / stage
    if legacy.exists():
        return legacy
    return parent / _stage_dirname(stage)


def human_review_path(cfg: Config, run_id: str) -> pathlib.Path:
    return _run_root(cfg, run_id) / "HUMAN_REVIEW.md"


# ---------- initialisation ----------

def init_staged_layout(cfg: Config, run_id: str) -> None:
    """Create the staged-layout scaffolding for a fresh run.

    Called by new-run after metadata.create. Creates stages/ only — the
    per-stage subdirectories are created on demand by on_transition.
    """
    (_run_root(cfg, run_id) / "stages").mkdir(parents=True, exist_ok=True)


# ---------- per-stage move table ----------

# Maps from_state -> list of (evidence_key, source_relpath_at_run_root, dest_stage, dest_filename).
# When a stage closes (from_state -> next state), we move each source file into
# stages/<dest_stage>/<dest_filename> and report the new path back to the
# transition engine for evidence rewriting.
#
# For plan.md the planner now produces ONE file with folded sections; the
# preflight / assumptions / decisions evidence keys all point at plan.md with
# an anchor, so the move table only physically moves plan.md.
_STAGE_OUTPUTS: dict[str, list[tuple[str, str, str, str]]] = {
    "draft": [
        ("raw_idea_path", "raw-idea.md", "draft", "raw-idea.md"),
        # answers.md is optional (only present when /draft asked questions).
        # The mover is a no-op when the source file doesn't exist.
        ("answers_path", "answers.md", "draft", "answers.md"),
    ],
    "shaping": [
        ("brief_path", "brief.md", "shaping", "brief.md"),
    ],
    "planning": [
        ("plan_path", "plan.md", "planning", "plan.md"),
    ],
    "ready": [],  # no new outputs at this hop
    "building": [
        ("implementation_summary_path", "build.md", "building", "build.md"),
    ],
    "validating": [
        ("review_report_path", "review.md", "validating", "review.md"),
    ],
    "followups": [
        ("followups_path", "follow-ups.md", "followups", "follow-ups.md"),
    ],
    "human_review": [],  # terminal hop produces no new outputs
}

# Evidence keys whose value points at the SAME file as another key (via a
# fragment / anchor). Maps key -> (anchor on the canonical file, name of the
# canonical key whose source file is the real target).
_ANCHORED_EVIDENCE: dict[str, tuple[str, str]] = {
    "preflight_path": ("#preflight", "plan_path"),
    "assumptions_path": ("#decisions--assumptions", "plan_path"),
    "decisions_path": ("#decisions--assumptions", "plan_path"),
    "diff_summary_path": ("#files-changed", "implementation_summary_path"),
    "audit_path": ("#run-timeline", "handoff_path"),
}


def _path_for_evidence_key(stage_dest: dict[str, pathlib.Path], key: str) -> pathlib.Path | None:
    """Resolve an evidence key to its post-move path, following anchor aliases."""
    if key in stage_dest:
        return stage_dest[key]
    if key in _ANCHORED_EVIDENCE:
        anchor, canonical_key = _ANCHORED_EVIDENCE[key]
        target = stage_dest.get(canonical_key)
        if target is not None:
            return pathlib.Path(str(target) + anchor)
    return None


# ---------- the move-on-transition hook ----------

def on_transition(
    cfg: Config,
    run_id: str,
    from_state: str,
    to_state: str,
    evidence: dict,
) -> dict[str, str]:
    """Promote stage outputs into stages/<stage>/ and return evidence rewrites.

    Called by transitions.transition after a successful set_status, only for
    staged runs. Idempotent. Returns a dict {evidence_key: new_path_str} for
    every key whose value should be rewritten before recording the event.

    Special-case for validating -> human_review:
      - Move review.md into stages/5_validating/review.md
      - Move qa/ subdirectory into stages/5_validating/qa/
      - Confirm HUMAN_REVIEW.md exists (validation happens upstream in
        transitions.py; this hook only physically organises files)
      - Prune empty subtrees under stages/ and archive/
    """
    run_root = _run_root(cfg, run_id)
    rewrites: dict[str, str] = {}
    stage_dest: dict[str, pathlib.Path] = {}

    moves = _STAGE_OUTPUTS.get(from_state, [])
    for evidence_key, src_relpath, dest_stage, dest_filename in moves:
        src = run_root / src_relpath
        dest = stage_dir(cfg, run_id, dest_stage) / dest_filename
        _move_file_if_present(src, dest)
        # Resolve the new path even if src didn't exist (the destination may
        # already be there from a previous run of this hook).
        stage_dest[evidence_key] = dest

    # The qa/ directory tags along with validating -> followups (since
    # followups is now what validating closes into).
    if from_state == "validating":
        qa_src = run_root / "qa"
        qa_dest = stage_dir(cfg, run_id, "validating") / "qa"
        _move_tree_if_present(qa_src, qa_dest)

    # Prune empty stages/archive trees on the final hop into human_review.
    if to_state == "human_review":
        prune_empty_dirs(cfg, run_id)

    # Build the rewrite dict from the moves we performed, including anchored
    # evidence keys that piggyback on a canonical file.
    for key in list(evidence.keys()):
        new_path = _path_for_evidence_key(stage_dest, key)
        if new_path is not None:
            # Store as a path relative to the run root so events.jsonl stays portable.
            try:
                rel = new_path.relative_to(run_root)
                rewrites[key] = str(rel)
            except ValueError:
                # Anchored path (has a #fragment) — strip the run_root prefix manually.
                s = str(new_path)
                root_str = str(run_root) + "/"
                rewrites[key] = s[len(root_str):] if s.startswith(root_str) else s

    return rewrites


# ---------- bounce-time supersession ----------

def archive_for_bounce(cfg: Config, run_id: str) -> list[pathlib.Path]:
    """Move current building/validating stage contents into archive/<stage>/.

    Called by cmd_bounce BEFORE the human_review -> building transition.
    Returns the list of new archive paths created.

    Versioning: every regular file moves to archive/<stage>/<stem>-v<N><suffix>
    where N is one higher than the largest existing -v<N> for that stem.
    The qa/ directory moves as a whole to archive/validating/qa-v<N>/.
    """
    moved: list[pathlib.Path] = []

    # followups is included so prior brainstorms don't leak into the rebuild.
    for stage in ("building", "validating", "followups"):
        src_stage = stage_dir(cfg, run_id, stage)
        if not src_stage.exists():
            continue
        dest_stage = archive_dir(cfg, run_id, stage)
        dest_stage.mkdir(parents=True, exist_ok=True)

        for entry in sorted(src_stage.iterdir()):
            if entry.is_dir():
                # qa/ at any depth: archive as qa-v<N>/
                versioned = _versioned_dir_name(dest_stage, entry.name)
                shutil.move(str(entry), str(dest_stage / versioned))
                moved.append(dest_stage / versioned)
            else:
                versioned = _versioned_file_name(dest_stage, entry.name)
                shutil.move(str(entry), str(dest_stage / versioned))
                moved.append(dest_stage / versioned)

        # Leave an empty stage dir so the rebuild can write into it again.
        src_stage.mkdir(parents=True, exist_ok=True)

    return moved


def _versioned_file_name(dest_dir: pathlib.Path, filename: str) -> str:
    stem, dot, ext = filename.rpartition(".")
    if not dot:
        stem, ext = filename, ""
    else:
        ext = "." + ext
    n = _next_version(dest_dir, stem, ext)
    return f"{stem}-v{n}{ext}"


def _versioned_dir_name(dest_dir: pathlib.Path, dirname: str) -> str:
    n = _next_version(dest_dir, dirname, "")
    return f"{dirname}-v{n}"


def _next_version(dest_dir: pathlib.Path, stem: str, ext: str) -> int:
    """Return the next -v<N> integer for files/dirs matching <stem>-v<N><ext>."""
    if not dest_dir.exists():
        return 1
    pattern = re.compile(re.escape(stem) + r"-v(\d+)" + re.escape(ext) + r"$")
    highest = 0
    for child in dest_dir.iterdir():
        m = pattern.match(child.name)
        if m:
            highest = max(highest, int(m.group(1)))
    return highest + 1


# ---------- pruning ----------

def prune_empty_dirs(cfg: Config, run_id: str) -> None:
    """Remove empty subtrees under stages/, archive/, and any qa/ dirs.

    A directory is "empty" if it contains no files and no non-empty
    subdirectories (so empty-grandchild chains collapse). The top-level
    stages/ and archive/ dirs themselves are removed too if they end up empty.
    """
    root = _run_root(cfg, run_id)
    for top in ("stages", "archive"):
        _rm_empty_subtree(root / top)


def _rm_empty_subtree(d: pathlib.Path) -> bool:
    """Recursively remove empty directories. Returns True iff d was removed."""
    if not d.exists() or not d.is_dir():
        return False
    for child in list(d.iterdir()):
        if child.is_dir():
            _rm_empty_subtree(child)
    # After pruning children, are we empty?
    if not any(d.iterdir()):
        d.rmdir()
        return True
    return False


# ---------- HUMAN_REVIEW.md validation ----------

def validate_human_review_sections(cfg: Config, run_id: str) -> list[str]:
    """Return missing-heading error strings. Empty list = file is acceptable.

    Required headings are matched literally (case-sensitive, leading "## ").
    Section bodies are not parsed in this pass — see TODO §1c.
    """
    p = human_review_path(cfg, run_id)
    if not p.exists():
        return [f"HUMAN_REVIEW.md not found at {p}"]
    text = p.read_text()
    missing: list[str] = []
    for heading in REQUIRED_HUMAN_REVIEW_HEADINGS:
        if heading not in text:
            missing.append(f"HUMAN_REVIEW.md missing required heading: {heading!r}")
    return missing


# ---------- internal file utilities ----------

def _move_file_if_present(src: pathlib.Path, dest: pathlib.Path) -> None:
    if not src.exists() or src.is_dir():
        return
    if dest.exists():
        # Already promoted in a prior hook call. Leave the destination alone;
        # remove the stale source if it somehow exists alongside.
        if src.resolve() != dest.resolve():
            src.unlink()
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dest))


def _move_tree_if_present(src: pathlib.Path, dest: pathlib.Path) -> None:
    if not src.exists() or not src.is_dir():
        return
    if dest.exists():
        return  # already promoted
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dest))

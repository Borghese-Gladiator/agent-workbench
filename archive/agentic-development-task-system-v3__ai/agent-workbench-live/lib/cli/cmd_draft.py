"""draft subcommand.

Two modes:
  --init   : verify status=draft and stage templates/answers.md at the run root.
             (LLM body of /draft then either fills answers.md or deletes it.)
  default  : transition draft -> shaping. Passes answers_path evidence iff
             answers.md exists at the run root.

The CLI itself does not ask questions; the /draft slash command owns the
LLM-bearing decision of whether material intent ambiguity exists. This CLI
exists so the transition cannot be silently skipped: every run that reaches
shaping went through `agent-workbench draft <run_id>` (default mode), which
means an agent considered the raw idea and either captured clarifications in
answers.md or explicitly chose not to.
"""
from __future__ import annotations

from lib import metadata, events, transitions, locks, stub_llm
from lib.cli._common import actor_from_env, fail, load_config


HELP = "Begin draft (--init) or finalize the draft (default)."


def register(p) -> None:
    p.add_argument("run_id")
    p.add_argument("--init", action="store_true",
                   help="Stage templates/answers.md at the run root. No transition.")


def run(args) -> int:
    cfg = load_config(args)
    actor = actor_from_env("agent")
    run_id = args.run_id

    try:
        meta = metadata.load(cfg, run_id)
    except metadata.MetadataError as e:
        return fail(str(e), 2)

    rd = metadata.run_dir(cfg, run_id)
    raw_idea = rd / "raw-idea.md"
    answers = rd / "answers.md"

    if args.init:
        if meta["status"] != "draft":
            return fail(f"--init requires status=draft, got {meta['status']!r}", 2)
        # Stage answers.md from the template. The slash command will either
        # fill it in (when questions are asked) or delete it (when not).
        src = cfg.root / "templates" / "answers.md"
        if not answers.exists():
            answers.write_text(src.read_text() if src.exists() else "# Answers\n")
        events.append(
            cfg, run_id, "ArtifactWritten",
            payload={"artifact_key": "answers", "path": str(answers), "summary": "template staged"},
            actor=actor,
        )
        # Stub-LLM mode: if the env var is set, materialize the fixture's
        # canned answers.md (if present in the fixture). The stub fixture may
        # legitimately omit answers.md for "no questions needed" scenarios;
        # in that case the slash command (or the test harness) is responsible
        # for removing the template before the finalize step.
        try:
            fix = stub_llm.fixture_dir_from_env()
        except stub_llm.StubLLMError as e:
            return fail(str(e), 2)
        if fix is not None:
            stub_llm.materialize(rd, "draft", fix)
        print(f"{run_id}: draft (--init); answers template at {answers}")
        return 0

    # Default: draft -> shaping.
    if meta["status"] != "draft":
        return fail(f"default mode requires status=draft, got {meta['status']!r}", 2)
    if not raw_idea.exists() or not raw_idea.read_text().strip():
        return fail(f"raw-idea.md missing or empty at {raw_idea}", 2)

    evidence: dict = {"raw_idea_path": str(raw_idea)}
    if answers.exists() and answers.read_text().strip():
        evidence["answers_path"] = str(answers)

    try:
        with locks.acquire(cfg, run_id):
            transitions.transition(
                cfg, run_id, "shaping",
                evidence=evidence,
                actor=actor,
            )
    except transitions.TransitionError as e:
        return fail(str(e), 4)

    if "answers_path" in evidence:
        print(f"{run_id}: draft -> shaping (with answers.md)")
    else:
        print(f"{run_id}: draft -> shaping (no clarifications)")
    return 0

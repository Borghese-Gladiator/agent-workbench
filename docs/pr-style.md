# PR style — the house rules for workbench-authored PRs

The workbench delivers PRs through `packages/github` (`derivePrTitle` / `renderPrBody` /
`renderQaMediaSection`). This is the reference those renderers are held to. The mechanizable rules
are enforced by `pr-content.test.ts`; the rest is guidance for anyone touching the templates.

Source: distilled from the `/pr-draft` skill + the live PRs that surfaced TASK-39/40/41
(`browser-games__ai#7`/`#8`).

## Titles

A good title is a **short sentence describing the change**, not the whole prompt.

- **No `[AWB]` / bot prefix in the title.** GitHub already shows the author; a tag in the
  title is noise. (This is title-scoped — message *bodies* carry a signature, see Body below.)
- **Drop the scope when it's just the repo name.** GitHub shows the repo, so
  `Wip-Browser-Games: add a note` is redundant — use the bare action, `Add a note`. Keep a scope
  only when it names a *sub-area* (`Portal header: show the game count`).
- **≤ 72 characters**, truncated on a **word boundary**, never mid-token. `…how many ga…` reads as
  broken; `…how many games…` (or a clean trim before "games") reads as intentional.
- **Sentence case**, imperative where natural (`Add`, `Fix`, `Wire`), no trailing period.

| Prompt | ❌ Before | ✅ After |
| --- | --- | --- |
| "In wip-browser-games, add a one-line note to README.md…" (repo `wip-browser-games`) | `Wip-Browser-Games: add a one-line note to README.md stating how many ga…` | `Add a one-line note to README.md stating how many games…` |
| "In the portal header, show the number of available games…" | — | `Portal header: show the number of available games` |

## Branch names

`resolveTaskBranchName` → `awb/<action-slug>-<shortId>`.

- **Strip the `In <scope>,` preamble** before slugifying — slug the *action*, not the raw prompt.
  `awb/in-wip-browser-games-add-a-one-line-note-…` ❌ → `awb/add-a-one-line-note-…` ✅.

## Body

Three sections, rendered by `renderPrBody`: **Background** (the why / objective), **Changes** (plan
summary + touched files), **Test plan** (evidence rows).

- **Don't restate the whole prompt in Changes.** Background carries the objective; Changes is the
  plan summary + the file list, not a paragraph re-narrating the request.
- **No unrendered markdown.** Tables, code fences, and image/link markdown must actually render on
  GitHub — verify links resolve.
- **Evidence, not a matrix comment.** The Test plan folds the evidence in as readable rows
  (`✅ **unit-test** — …`); there is no separate "evidence matrix" comment.
- **Keep the footer honest.** The `candidate <sha>` footer is provenance, not decoration.
- **Every posted message opens with the signature.** `renderPrBody` (and every other message the
  workbench posts — the QA-media comment, the QA prerelease body) leads with a bold
  `**Claude Code says**` line, via `withClaudeCodeSignature` in `pr-content.ts`. This is a message
  body attribution, deliberately distinct from the no-tag-in-the-title rule above; titles are never
  signed. An empty body stays empty (no bare, contentless signature).

## QA media

Rendered by `renderQaMediaSection` as one consolidated comment — also signature-led (see Body).

- **Recording embeds as an inline GIF.** GitHub renders an animated GIF via image markdown but does
  **not** play a committed `.webm` on its blob page. Embed
  `![Browser QA recording](raw…/recording.gif)` as the primary artifact; keep the WEBM as a
  secondary `Full recording (WEBM)` link (full fidelity, downscale-free).
- **Screenshots** embed inline via the raw URL.
- **Playwright traces** have no in-browser viewer — link the release-asset download + the
  `npx playwright show-trace` hint.

## What NOT to do (checklist)

- ❌ `[AWB]` or any bot prefix in the title.
- ❌ A `Repo-Name:` scope prefix when the scope is the target repo.
- ❌ Mid-word `…` truncation.
- ❌ Title over 72 characters.
- ❌ Restating the entire prompt inside the Changes section.
- ❌ A separate non-actionable "evidence matrix" comment.
- ❌ Linking a committed `.webm` as if GitHub will play it inline (it won't) — embed the GIF.

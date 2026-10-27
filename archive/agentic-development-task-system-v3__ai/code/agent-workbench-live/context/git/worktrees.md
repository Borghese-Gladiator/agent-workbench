# Git: worktrees

Applies when: creating, entering, or cleaning up a `git worktree`.

Do:

- Place worktrees under `~/GitHub/LOCAL_worktrees/<branch>/` (or the repo-local equivalent). Keep the active checkout clean.
- `pwd`, `git branch --show-current`, and `git status --short` before any Git op inside a worktree. They cost nothing and prevent foot-guns.
- Name the worktree directory after the feature branch (no spaces, kebab-case).
- One worktree per feature branch. Delete the worktree when the branch is merged or abandoned.
- Push from the worktree, not the main checkout — branch tracking is local to the worktree.
- Clean up with `git worktree remove`; let Git delete the directory and prune the registry.

Do not:

- Do not nest a worktree inside another repo's working tree.
- Do not `rm -rf` a worktree directory directly; you'll leak entries in `git worktree list`.
- Do not switch branches inside a worktree with `git checkout`; that defeats the point.
- Do not leave stale worktrees around — they fragment context and confuse the next session.

Commands:

```bash
pwd
git branch --show-current
git status --short

git worktree add -b agent/<slug> ~/GitHub/LOCAL_worktrees/<branch>/<slug> <base-ref>
git worktree list
git worktree remove ~/GitHub/LOCAL_worktrees/<branch>/<slug>
```

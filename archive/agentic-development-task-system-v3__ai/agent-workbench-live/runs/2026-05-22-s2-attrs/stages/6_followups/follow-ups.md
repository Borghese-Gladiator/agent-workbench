# Follow-ups

---
title: Wire CHANGELOG.md alongside version.txt
motivation: A version file with no changelog is half a release convention. The next time someone bumps `version.txt`, they'll want a place to record what changed without inventing one ad hoc.
suggested_scope: Add `CHANGELOG.md` at the repo root with one `## 0.0.1` entry. No automation, no formatter — one file, hand-edited.
category: scope_extension
---

Trivial scope, future-proof.

---
title: Decide version-bump policy before the second bump
motivation: Right now there's no rule for when to bump major/minor/patch. The first time two contributors disagree, the discussion is more expensive than the rule.
suggested_scope: Add a `## Versioning` section to README.md naming semver. One paragraph; no enforcement.
category: docs
---

---
title: `version.txt` is read by nothing — confirm before adding a reader
motivation: If a future packaging step starts reading `version.txt`, the trailing newline + encoding suddenly matter. Today they don't.
suggested_scope: When the first reader lands, add a tiny `tests/test_version.py` that asserts the parsed value. Until then, no action.
category: bug_risk
---

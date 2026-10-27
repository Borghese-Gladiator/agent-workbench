# Does a `design.md`-style spec improve from-scratch UI output? (TASK-119)

**Verdict: adopt the pattern — as a required, templated artifact. The A/B the ticket asked for was
not run, and this writeup says exactly why and what would settle it.**

## What the ticket assumed, and what is actually true

The ticket states that TASK-99's `build-ui` skill "has no structured design-spec input — it relies
on prompt guidance alone, with no tokens/layout/light-dark spec file feeding generation."

That is **not accurate about the shipped skill.** `.claude/skills/build-ui/SKILL.md:68` already
says:

> Before building more than a tiny one-screen UI, define a small visual system in code or in a
> short `design.md`.

and then enumerates almost exactly the design.md field list: surface and text tokens for light and
dark, one accent color, border color, semantic colors, radius scale, shadow policy, type ramp,
spacing rhythm, max content width, sidebar/header behavior.

So the pattern is already *adopted in spirit*. Re-reading the ticket against the code changes the
question from "would a spec help?" to a narrower and more useful one: **why does an
already-instructed spec not behave like one?**

## The three real gaps

1. **It is optional.** "in code or in a short `design.md`" lets the agent satisfy the instruction by
   scattering values through component code. That is precisely the outcome a spec exists to prevent
   — there is then no single place where light/dark can disagree with itself visibly.
2. **There is no template.** The skill lists fields in prose, so the file's shape is re-invented
   every run. Two runs produce two differently-organized specs, which makes them impossible to
   diff, review, or check.
3. **It is not in the Definition of done.** The done list checks outcomes ("light and dark tokens
   are coherent") but never checks that the artifact which would make them coherent exists.

A spec that is optional, shapeless and unchecked is prompt guidance wearing a filename.

## Why the A/B was not run

The ticket asks to build the same UI twice — once with the current prompt, once with a
design.md-style spec — and compare coherence. That experiment needs **two real UI generations and a
human comparing them**. It is not a thing to assert from a desk, and a fabricated result would be
worse than no result.

**What would settle it:** one from-scratch dashboard built both ways, compared on four falsifiable
checks rather than on taste — (a) count of distinct hex/rgb values outside the token set, (b)
whether every token has a dark value defined in the same place, (c) count of one-off arbitrary
Tailwind values (`[13px]`, `[#f3f4f6]`), (d) whether the type ramp uses more than six sizes. All
four are countable from the diff, which is what makes the comparison worth running at all.

## What shipped here

The actionable half, which does not depend on the A/B: `references/design-template.md`, a concrete
fill-in spec with the exact fields the skill already asks for. The skill now **requires** it for
anything past a one-screen UI, writes it before any component, and checks for it in the Definition
of done.

This is a bounded steal, consistent with how TASK-100 treated the other references: take the
artifact shape, decline the rest. Nothing about generation-time model behavior is claimed.

## Standing decision

If the A/B is later run and shows no measurable difference on the four checks above, the template
still earns its place — a reviewable spec file is worth having for review alone. If it shows a
difference, the requirement is already in place. The experiment can only strengthen the current
position, which is itself a reason not to have blocked on it.

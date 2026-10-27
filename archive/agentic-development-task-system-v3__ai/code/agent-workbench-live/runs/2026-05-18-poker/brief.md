# Brief (V1 — superseded by V2 change request)

> **Status:** V1 was delivered and accepted at `human_review`, then **bounced
> on 2026-05-18** with a change request: add browser UI, online multiplayer,
> and shareable lobby links. The V2 spec lives in [brief-v2.md](./brief-v2.md).
> The V1 engine modules (`cards`, `hand_eval`, `pot`, `betting`) are preserved
> and reused; `io`, `cli`, and the game driver are replaced in V2.
>
> The V1 content below is kept as-is for historical reference and to scope
> what was already shipped.

---

<!--
Code-blind. Do not read the target repo. Convert raw-idea.md (+ answers.md) into
a high-quality spec.
-->

## Goal

Deliver a playable Texas Hold'em poker game for 2-6 players that runs locally
on a single machine. The game must correctly deal cards, walk through betting
rounds, and resolve the winner by standard 5-card hand ranking. The deliverable
is a self-contained command-line / terminal program — no network play, no GUI,
no persistence beyond the current session.

The goal is a *correct* and *complete* single-table poker experience: a player
should be able to sit down with friends sharing a terminal (or play against
simple bots) and reach showdown without the game crashing, miscounting chips,
or awarding the pot to the wrong hand.

## User-facing behavior

A user starts the program with a configuration choice (number of players,
starting stack, blind sizes). The program then loops through hands until the
user quits or only one player has chips:

1. **Setup phase.** The button (dealer position) advances. Small and big blinds
   are posted automatically. Each player is dealt 2 hole cards. When it is the
   current player's turn, the screen clears or otherwise hides other players'
   hole cards before showing the current player's hand (pass-and-play model).
2. **Betting rounds.** Pre-flop, flop, turn, river. On each round the action
   moves clockwise from the player left of the big blind (or left of the
   button post-flop). Each player in turn sees their hand + the community
   cards + the pot + their stack + the current bet to call, and chooses one of
   the legal actions: **fold**, **check** (if no bet to call), **call**,
   **bet** / **raise** (with an amount), or **all-in** (when stack < required).
3. **Community cards.** After pre-flop completes, the flop (3 cards) is dealt;
   then the turn (1 card); then the river (1 card), each followed by its own
   betting round.
4. **Showdown.** If two or more players remain after the river, hands are
   evaluated and the best 5-card hand wins the pot. Ties split the pot.
   If everyone folds to one player before showdown, that player wins
   uncontested (no need to show their hand).
5. **Hand end.** Stacks are updated. Players with zero chips are eliminated.
   The button moves. A new hand begins, or the game ends if ≤1 player remains.

The program must clearly show whose turn it is, what cards are public, and
what the legal actions are, and must reject illegal actions with a clear
message rather than crashing or silently accepting them.

## Acceptance criteria

- [ ] **Deal cards.** A fresh, shuffled 52-card deck deals 2 hole cards to
      each seated player and the 5 community cards (flop, turn, river)
      without duplicates within a hand.
- [ ] **Manage betting rounds.** The program runs pre-flop, flop, turn, and
      river betting rounds in the correct order, with correct turn order,
      blinds posted, and only legal actions accepted. A round ends only when
      all non-folded players have either matched the current bet or are
      all-in.
- [ ] **Determine winner by hand ranking.** At showdown, the program correctly
      ranks the standard 9 poker hand categories (high card, pair, two pair,
      three of a kind, straight, flush, full house, four of a kind,
      straight flush — including royal flush as the top straight flush) and
      awards the pot to the player(s) with the best 5-card hand drawn from
      their 2 hole cards + the 5 community cards. Ties split chips fairly,
      with any odd chip going to the player closest left of the button.
- [ ] **Support 2-6 players.** The program accepts a player count anywhere
      in `[2, 6]` at setup and runs a complete hand for any count in that
      range. Player counts outside that range are rejected at setup, not at
      runtime.

## Non-goals

- **No online / networked play.** Single machine, one process, pass-and-play
  or vs. local bots only.
- **No GUI / graphics.** Terminal output is sufficient. ASCII / unicode card
  representations are fine; no curses-based animation is required.
- **No persistence.** No save/load of game state. Quitting ends the game.
- **No tournament structures.** Blinds do not auto-escalate. No re-buys, no
  multi-table, no ante (just small/big blind).
- **No betting variants beyond no-limit Hold'em.** No pot-limit, limit,
  Omaha, stud, draw, short deck, etc.
- **No side-pot complexity beyond what all-in requires.** All-in correctness
  is required, but exotic multi-way side pot edge cases (3+ simultaneous
  all-ins of different sizes) may be implemented as best-effort rather than
  spec-perfect, as long as no chips are created or destroyed.
- **No AI opponents with meaningful strategy.** If bots are included to fill
  seats, "always call" or "random legal action" is acceptable.
- **No statistics, history, or replay.** Each hand is self-contained.

## Good examples

- A 4-player hand where players A and B see the river, A holds `Ah Kh` with
  community `Qh Jh Th 2c 3d`, B holds `Ad Ks`. A wins with a royal flush;
  B's pair-of-aces is irrelevant. The pot is awarded entirely to A and A's
  stack increases by exactly the pot size.
- A heads-up hand where the small blind player folds pre-flop. The big blind
  wins the pot uncontested and does not need to reveal their cards.
- Two players go to showdown with identical hands (both have a board-played
  straight `Qs Js Ts 9s 8s` with no better kicker available). The pot splits
  50/50; the odd chip (if pot is odd) goes to the player closer left of the
  button.
- A player with 50 chips faces a bet of 200. The legal actions presented
  include "all-in for 50" but do **not** include "call 200". If they go
  all-in, a side pot is created for the excess action between remaining
  players.

## Bad examples

- The deck is reshuffled mid-hand, or the same card appears twice in one
  hand. **Bug.**
- A player with a flush loses to a player with two pair because the
  ranker compared `max(rank)` instead of category first. **Bug.**
- The pre-flop action starts on the small blind instead of the player left
  of the big blind in a 3+ player hand. **Bug.** (Heads-up is the exception
  — pre-flop starts on the button/SB; post-flop on the BB.)
- A player who has folded is still asked for an action on a later street.
  **Bug.**
- Selecting "raise" with an amount less than the minimum legal raise is
  silently accepted. **Bug.** The program should reject illegal raises with
  an error message.
- A 7-player game is accepted at setup, then crashes on the 7th seat.
  **Bug.** Reject at setup.

## Constraints

- **Single-machine, terminal program.** No web server, no GUI toolkit. Runs
  from `python -m ...` (or equivalent) inside a terminal.
- **No external network calls** during a hand. The program is fully offline.
- **No new heavy dependencies.** Standard library + lightweight, well-known
  packages only (the planning phase will choose the language and any small
  utilities). Avoid pulling in a game framework.
- **Deterministic given a seed.** The shuffle must accept an optional RNG
  seed so tests and bug reports are reproducible.
- **Correctness over polish.** A plain text UI that always gets the rules
  right is preferred over a fancy UI that has rule bugs.
- **Testable.** Hand ranking and pot resolution must be unit-testable in
  isolation from the I/O loop.

## Assumptions

- **No-limit Texas Hold'em** is the intended variant. (The raw idea just
  says "poker"; Hold'em is the default modern reading.)
- **Local pass-and-play** on a single terminal is acceptable for V1; the
  raw idea says "local or online" and we are explicitly scoping online out
  as a non-goal.
- **Standard ranking** uses the conventional 9 categories with ace high.
  Ace-low straights (`A-2-3-4-5`, the "wheel") count as a 5-high straight.
- **Blinds** default to small=1, big=2 with starting stack=200 unless the
  user configures otherwise at setup.
- **Bots are optional.** If implementing bots is needed to make 2-6 seats
  usable solo, a trivial "always call / random legal" bot is fine.
- **Pass-and-play hides hole cards** by clearing the screen between players
  on their turn; total privacy (e.g. per-player passphrases) is not
  required.
- **One table, one session.** Multi-table and persistence are out.

## Suggested QA scenarios

1. **Heads-up royal flush.** Two players, fixed seed. Player A holds
   `Ah Kh`, board comes `Qh Jh Th 2c 3d`. Player B holds `Ad Ks`. A must
   win with a royal flush; B's pair of aces must lose. Verify the chip
   delta equals the pot exactly.
2. **Wheel straight.** A player holds `Ah 2c`, board `3d 4s 5h 9c Qd`.
   Verify this is ranked as a 5-high straight, beats high card, loses to
   a 6-high straight.
3. **Heads-up blinds & action order.** In a 2-player hand, pre-flop the
   small blind (button) acts first; post-flop the big blind acts first.
   Verify both.
4. **3+ player blinds & action order.** In a 4-player hand, pre-flop
   action starts on the player left of the BB (UTG). Post-flop, action
   starts on the player left of the button. Verify both.
5. **Walk (everyone folds to BB).** SB folds, anyone else folds, BB wins
   uncontested without showing cards. Verify chip totals and that no
   showdown is triggered.
6. **Split pot, odd chip.** Two players go to showdown with the same
   ranked hand and a pot of, say, 7. Each gets 3; the 4th chip goes to
   the player closer left of the button. Verify exact distribution.
7. **All-in for less.** Player with stack 50 facing a bet of 200 chooses
   all-in. Verify a side pot of 150 (× per remaining caller) is created
   correctly and that the all-in player is eligible only for the main pot.
8. **Minimum raise rejected.** Current bet is 20, min raise is +20
   (to 40). Player tries to raise to 25. Verify the action is rejected
   with an error and the player gets to choose again, no chips moved.
9. **Player count bounds.** Setup with 1 player and with 7 players both
   fail at setup with a clear error. Setup with 2 and 6 both succeed and
   complete a hand.
10. **Folded player skipped.** Player B folds on the flop. On the turn,
    the action skips B entirely; B is never prompted, never charged
    chips, and is not eligible for the pot.
11. **Elimination.** Player C loses their last chip in a hand. Next hand,
    C is no longer in the rotation. Game ends when only one player has
    chips left.
12. **Deterministic seed.** Two runs with the same seed, the same player
    actions, and the same player count produce identical card sequences
    and identical chip outcomes.

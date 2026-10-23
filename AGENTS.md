# AGENTS.md

Guide for humans and coding agents working in this repo. Roadmap and milestone acceptance criteria live in [`docs/PLAN.md`](docs/PLAN.md).

## What this is

A phone-first, real-time multiplayer card game based on Skyjo's mechanics. 2–8 players join a room by code or link with a display name. All art and wording are original.

## Architecture

| Path                   | Responsibility                                                     | Rules                                                                                    |
| ---------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `src/engine/`          | Rules engine: state, actions, scoring, view projection, seeded RNG | Pure and deterministic. Imports only `./…`. No `Math.random`, `Date`, DOM, or Node APIs. |
| `src/client/`          | React UI (hot-seat and online)                                     | Renders `GameView`, sends actions. Never decides rules.                                  |
| `src/server/room.ts`   | Room: seats, protocol, reconnection, stall guard                   | Platform-agnostic. Runs the engine; is the only authority.                               |
| `src/server/worker.ts` | Cloudflare Worker + Durable Object adapter                         | Thin.                                                                                    |
| `src/server/node.ts`   | Self-host adapter (Node + `ws`)                                    | Thin.                                                                                    |
| `e2e/`                 | Playwright tests                                                   | Mobile (iPhone, Pixel) and desktop projects.                                             |
| `scripts/`             | Local-only tooling (e.g. art generation)                           | May read `.env`. Never runs in CI.                                                       |

Data flow: client sends an `Action` → server calls `apply(state, action)` → server broadcasts `toView(state)`. `GameView` never contains face-down values, deck order, or RNG state. (No player, including the owner, knows their own face-down cards, so the view is the same for everyone.)

Engine API: `createGame(names, seed)`, `apply(state, action)` (throws `RuleError`, never mutates input), `legalActions(state)`, `toView(state)`.

## Commands

| Command             | Does                                             |
| ------------------- | ------------------------------------------------ |
| `npm run dev`       | Dev server                                       |
| `npm run lint`      | Biome lint + format check                        |
| `npm run format`    | Biome autofix                                    |
| `npm run typecheck` | `tsc --noEmit`                                   |
| `npm test`          | Vitest (with engine coverage gate once M1 lands) |
| `npm run build`     | Production build                                 |

CI runs lint, typecheck, test, and build on every PR and on `main`. The job is named `ci` and is a required check.

## Conventions

- TypeScript strict. Biome formatting (2 spaces, double quotes, width 100).
- Tests live next to the code as `*.test.ts`. Rule tests are named with the rule id first: `"R9: removes a column of three equal face-up cards"`.
- Engine state is plain JSON-serializable data. `apply` clones with `structuredClone` and mutates the clone.
- Grid positions are `0–11`, index `row * 4 + col` (3 rows × 4 columns). A removed slot is `null`.
- Prefer deleting code to adding it. No abstractions with one user, no speculative config.
- Never commit `.env` or any secret. `GEMINI_API_KEY` in `.env` is for `scripts/` only.
- Conventional commit messages (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).

## How agents work here

1. **Branch:** `m<N>-<slug>` from `main`. `main` is protected: PRs only, `ci` must pass, linear history, no force-push.
2. **Build test-first** for engine and server code.
3. **Review:** run the `superpowers:requesting-code-review` skill on the branch, fix findings, keep CI green.
4. **PR:** summary, mobile screenshots (Playwright, under `docs/screenshots/m<N>/`), and test results.
5. **Product Owner (PO):** a fresh agent that has not seen the implementation reads `docs/PLAN.md` and the PR, runs the game, plays it through Playwright at a mobile viewport, and scores the rubric in `docs/PLAN.md`. It may edit `docs/PLAN.md`, justifying each change in the PR.
6. **Verdict:** GitHub does not let an account approve its own PR, and the author and PO share the `jack1590` account. So the PO posts a comment review whose first line is `PO VERDICT: APPROVE` or `PO VERDICT: CHANGES REQUESTED`, with inline comments for each requested change. On approve it merges with `gh pr merge --squash`.
7. **Cap:** 3 PO rounds per PR. After that, stop and summarize the open issues for the user.

On this machine the `gh` active account may differ. Run `gh` as jack1590 per command: `GH_TOKEN=$(gh auth token --user jack1590) gh …`.

**Stop and ask the user before:** choosing hosting that needs a credit card, exposing this computer to the internet, or any destructive git operation (force-push, history rewrite, deleting branches with unmerged work).

## Rules

The engine implements these exactly. Rows marked _ambiguity_ are places the brief was silent or unclear; the stated default is what the code does. Each rule has at least one test whose name starts with its id.

| #   | Topic          | Rule                                                                                                                                                                                                   |
| --- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | Deck           | 150 cards: −2 ×5, −1 ×10, 0 ×15, 1–12 ×10 each. _Ambiguity: brief gives only the range and total; this is the standard distribution._                                                                  |
| R2  | Deal           | 12 cards per player in a 3 × 4 grid, face down. One card from the deck starts the discard pile, face up.                                                                                               |
| R3  | Initial flip   | Each player chooses 2 of their cards to flip, in any order and at the same time as others. Play starts when everyone has flipped 2. _Ambiguity: brief doesn't say who chooses._                        |
| R4  | Start player   | Highest sum of the 2 flipped cards starts. _Ambiguity: ties go to the lowest seat among the tied. Rounds 2+ use the same rule (the commercial game instead lets the previous round's ender start)._    |
| R5  | Turn order     | Ascending seat index, wrapping. _Ambiguity: direction unspecified._                                                                                                                                    |
| R6  | Draw from deck | The drawn card is visible to everyone. The player either swaps it into any grid position or discards it and flips one face-down card. _Ambiguity: visibility of the drawn card._                       |
| R7  | Take discard   | The taken card must be swapped into a grid position.                                                                                                                                                   |
| R8  | Swap           | The target card, face up or face down, goes face up onto the discard pile.                                                                                                                             |
| R9  | Column removal | After any grid change, a column whose 3 cards are all face up and equal is removed. _Ambiguity: removed cards go onto the discard pile after the swapped-out card, so the column's value ends on top._ |
| R10 | Round end      | When a player ends a turn with no face-down cards (removed slots don't count), every other player gets exactly one more turn in seat order, then the round ends.                                       |
| R11 | Final reveal   | After the final turns, all face-down cards are flipped. _Ambiguity: columns that now match are removed too (literal reading of R9)._                                                                   |
| R12 | Scoring        | Round score is the sum of a player's remaining cards. The ender's score is doubled if it is > 0 and not strictly lower than every other player's round score (ties double).                            |
| R13 | Deck exhausted | _Ambiguity: on drawing from an empty deck, the discard pile except its top card is shuffled into a new deck._                                                                                          |
| R14 | Game end       | After a round in which any total is ≥ 100, the game ends. Lowest total wins. _Ambiguity: ties share the win._                                                                                          |
| R15 | New round      | _Ambiguity: all 150 cards are reshuffled and dealt fresh._                                                                                                                                             |

Invariant (tested): any player whose turn comes has at least one face-down card, so discard-and-flip is always available after drawing from the deck.

# AGENTS.md

Guide for humans and coding agents working in this repo. Roadmap and milestone acceptance criteria live in [`docs/PLAN.md`](docs/PLAN.md).

## What this is

A phone-first, real-time multiplayer card game based on Skyjo's mechanics. 2–8 players join a room by code or link with a display name. All art and wording are original.

## Architecture

| Path                   | Responsibility                                                                              | Rules                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `src/engine/`          | Rules engine: state, actions, scoring, view projection, seeded RNG                          | Pure and deterministic. Imports only `./…`. No `Math.random`, `Date`, DOM, or Node APIs.                                      |
| `src/client/`          | React UI (online rooms; no local mode)                                                      | Renders `GameView`, sends actions. Never decides rules.                                                                       |
| `src/server/room.ts`   | Room: seats, protocol, reconnection, stall guard                                            | Platform-agnostic. Runs the engine; is the only authority.                                                                    |
| `src/server/worker.ts` | Cloudflare Worker + Durable Object adapter                                                  | Thin.                                                                                                                         |
| `src/protocol.ts`      | Wire messages (`ClientMsg`, `ServerMsg`, `RoomView`) and `parseClientMsg`                   | Shared by client and server. Validates shape only; never trusts `seat` from the client.                                       |
| `src/server/node.ts`   | Self-host adapter (Node + `ws`)                                                             | Thin.                                                                                                                         |
| `e2e/`                 | Playwright tests                                                                            | Mobile (iPhone, Pixel) and desktop projects.                                                                                  |
| `src/client/motion.ts` | Card-flight animations: diff two `GameView`s, then FLIP-animate                             | Honors reduced motion. Pure diff (`flightsBetween`) is unit-tested.                                                           |
| `public/`              | PWA manifest (`manifest.webmanifest`) and icons                                             | Generated icons come from `npm run art -- icon`.                                                                              |
| `src/client/sw.js`     | Service-worker template: precache, network-first navigations, inline offline page           | The build (`precacheServiceWorker` in `vite.config.ts`) fills in the file list and a per-build cache name and emits `/sw.js`. |
| `src/client/sound.ts`  | Sound effects: which sounds a view change makes (`soundsBetween`), Web Audio playback, mute | CC0 files in `public/sfx/` (Kenney). Unlocked by the first tap; iOS silent switch respected.                                  |
| `scripts/`             | Local-only tooling (e.g. art generation)                                                    | May read `.env`. Never runs in CI.                                                                                            |

Data flow: client sends an `Action` → server calls `apply(state, action)` → server broadcasts `toView(state)`. `GameView` never contains face-down values, deck order, or RNG state. (No player, including the owner, knows their own face-down cards, so the view is the same for everyone.)

The engine's turn check compares `action.seat` with `state.current`; it is not an identity check. The server must set `action.seat` from the authenticated connection, never from the client payload.

Online flow: the browser opens `/api/rooms/CODE/ws` and sends `hello` with its per-room token from `localStorage` (`src/client/useRoom.ts`). One Durable Object per room code (`RoomDO`) persists `RoomData` on every change and sends each socket its own `RoomView`. Pings (`"ping"` → `"pong"`) are answered by the runtime without waking the object. Their timestamps tell `room.ts` who is still connected, which drives the presence dots, the host stand-in, and the 60 s stall guard.

The Worker has its own tsconfig (`tsconfig.worker.json`, runtime types from `wrangler types`, gitignored). `npm run typecheck` checks both.

Engine API: `createGame(names, seed)` (`seed` is 4 int32s from `crypto.getRandomValues` in real games), `apply(state, action)` (throws `RuleError`, never mutates input), `legalActions(state)`, `toView(state)`.

## Commands

| Command                                                              | Does                                                                                                                         |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                                                        | Dev server                                                                                                                   |
| `npm run lint`                                                       | Biome lint + format check                                                                                                    |
| `npm run format`                                                     | Biome autofix                                                                                                                |
| `npm run typecheck`                                                  | `tsc --noEmit`                                                                                                               |
| `npm test`                                                           | Vitest unit tests with the engine coverage gate (95% lines/branches)                                                         |
| `npm run build`                                                      | Production build                                                                                                             |
| `npm run e2e`                                                        | Playwright on iPhone 13, Pixel 7, Desktop Chrome (builds + previews first)                                                   |
| `npm run screenshots`                                                | Refreshes `docs/screenshots/m<N>/` at iPhone size                                                                            |
| `npm run shots:readme`                                               | Regenerates the README's images and card-flight GIF in `docs/readme/` (needs ffmpeg)                                         |
| `npm run art`                                                        | Regenerates missing card art with Gemini (local only; needs `.env` and ffmpeg)                                               |
| `npm run build:node` / `npm start`                                   | Self-host build / run (Node + `ws`, `127.0.0.1:8787`; `PORT`, and `HOST=0.0.0.0` only to open it to your network on purpose) |
| `SERVER=node npx playwright test e2e/online.spec.ts --project=pixel` | Online suite against the Node server                                                                                         |
| `BASE_URL=https://… npx playwright test …`                           | Run tests against a deployed site (no local server)                                                                          |

CI (`.github/workflows/ci.yml`) runs on every PR and on `main`, as parallel jobs; the first five are required checks:
- `ci`: lint, typecheck, unit tests, build (~1 min).
- `e2e (iphone)`, `e2e (pixel)`, `e2e (desktop)`: Playwright, one device per job, inside the `mcr.microsoft.com/playwright` container (browsers preinstalled). Long full-game play-throughs run on Pixel only; layout, 44px, i18n, reload, and interaction tests run on all three.
- `e2e (node)`: the online suite against the Node self-host server.
- On `main` only: `deploy` (`wrangler deploy` with the repo secrets) then `smoke (live)`, which plays a 2-phone game on the live URL, then `release`: if the tag `v<package.json version>` doesn't exist yet, it creates it and a GitHub Release whose notes are that version's `CHANGELOG.md` section. Deploys are never cancelled mid-run.
- `ci` fails when `CHANGELOG.md` has no section for the `package.json` version.

`@playwright/test` is pinned to an exact version. When bumping it, change the container tag in `ci.yml` to the same version.

## Conventions

- TypeScript strict. Biome formatting (2 spaces, double quotes, width 100).
- Tests live next to the code as `*.test.ts`. Rule tests are named with the rule id first: `"R9: removes a column of three equal face-up cards"`.
- Engine state is plain JSON-serializable data. `apply` clones with `structuredClone` and mutates the clone.
- All user-facing text goes through `t()` from `src/client/i18n.tsx`. Add every new key to `en`, `es` (Latin American Spanish) and `pt` (Brazilian Portuguese); the type checker rejects a missing one. Never hardcode UI strings.
- Grid positions are `0–11`, index `row * 4 + col` (3 rows × 4 columns). A removed slot is `null`.
- Prefer deleting code to adding it. No abstractions with one user, no speculative config.
- E2E runs with `reducedMotion: "reduce"` so clicks never wait on animations; `e2e/motion.spec.ts` opts back in. Playwright never reuses a server it didn't start; set `E2E_PORT` if 4173 is taken. `e2e/table.spec.ts` checks layouts at exact game states through a test-only harness (`e2e/harness.ts` renders them via `window.__SKYJO_TABLE__`, see `App.tsx`).
- Never commit `.env` or any secret. `GEMINI_API_KEY` in `.env` is for `scripts/` only.
- Conventional commit messages (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).

## How agents work here

1. **Branch:** `m<N>-<slug>` from `main`. `main` is protected: PRs only, `ci` must pass, linear history, no force-push.
2. **Build test-first** for engine and server code.
3. **Review:** run the `superpowers:requesting-code-review` skill on the branch, fix findings, keep CI green.
4. **PR:** summary, mobile screenshots (Playwright, under `docs/screenshots/m<N>/`), and test results. Every PR also:
   - bumps `version` in `package.json` (semver: major when it removes or breaks something players relied on, minor for features, patch for fixes);
   - adds that version's section to `CHANGELOG.md`, written for players (CI checks it exists; the `release` job publishes it);
   - keeps `README.md` current, and reruns `npm run shots:readme` when the UI changed, so its images show the current game.
5. **Product Owner (PO):** a fresh agent that has not seen the implementation reads `docs/PLAN.md` and the PR, runs the game, plays it through Playwright at a mobile viewport, and scores the rubric in `docs/PLAN.md`. It may edit `docs/PLAN.md`, justifying each change in the PR. It also owns **delivery health**: CI wall time, flaky or timing-out jobs, slow test suites, slow dev loop. When it finds a bottleneck it acts (requests a change or adds a PLAN item) with the measured numbers. It checks the PR's version bump, CHANGELOG section and README (text and images) against what the PR changed; a stale or missing one is a requested change. It also owns **game feel**: it plays like a group of friends would and proposes what players would expect even when the plan is silent (sound, haptics, readable opponents, juice), as requested changes or PLAN items.
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

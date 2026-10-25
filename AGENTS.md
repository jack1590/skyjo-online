# AGENTS.md

Guide for humans and coding agents working in this repo. Roadmap and milestone acceptance criteria live in [`docs/PLAN.md`](docs/PLAN.md).

## What this is

A phone-first, real-time multiplayer card game based on Skyjo's mechanics. 2–8 players join a room by code or link with a display name. All art and wording are original.

## Architecture

| Path                   | Responsibility                                                                              | Rules                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `src/engine/`          | Rules engine: state, actions, scoring, view projection, seeded RNG                          | Pure and deterministic. Imports only `./…`. No `Math.random`, `Date`, DOM, or Node APIs.                                      |
| `src/client/`          | React UI (online rooms; no local mode)                                                      | Renders `GameView`, sends actions. Never decides rules.                                                                       |
| `src/server/room.ts`   | Room: seats, protocol, reconnection, turn clock and Auto-play                               | Platform-agnostic. Runs the engine; is the only authority.                                                                    |
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

Online flow: the browser opens `/api/rooms/CODE/ws` and sends `hello` with its per-room token from `localStorage` (`src/client/useRoom.ts`). One Durable Object per room code (`RoomDO`) persists `RoomData` on every change and sends each socket its own `RoomView`. Each `put` and each `setAlarm` is a row written, the free plan's tightest quota, so `Room.receive` returns a `Change`: `"data"` writes and tells everyone, `"view"` only tells everyone, `"none"` answers only the sender. The alarm only ever moves earlier, since an early one just checks again; any new `setAlarm` call must keep `alarmAt` in step. Pings (`"ping"` → `"pong"`) are answered by the runtime without waking the object. Their timestamps tell `room.ts` who is still connected, which drives the presence dots, the host stand-in, and the turn clock.

Quiet rooms (SEC-9). Presence is read fresh from those timestamps at every event, but a dot or the host stand-in only changes on screen when something re-broadcasts. So `nextAlarm` schedules a presence check (a row and a request) for when a connected seat would turn stale, but only within `QUIET_MS` (10 min) of the last client message (`heard()`); after that, one check every 10 min. Clock and Auto-play due times are never slowed. A forgotten room with 2 tabs then costs about 160 rows a day instead of about 2,160 (`worker.test.ts`). The last client message is the latest of `RoomData.updatedAt` and each live socket's `Conn.heardAt`: a hello writes no row, but its time survives hibernation in the attachment. So any message, a hello too, restores the 45 s checks and counts toward the 24 h idle clock. A client shown offline in a view while its page is visible says `hello` once (`useRoom.ts`), since a network stall its socket survived ends with pings the room never sees; hidden pages leave it to `wake`, or a throttled background tab would keep a forgotten room busy.

Turn clock and Auto-play (M8). The server is the clock; clients only draw it. `RoomData.turnSince` starts at the deal, at each turn's start and when a seat unticks Auto-play on its turn; `waitSince` is the last move. A waited-on seat (`awaited()`: the current player, or everyone still flipping) is due at `turnSince + TURN_MS` (30 s, in `protocol.ts`), and in the place phase never before `waitSince + GRACE_MS` (10 s), online or not. When it's due, `tick()` plays `autoMove` for it and sets `Seat.auto`. A seat on Auto-play is due `AUTO_FIRST_MS` (2 s) into its turn, then `AUTO_NEXT_MS` (1.2 s; slower and an auto turn would cost an IP more of its budget than a human turn, PO in PR #17) after the last move. `tick()` plays one step per due seat, so each draw and placement is its own broadcast and alarm. All of it runs for a seat only while a seated player is connected to pay for it (`canStall`; each step is an alarm, charged to the room's IPs): another seat, on Auto-play or not, or the seat itself while it's on Auto-play. Spectators don't count, a player thinking alone has no clock, and a table with nobody connected schedules nothing but its idle expiry. When no connected seat is off Auto-play, `tick()` passes `mayEnd` to `autoMove`, which may then turn over a seat's last face-down card, so a table where everyone is on Auto-play plays each round to its summary; the summary waits for a tap on Next round (BUG-1, v2.1.1; before it, such a table froze). Auto steps are deadlines, not presence checks: a slower presence-check cadence (SEC-9) must not delay them. A stopped clock (nobody there to pay for it) starts afresh, a full 30 s, once someone is (`resume`, run by `receive` and `tick`). Stopped seats are saved in `RoomData.stopped`, because a phone can come back by pings alone, which the room only sees at the next event from anyone; without it that event auto-played whoever was thinking alone (M8's ping-only return, fixed in 2.1.2). A phone back from the background says `hello` rather than ping, so the room hears it at once. Only the seat itself can tick or untick Auto-play (`{ t: "auto", on }`); unticking on your turn restarts the clock once per move, so toggling can't hold a turn open. A host on Auto-play counts as away for `canLead`, and `start` clears every seat's Auto-play. `RoomView.clocks` (not `wait`, which tabs loaded before 2.1.0 misread) lists every waited-on seat whose clock runs, with `inMs` and a `reason` (`timer`, `offline` or `auto`). The client turns `inMs` into a deadline once and draws the bar and rings as one CSS animation each, with a negative delay, re-rendering only for the seconds in the last 10. At 5 s the acting player's phone vibrates and ticks once per turn (`nudge` in `sound.ts`; `public/sfx/tick.mp3` is generated, not Kenney's).

Per-IP limits (SEC-1, SEC-4, SEC-10, SEC-11). Each client address, IPv4 as is and IPv6 by its /64 (`ipKey` in `room.ts`), gets three ratelimit bindings a minute (`wrangler.jsonc`; `room.test.ts` checks the numbers):
- `API_REQUESTS`: 30 of any `/api` request, checked at the top of the Worker's `fetch` before any Durable Object is touched. 8 phones on bad Wi-Fi peak at about 22 (`e2e/flaky.spec.ts`, run with `MEASURE=1`);
- `ROOM_CREATION`: 10;
- `MESSAGES`: `IP_MESSAGES_PER_MINUTE` (120) units, the one budget for every row an address makes us write, across all its sockets and rooms (`spend` in `worker.ts`):
  - a message costs 1 (pings don't count), plus 1 if its `commit` moves the alarm earlier; a close event pays that 1 too, and otherwise writes nothing (the seat's last sign of life stays in memory). The last socket out also pays 2 when an alarm earlier than the room's expiry is still armed, since that run finds no address in the room to charge (SEC-13);
  - each alarm run costs 2, a row and a DO request, charged to every address with a live socket in the room, since a lobby whose sockets only ping re-checks presence (every ≤ 45 s, then every 10 min once quiet). Each Auto-play step is an alarm run too, one that also saves the room (2 rows), so an auto turn costs 4: 4 rows and 2 DO requests. With 7 seats on auto-play and one player tapping every second on one IP (plus each away phone's wake `hello`), the busiest minute is 86, under 0.75 of the budget; a 2-seat table with both on Auto-play costs each connected IP 76 (`worker.test.ts`);
  - a new room costs 3, spent in `RoomDO.create`, where the room's other charges are counted (ratelimit counts are per location).

  Past the budget, the address's socket (or, at an alarm, all its sockets in that room) is closed with 1008 (`CLOSE_TOO_MANY`), and the client retries every 20 s. The socket attachment keeps the address's key through hibernation.

One address at every limit then needs at least 14 h to use up the rows and 18 h for the DO requests, whether it holds rooms, spams, connects and leaves, or leaves games mid-turn and comes back (`holdRooms` in `worker.test.ts`; the last of these took 12.2 h before the last socket out paid for its alarm). Any new event that writes a row must charge whoever caused it: an alarm that runs after everyone left has nobody to charge, so whoever left it armed pays when they leave.

Socket cap (SEC-2, SEC-6). A room takes `MAX_SOCKETS` (20) sockets that said hello, and a socket keeps the token of its first hello: `receive` rejects a hello with another token (`bad-message`), or a socket could be admitted as one seat and move to another. `Room.admit`, run by both adapters at a socket's first hello, decides in a full room:
- a `dead` socket (unseen for 2 × `STALE_MS`) goes first, closed with 1001 so a frozen phone just reconnects;
- then any token takes the place of its own least recently seen socket;
- without one, a spectator gets `{ t: "full" }` and is closed with 4029 (`CLOSE_ROOM_FULL`). The client treats that as final (`status: "full"`), like a missing room;
- a seated token always gets in, in place of the least recently seen spectator, or over the cap when there's none: one extra socket at most per seat with no socket left.

Whoever is displaced, unless dead, gets the same `full` and 4029.

A socket that hasn't said hello within `HELLO_MS` (10 s from `Conn.openedAt`) gets no broadcast, doesn't count, and is shut (1000) at the room's next event: the Worker's `live()` sweeps on every event, Node on each new connection. There is no timer, since a pending one keeps the object from hibernating and an alarm per socket would be a row. On local workerd, a socket that never sent a frame only receives that close 10 s later (when the object goes idle) or 30 s later (while it stays awake); one that sent any frame gets it at once (`e2e/online.spec.ts`). Dropped sockets are marked `shut` (Worker) or removed from the room's map (Node) before their close, so they stop counting at once and their close writes nothing.

The `MESSAGES` check awaits a binding, which, unlike storage, lets other events in, so `RoomDO` runs every event (message, close, alarm, upgrade, create) one at a time through `serial`. The counts are per Cloudflare location and approximate. Our own 429 still costs a Worker request; only a WAF rule saves those. A local run (dev, E2E) is not limited: that takes both the hostname `localhost` and a loopback `cf-connecting-ip`, which miniflare sets to `127.0.0.1`. On Cloudflare neither holds, since it only routes our own hostname to the Worker and sets the real client address. Open `http://[::1]:<port>` to try the limits locally. Node applies `MESSAGES` itself (`allowIp`). There, a direct loopback client isn't limited, and behind a local proxy such as `cloudflared` the forwarded `cf-connecting-ip` counts. Any E2E bot on the live site must stay under 120 messages a minute from its runner.

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
- `e2e (iphone)`, `e2e (pixel)`, `e2e (desktop)`: Playwright, one device per job (iPhone with 4 workers: WebKit is the critical path, and CPU contention between its workers, not the app, is what makes it slow), inside the `mcr.microsoft.com/playwright` container (browsers preinstalled). Long full-game play-throughs run on Pixel only; layout, 44px, i18n, reload, and interaction tests run on all three.
- `e2e (node)`: the online suite against the Node self-host server.
- On `main` only: `deploy` (`wrangler deploy` with the repo secrets) then `smoke (live)`, which plays a 2-phone round on the live URL (a whole game at bot speed would trip the per-IP message limit), then `release`: if there is no GitHub Release `v<package.json version>` yet, it creates the tag and the Release whose notes are that version's `CHANGELOG.md` section. Deploys are never cancelled mid-run.
- `ci` fails when `CHANGELOG.md` has no section for the `package.json` version.

`Health` (`.github/workflows/health.yml`, SEC-8) runs hourly at :17 on `main`, and on a PR that changes it. It loads the live page (a static asset, free) and creates one room, so it fails when the day's Worker requests, Durable Object requests or rows written are used up, and GitHub emails the owner. Its error says which: 1027 or Cloudflare's 429 (Worker quota), a 5xx (Durable Object or storage), our own `Too many …` 429 (a per-IP limit, not a quota), or no page (site down). It costs 24 Worker requests, 48 Durable Object requests and 72 rows a day. To see a failure, run it by hand with another URL to POST: `gh workflow run health.yml -f api=https://httpbin.org/status/429`.

`@playwright/test` is pinned to an exact version. When bumping it, change the container tag in `ci.yml` to the same version.

## Conventions

- TypeScript strict. Biome formatting (2 spaces, double quotes, width 100).
- Tests live next to the code as `*.test.ts`. Rule tests are named with the rule id first: `"R9: removes a column of three equal face-up cards"`.
- Engine state is plain JSON-serializable data. `apply` clones with `structuredClone` and mutates the clone.
- All user-facing text goes through `t()` from `src/client/i18n.tsx`. Add every new key to `en`, `es` (Latin American Spanish) and `pt` (Brazilian Portuguese); the type checker rejects a missing one. Never hardcode UI strings.
- Grid positions are `0–11`, index `row * 4 + col` (3 rows × 4 columns). A removed slot is `null`.
- Prefer deleting code to adding it. No abstractions with one user, no speculative config.
- E2E runs with `reducedMotion: "reduce"` so clicks never wait on animations; `e2e/motion.spec.ts` opts back in. E2E phones (`phones()` in `e2e/helpers.ts`) also hide Web Audio, because a running `AudioContext` makes headless WebKit slow enough to time out; `e2e/sound.spec.ts` opts back in with `audio: true`. Playwright never reuses a server it didn't start; set `E2E_PORT` if 4173 is taken. `e2e/table.spec.ts` checks layouts at exact game states through a test-only harness (`e2e/harness.ts` renders them via `window.__SKYJO_TABLE__`, see `App.tsx`). The harness also takes `auto` and `wait`; clock tests freeze the page's clock (`page.clock`) and step it with `runFor` instead of waiting. No E2E waits on the real 30 s turn clock: test Auto-play by ticking the switch. A bot that leaves a seated player idle for 30 s mid-game gets that seat put on Auto-play, and `botStep` then stops acting for it; any test that idles a seated player for more than 10 s asserts what Auto-play does.
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

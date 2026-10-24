# Skyjo Online — Plan

Living roadmap. The Product Owner (PO) agent may add, reorder, or cut milestones; every change to this file must be justified in the PR that makes it.

## Goal

A free, phone-first web game based on Skyjo's mechanics. Friends open a link, pick a display name, and play 2–8 players in real time. No accounts.

**Definition of done:** a public URL where 2–8 people on phones can create or join a room and play a full game to 100 points without errors. All rules are covered by tests, CI is green, and the README explains everything.

## Architecture

One npm package (no monorepo tooling). Four areas:

| Path                   | What                                                                                         | Runs on                  |
| ---------------------- | -------------------------------------------------------------------------------------------- | ------------------------ |
| `src/engine/`          | Pure, deterministic rules engine. No DOM, no Node APIs, no `Math.random`/`Date`. Seeded RNG. | client + server          |
| `src/client/`          | React app (online rooms; the local mode was removed in M6)                                   | browser                  |
| `src/server/room.ts`   | Platform-agnostic room: seats, protocol, reconnection, view projection                       | server                   |
| `src/server/worker.ts` | Cloudflare Worker + Durable Object adapter around `room.ts`                                  | Cloudflare               |
| `src/server/node.ts`   | Self-host adapter (Node + `ws`) around `room.ts`                                             | this computer (fallback) |
| `e2e/`                 | Playwright tests                                                                             | CI + local               |
| `scripts/gen-art.ts`   | Card/icon art generation via Gemini                                                          | local only               |

**Server is authoritative.** Clients send intents (`draw`, `swap`, ...). The server validates them with the engine, then sends each client a projected view. Face-down card values and deck order never leave the server.

**Hosting:** Cloudflare Workers free plan: static assets, one Worker, and one SQLite-backed Durable Object per room using hibernatable WebSockets. App and WebSocket share one origin. No credit card needed (verify at M4).

**Dev loop:** `@cloudflare/vite-plugin` runs the Worker and Durable Object inside the Vite dev server, so `npm run dev` is the whole stack.

### Tech choices and deviations from the brief

- **Workers static assets instead of Pages.** Same free tier, one deploy, one origin for app and WebSocket. Cloudflare now recommends this path for new projects.
- **Direct Durable Objects instead of PartyKit.** PartyKit runs on Durable Objects anyway; going direct removes a layer and a vendor.
- **Biome instead of ESLint + Prettier.** One dependency for lint and format.
- **The browser's Web Animations API** for card motion (FLIP in `src/client/motion.ts`). No animation library and no PixiJS. M5 tried `motion` (Framer Motion) and dropped it (PO, M5 review: this line still named it).
- **No router or state library.** `/r/:code` is parsed by hand; state is the server's room snapshot.
- **Hand-written message validation.** The protocol has fewer than 10 message types.
- **A hand-written service worker** instead of `vite-plugin-pwa`. `src/client/sw.js` is a template; a small plugin in `vite.config.ts` fills in the build's precache list and a per-build cache name. The manifest is the static `public/manifest.webmanifest` (PO, M5 review).
- **npm** (pnpm is not installed here).
- **Art via Gemini image generation.** `npm run art` reads `GEMINI_API_KEY` from the local `.env` (gitignored) and writes optimized WebP files that are committed. The key is never used in the client, CI, or repo. Generated: card back, face textures per value band, table background, logo, and PWA icons. Card numbers are rendered in CSS so they stay crisp. Prompts never mention Skyjo or imitate its official art.

## Rules spec

The canonical rule list (R1–R15), including every default chosen where the brief is silent, lives in [`AGENTS.md` § Rules](../AGENTS.md#rules). Each rule has a named test.

## Multiplayer behavior

- **Create:** server issues a 5-character code from an unambiguous alphabet (no 0/O/1/I). Share link `/r/CODE` uses the Web Share API with a copy fallback.
- **Join:** display name, 1–16 characters. The lobby shows seats. The host (first seat) starts once 2–8 players have joined. If the host leaves the lobby, the next seat becomes host.
- **Identity:** a random token in `localStorage`, per room. Reconnecting with the same token reclaims the seat. Tokens are never broadcast.
- **Spectators:** anyone joining a full room (8) or a game in progress sees the public view. They can take a free seat in the lobby. Joining, leaving, and removing seats happen only in the lobby, so seat order always matches the game.
- **Reconnection:** the client auto-reconnects with backoff and shows a "Reconnecting…" banner. The server sends a full snapshot on reconnect. Seats are held for the whole game.
- **Stall guard:** if the current player has been disconnected for 60 s, the server plays a default move: draw from deck, discard, flip the first face-down card in reading order. During the initial flip (R3) there is no current player and everyone must flip, so any seat disconnected for 60 s with fewer than 2 cards up gets its first face-down cards flipped in reading order.
- **Next round:** the engine's `nextRound` carries no seat, so the room decides who may send it: the host advances from the round summary; if the host is disconnected, any seated player can.
- **Persistence:** room state is written to Durable Object storage on every change, so eviction loses nothing. Idle rooms are deleted after 24 h via an alarm.
- **Rematch:** after game over, the host's **Play again** returns everyone to the lobby with the same seats. Late arrivals join there, and the host can remove offline (ghost) seats. Then the host starts. Each deal (every start and every new round) gets fresh CSPRNG entropy.

## Milestones

Each milestone is one PR from a feature branch `m<N>-<slug>`, except M0.

### M0 — Bootstrap (direct to `main`; the only non-PR commit)

- Public repo `jack1590/skyjo-online`, SSH remote.
- `README.md` (stub), `AGENTS.md`, `LICENSE` (MIT), `.gitignore` (includes `.env`), `.editorconfig`, `package.json`, `tsconfig`, Biome, Vitest, this plan.
- CI workflow: lint, typecheck, test, build.
- Branch protection on `main`: PR required, CI check required, linear history, no force-push, no deletion, enforced for admins. Required approvals = 0 (see Process).

**Acceptance:** CI green on `main`. A direct push to `main` is rejected.

### M1 — Rules engine

- `createGame(names, seed)`, `apply(state, action)` (returns a new state, throws `RuleError` on illegal actions), round scoring, `toView(state)` public projection (identical for every viewer, since nobody sees face-down values), and a seeded RNG with 128-bit state.
- Unit tests named after each rule R1–R15.
- Simulation test: 1,000 seeded games, 2–8 players, random legal moves. Checks: 150 cards always accounted for, every game terminates, totals add up, illegal actions are rejected, and projections never leak face-down values.

**Acceptance:** every rule has a named test. Engine coverage ≥ 95% lines and branches. Engine imports nothing outside `src/engine`. Same seed plus same actions gives identical state.

### M2 — Local hot-seat UI

- Screens: Home (new local game, 2–8 names), Table, Round summary, Game over.
- Portrait layout: your grid at the bottom, draw and discard piles in the middle, opponents on top. Full grids for up to 4 players; compact strip for 5 or more.
- Turn banner and phase prompts ("Flip 2 cards", "Draw or take the discard", "Swap, or discard and flip"). Tap only, targets ≥ 44 px, no hover-only actions.
- Art v1 from `npm run art`. Card faces are color-coded by value band.
- Playwright projects: iPhone 13 (WebKit), Pixel 7 (Chromium), Desktop Chrome.
- **Languages** (added at the user's request, 2026-10-23): English, Spanish (Latin America), Portuguese (Brazil). Auto-detected from the browser, switchable on Home, remembered. Applies to every later milestone's UI too.

**Acceptance:** a full hot-seat game to 100 is playable at 390×844 with no horizontal scroll. On all 3 Playwright projects, at least one hot-seat round is played through the UI to its round summary and into the next round (starting from an engine-built near-end game is fine); full play-throughs to 100 run on Pixel only (user request, 2026-10-23). Every UI string exists in all 3 languages (enforced by the type checker), and E2E covers switching and browser detection.

### M3 — Online rooms

- `room.ts`, the Worker and Durable Object adapter, and a client WebSocket hook with reconnect.
- Create and join by code or link, lobby, host start, spectators, reconnect, stall guard (turn and initial-flip phases), next round, rematch.
- Vitest for the room with simulated clients: reconnection, spectators, invalid messages (including non-object payloads: the engine assumes a well-formed `Action` and throws `TypeError` on `null`), hidden information.
- Playwright: 2 players in two browser contexts play a full game to 100 (Pixel). Reload mid-game restores the seat. A 9th joiner becomes a spectator. 8 players in 8 contexts finish a game (Desktop).

**Acceptance:** all the above pass locally and in CI. A test asserts no message to a client contains another player's face-down values.

### M4 — Deploy

Moved ahead of polish (the brief listed it last) so hosting risk is retired early and every later merge is testable on real phones.
- **Stop and ask the user:** Cloudflare account (free plan, no card), API token, and the GitHub secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- CI deploys on push to `main` to `skyjo-online.<subdomain>.workers.dev`. A post-deploy smoke test runs the 2-player Playwright game against the live URL.
- Self-host fallback: `src/server/node.ts` (Node + `ws`, serves `dist/`, rooms in memory). The README documents running it behind `cloudflared tunnel`. It is never exposed without asking the user first, so it listens on `127.0.0.1` unless `HOST` says otherwise; the tunnel needs nothing more. In the M4 review it listened on every interface (LAN, and the internet wherever a global IPv6 address isn't firewalled) (PO, M4 review).
- CI's `concurrency` group cancels in-progress runs. A deploy on `main` must never be cancelled halfway, so `cancel-in-progress` applies to PRs only.

- Rate-limit `POST /api/rooms` per client IP with the Workers Rate Limiting binding (or a WAF rule). Room creation is otherwise unthrottled: each call writes storage and sets an alarm (M3 review).
- A flaky test fails CI: set `failOnFlakyTests` when `CI` in `playwright.config.ts`, so `retries: 1` can no longer turn a flake green. In M3 the 2-phone game failed about 1 run in 4 (the bot tripped the 40-message flood limit), and the retry hid it until the M4 review (PO, M3 review).

**Acceptance:** the public URL works on a real phone. The smoke test passes against it. The Node fallback passes the same E2E locally, and `npm start` listens on `127.0.0.1` only. A test that passes only on retry fails its CI job.

### M5 — Polish, animations, PWA

- Animations: card flip (3D rotate), draw, discard and swap travel, column removal, score count-up. All honor `prefers-reduced-motion`.
- PWA: manifest, generated icons, service worker for the app shell, an offline page explaining the game needs a connection, and an "Add to Home Screen" hint on iOS.
- ~~Art v2 pass~~ **Descoped (author, M5):** the PO scored Visual polish 4 on the v1 card art in M2, M3 and M4 with no art complaints, so M5 spends its polish on motion (card flights, flips, count-up) and the new app icon instead. Revisit if the PO asks for it. **Accepted (PO, M5 review):** the v1 art is original, cohesive and readable, and motion was the bigger gap in visual polish.
- README completed: how to play, run locally, deploy, self-host, install.
- Small phones: at 375×548 the acting player's whole grid is on screen when their turn starts, either because it fits or because it is scrolled into view, and cards stay ≥ 44 px. In M2 the bottom row ended at 592 px with 2 players and at 615 px with 8, so it had to be scrolled to every turn.
- Waiting on an offline player: when the seat the table waits on is offline, everyone sees that it is offline and when the stall guard will move for it (for example "Cris is offline · auto-move in 42 s"). In M3 the table showed only "Waiting for Cris…" and a dimmed tile for the whole 60 s, on every one of that player's turns (PO, M3 review).

**Acceptance:** Playwright verifies the manifest and service worker are installable. Reduced motion disables animations. The README covers every section listed in the brief. At 375×548, Playwright asserts the acting player's grid is fully in view at the start of a turn for 2 and 8 players. Playwright asserts the offline notice and countdown appear when the current player's phone closes. The PO scores visual polish ≥ 4.

### M6 — Online only, sound, readable tables (user request, 2026-10-24)

The user asked for three things after M5: remove the local mode, add effects for flipping and discarding, and make 4–8 player tables great so everyone's cards can be seen. The PO hadn't proposed any of them, because it only checked the plan; "Game feel" is now a rubric row and a standing PO duty.
- Remove the local (hot-seat) mode: Home is online-only. Layout tests use a test-only table harness instead of hot-seat games.
- Sound effects for draw, flip, place, discard, deal, column cleared, your turn, win and game over. CC0 recordings (Kenney), derived from view changes like the card flights. Mute switch, remembered; respects the iPhone silent switch.
- Releases (user request): semver in `package.json`, a player-facing `CHANGELOG.md`, and a GitHub Release published by CI after the live smoke test. Earlier milestones were backfilled as v0.1.0–v1.0.1. Home links to the release notes.
- README with images of the current game (user request), regenerated by `npm run shots:readme` whenever the UI changes.
- Readable opponents at 4–8 players: one swipeable strip with numbers ≥ 12 px, a peek of the next panel, whoever is playing scrolled into view, tap an opponent to see their grid full size; spectators get two columns.

**Acceptance:** No local mode remains anywhere (UI, docs, tests). Every sound fires from a unit-tested view diff, the mute switch persists, and E2E proves sounds start and stop. For 2–8 players at 390×664: no horizontal scroll, every tap target ≥ 44 px, opponents' numbers ≥ 12 px, the active opponent in view, and zoom works (Playwright, all 3 devices). Screenshots for 2, 4, 5, 6, 7 and 8 players in the PR. Version 2.0.0 with its CHANGELOG section; the README shows current images and the live URL. The PO scores Game feel ≥ 4.

### Order after M6 (PO, 2026-10-24)

The user asked for four things on 2026-10-24: a 30 s turn timer that switches a player to auto-play until they untick a checkbox, smooth animations, a UX expert pass shipped step by step, and the PO organizing the work. They ship as M8 → M9 → M10+, after M7 (the iPhone sound fix, already in progress), one PR at a time (see Process). The After-M6 follow-ups are folded in where they fit: the discard-and-flip E2E goes into M8 (auto-play makes that move), the final-reveal hold goes into M9 (it is an animation fix), and the rest join the M10+ triage pool. A security hardening track (SEC, below) was added the same day at the user's request. Its critical and high findings may go ahead of M9.

### M7 — iPhone sound (merged in PR #10, awaiting the user's iPhone) · v2.0.1

Players on iPhone heard no sound. PR #10 unlocks audio the way iOS expects and resumes it when the app comes back from the background, a lock or a call. The ring/silent switch still silences the game.

**Evidence (user, 2026-10-24):** in Chrome on iPhone, v2.0.0 had no sound; after force-closing and reopening Chrome, v2.0.0 played sound. So iOS left the open page's audio context interrupted, or running but silent, after a trip to the background, and v2.0.0's `resume()`-only path never got it back. It is not the silent switch or the standalone-PWA bug.

**Acceptance:** unit tests and the release checklist as usual, plus: after deploy, on the user's iPhone, sound keeps working after switching apps or locking and returning, without restarting the browser. If it doesn't, `/sound-check.html` (hidden, unlinked) shows on the phone which step fails: unlock, decode, the audio session type, or the silent switch (`?session=playback` to compare). If sound dies only after a return, the next fix is to close and recreate the `AudioContext` on the first tap after the page becomes visible again, which does in the page what the browser restart did (PO, PR #10 review).

### M8 — Turn timer and auto-play (user request, 2026-10-24) · v2.1.0

One slow or absent player shouldn't stall the table. After 30 s with no move, the server starts playing for that seat, and keeps doing it until the player unticks **Auto-play**. The server is the authority on the clock; the client only displays it.

Decisions (PO, 2026-10-24), each with its reason:
- **What the 30 s covers:** every step the table waits on a seat: draw, place (swap or discard-and-flip), and the R3 initial flip. Each move restarts the clock (the room's existing `waitSince`), so a player who draws at 29 s still gets 30 s to place the card; a turn takes at most 60 s. In the flip phase, all seats that haven't flipped share the clock and any flip restarts it, so the deal waits at most 30 s after the last flip. The round summary, game over and the lobby have no timer. _Reason: reuses `waitSince`, and a drawn card is never a rushed decision._
- **Who sees the countdown, and when:** for the first 20 s, nobody sees a clock (most steps take less). For the last 10 s, everyone (players and spectators) sees a shrinking bar on the waited-on seat's name tag, and that player's prompt reads "Auto-play in N s". If the seat is offline, the M5 notice stays up for the whole wait ("Cris is offline · auto-play in 24 s"). _Reason: nobody feels rushed while thinking, and the others can see that help is coming._
- **Last-seconds warning:** at 10 s left, the waited-on player's phone plays one short cue (it respects mute and the silent switch) and vibrates once where `navigator.vibrate` exists (iOS Safari doesn't have it). At 5 s the bar turns red. Everyone else gets the visual only. _Reason: one nudge you notice without looking, and no ticking alarm for the whole table._
- **The auto-move:** the stall guard's `autoMove`, unchanged. It draws from the deck, discards that card, then flips the first face-down card in reading order; during the initial flip it flips the first face-down cards. _Reason: the user asked for "like disconnected players"; the move is already tested, neutral, and reveals nothing about the player._ A smarter bot is out of scope; add one only if the PO sees auto-played seats losing badly in play.
- **Pacing once on:** a seat on auto-play makes one move every 1.5 s (`AUTO_STEP_MS`). 1.5 s after its turn begins it draws (everyone sees the card, per R6), and 1.5 s later it discards and flips. When the 30 s run out, the first move is played at once. _Reason: everyone can follow each move and its card flight (≤ 380 ms), and an auto turn still takes only 3 s._
- **The checkbox:** one **Auto-play** checkbox in the header row of your own grid, next to your name and points. Every seated player always has it, and its label is a tap target of at least 44 px. The server ticks it when your 30 s run out, and you can tick it yourself before stepping away. Only you can untick it (the user's request); playing a card yourself doesn't. While it's on, your prompt reads "Auto-play is on · untick it to play" and your grid is marked as auto-play. Unticking during your turn gives you a fresh 30 s. Reconnecting doesn't untick it, so when you come back the ticked box tells you why your cards moved. _Reason: the row already exists, so the checkbox adds no height at 375×548. Ticking it yourself uses the same control, and it lets E2E test auto-play without waiting 30 s._
- **How others see it:** players and spectators see an "Auto" tag next to that player's name on their panel and in the turn pill ("Ana · auto"). _Reason: otherwise a player seems to be moving instantly, and nobody knows why._
- **The 60 s stall guard is folded in.** The turn timer replaces it: whether a seat is offline or not, it gets 30 s from `waitSince` and then goes on auto-play. Delete `STALL_MS` and the deadline rule that counts absence from when the seat went quiet. Keep `canStall` (an empty table doesn't play itself) and the `STALE_MS` presence check. _Reason: one rule and one countdown instead of two, and an offline seat now moves after 30 s instead of 60 s._
- **Leading while on auto-play:** a host on auto-play counts as away, so any seated player may advance to the next round, start a rematch, or start the game. _Reason: the host-away rule only notices a dropped socket, so a host who stepped away with the screen on would freeze the round summary._
- **Spectators** see the countdown and the Auto tags. They have no checkbox and don't affect the timer.
- **No host setting to turn the timer off** (AGENTS: no speculative config). 30 s per step is generous for Skyjo, and a player who times out loses one move and then unticks. Revisit if the user asks.
- **Protocol:** a client message `{ t: "auto", on: boolean }` that applies only to the sender's seat; `Seat.auto`, persisted in `RoomData`; and `SeatView.auto`. `RoomView.wait` now covers every waited-on seat, online or offline, with the ms until auto-play moves for it.
- Lands the After-M6 "Do first" test: an E2E for a full draw → discard → flip turn through the UI.
- Update § Multiplayer behavior (stall guard), `AGENTS.md` (online flow) and the README's how-to-play.

**Acceptance:**
- Room unit tests on the injected clock (`t.advance`), one for each of these:
  - Nothing happens at 30 s − 1 ms. At 30 s, the waited-on seat's move is played and its auto-play is on.
  - Each move restarts the clock: a draw at 29 s leaves the seat until 59 s.
  - In the flip phase, seats that haven't flipped are auto-flipped 30 s after the last flip, and seats that have flipped are left alone.
  - A seat on auto-play makes one move per 1.5 s (a whole turn in 3 s), and `nextAlarm` returns exactly those times.
  - `auto` with `on: false` from the seat stops auto-play and starts a fresh 30 s; `on: true` works for your own seat. Nobody can change another seat's auto-play, since the message carries no seat.
  - An offline seat goes on auto-play after 30 s. When nobody else is connected, nothing plays.
  - While the host is on auto-play, another seat may send `nextRound` and `rematch`.
  - `parseClientMsg` accepts `auto` only with a boolean `on`.
  - The hidden-information test still passes with seats on auto-play.
- Client unit test: the 10 s cue fires once per wait, only on the waited-on player's phone, and never when muted.
- E2E on all 3 devices:
  - Table harness: with 25 s left there is no countdown. At 9 s, the waited-on player reads "Auto-play in 9 s" and the others see the bar on that seat. At 4 s the bar is red. A seat on auto-play shows the Auto tag, and the checkbox is ≥ 44 px.
  - Online, 2 phones: A ticks Auto-play, and within 4 s A's turn plays itself (a draw, then a discard and flip, leaving one fewer face-down card). B sees "Auto" on A. A unticks, and A's next turn waits for A.
  - The discard-and-flip E2E (After M6), on all 3 devices.
  - The existing offline-countdown test, updated to the new wording.
- **Delivery health:** no E2E waits for the 30 s in real time: nothing sleeps on the timer, and no test-only timer setting ships to production. The expiry itself is covered by the room unit tests on the injected clock, and the online E2E reaches auto-play by ticking the checkbox. PR CI wall time grows by ≤ 15 s over the M7 merge, and the PR reports per-job times. No existing E2E starts tripping the timer: any test that leaves a seated player idle for more than 10 s mid-game is listed in the PR and asserts the auto-play.
- Every new string exists in en, es and pt.
- Version 2.1.0 with its CHANGELOG section. The README's how-to-play covers the 30 s and auto-play, with fresh images. `docs/screenshots/m8/` has the countdown, the red warning, the Auto tag, and the ticked checkbox at iPhone size.
- The PO scores Mobile UX ≥ 4 and Game feel ≥ 4.

### M9 — Smooth animations (user request, 2026-10-24) · v2.1.1

The user asked for smooth animations. Every card flight, flip and count-up should run at frame rate on a mid-range phone, start exactly where the card was, and land exactly where it goes. A patch release, unless the UX findings turn it into a feature (then 2.2.0).
- **The diagnosis is pending.** The UX expert's findings (audit started 2026-10-24) name what stutters or jumps, and the PO refines these bullets when they arrive. Until then, the bullets below are the bar.
- Animate only `transform` and `opacity`; layout and paint properties (`top`, `left`, `width`, `height`, `box-shadow`, `filter`) are never keyframed.
- Lands the After-M6 item "Let the final reveal play before the round summary".
- A measuring tool, `e2e/perf.spec.ts`. It runs on Pixel only, with `PERF=1`, and is skipped in CI, because frame timings on shared runners are noise. It throttles the CPU 4× through CDP (`Emulation.setCPUThrottlingRate`), then plays a scripted 8-player sequence with motion on: draw, swap, discard and flip, column removal, the round-end reveal, and the score count-up. It records frame intervals with `requestAnimationFrame` and long tasks with `PerformanceObserver`.

**Acceptance:**
- Perf spec (Pixel, 4× CPU throttle, 8 players, motion on): during flights, the p95 frame interval is ≤ 20 ms, no frame takes more than 50 ms, and there are no long tasks over 50 ms. The PR reports the numbers before (v2.1.0) and after. The PO may move a target if the before numbers show it is wrong; the reason goes in the PR.
- In CI on all 3 devices, deterministic: during each flight, every running animation (`document.getAnimations()`) keyframes only `transform` and/or `opacity`.
- No jump, for each flight type (draw from deck, take the discard, swap, discard, column removal): with the Web Animations paused and stepped through `currentTime`, the flying card's box at time 0 matches its source within 1 px and at the end matches its target slot within 1 px. The card is visible in exactly one place on every frame: never in two places, never missing.
- At round end, the summary sheet appears only after the R11 flips finish (or after about 1 s). With reduced motion it appears at once.
- Reduced motion still disables every animation (existing test).
- CI wall time grows by ≤ 10 s; the perf spec doesn't run in CI.
- Version, CHANGELOG and README per the release checklist.
- Playing with motion on, the PO scores Visual polish 5 and Game feel ≥ 4, or adds whatever keeps Visual polish from a 5 to this plan as an item.

### M10 onward — UX passes (user request, 2026-10-24) · one patch or minor each

The user asked for a UX expert agent to find improvements and ship them step by step, not all at once.
1. **Audit.** A UX expert agent audits the live game: phones, 2–8 players, all 3 languages, players and spectators. It returns findings with evidence (screenshots, measurements, steps to reproduce).
2. **Triage.** The PO puts each finding in the table below with a severity (blocker / major / minor), an effort (S / M / L) and a verdict. A verdict is one of: **do** (with its milestone number), **fold** (into M8 or M9 if one is still open), **defer**, or **decline**. Each verdict gets a one-line reason. The remaining After-M6 follow-ups join the same pool. Triage is a docs-only PR.
3. **Order.** Blockers first, then by value for effort. A blocker may jump ahead of M9, and the PR that changes the order says why.
4. **Ship.** One small PR per finding, or per tight group (same screen, same files), numbered M10, M11, … on branches `m<N>-<slug>`. Each goes through the normal loop: review → PR → PO, plus the release checklist. Fixes and polish are a patch version; anything a player would call new is a minor version.
5. **Acceptance per item** is written at triage time: the finding's evidence, measured again, no longer reproduces, and a test fails without the fix (E2E for layout and interaction, a unit test for logic).
6. **Done** when every finding is shipped, deferred or declined. Another audit runs only if the user asks for one.

| #   | Finding                                                        | Severity | Effort | Verdict |
| --- | -------------------------------------------------------------- | -------- | ------ | ------- |
| —   | _Pending: the UX expert's audit (2026-10-24) is triaged here._ |          |        |         |

### Security hardening (SEC) (user request, 2026-10-24) · one patch each

**Goal:** a bot can't take the service down or ruin other players' games on the free plan. The threats include creating rooms in bulk, flooding sockets, guessing room codes, spamming joins or spectators, griefing games in progress, and burning the Cloudflare free plan's daily quotas (Worker and Durable Object requests, duration, storage writes). What exists today: per-IP room creation is rate-limited (`ROOM_CREATION`), each socket is capped at 120 messages per 10 s, frames over 1000 characters are rejected, and empty rooms expire after 10 min.
1. **Audit.** A security engineer agent probes a **local** server only, never the live URL: abusing the live URL would burn the same free quotas the game runs on. It returns findings SEC-1, SEC-2, …, each with a severity, a proposed fix, an acceptance criterion, and whether it needs a Cloudflare dashboard action.
2. **Triage.** The PO puts each finding in the table below, in the same shape as the UX triage: a severity, an effort (S / M / L), a verdict (**do** with its milestone number, **fold** into an open milestone, **defer**, or **decline**), and a one-line reason. The PO also marks whether it needs the user. Triage is a docs-only PR, and it can share one PR with the UX triage.
   - **Critical:** one cheap client can take the service down for everyone, or use up a daily free-plan quota.
   - **High:** one client can ruin other people's games or rooms, or take one room down.
   - **Medium:** the attack needs sustained effort or many clients, or does limited damage.
   - **Low:** defense in depth.
3. **Order.** Critical and high SEC findings may go ahead of M9 and the M10+ UX passes, the same way UX blockers do; the PR that changes the order says why. Medium and low findings are ordered by value for effort alongside the UX items. Ordering never interrupts an open PR: it is still one PR at a time.
4. **Ship.** One small PR per finding, or per tight group (for example, every per-socket limit). Each takes the next free milestone number, on a branch `m<N>-sec-<slug>`, and the table records which milestone. It goes through the normal loop (review → PR → PO) with the release checklist; a fix is a patch version. Build it test-first: room limits are unit-tested on the injected clock, and Worker routes through the Worker adapter's tests.
5. **Acceptance per item:** the finding's reproduction, run again against a local server, no longer works, and a test fails without the fix. The PR also says how much each blocked attempt still costs on the free plan (requests, storage writes), and confirms that legitimate play is unchanged: the full E2E suite stays green, and no limit trips for 8 friends who share one IP behind a home router.
6. **Needs the user: Cloudflare dashboard changes.** The PO and authors can't make dashboard changes or create secrets. Examples are a WAF or rate-limiting rule, a Turnstile site key and secret, and usage notifications. Each becomes a "Needs the user" item, listed below and in the report to the user, with exact steps: the dashboard path, every field value, the secret's name if one is needed (set by the user with `wrangler secret put` or as a GitHub secret, never committed), and how to verify the change worked. The code half of such a fix merges only after the user confirms the step, or it must work unchanged without it.
7. **Done** when every finding is shipped, deferred or declined, and every "needs the user" step is done or declined by the user.

| #   | Finding                                                                | Severity | Effort | Verdict | Needs the user |
| --- | ---------------------------------------------------------------------- | -------- | ------ | ------- | -------------- |
| —   | _Pending: the security engineer's audit (2026-10-24) is triaged here._ |          |        |         |                |

**Needs the user (Cloudflare dashboard):** none yet.

### After M5: follow-ups

Non-blocking items from the M5 PO review. Do them in one small PR if the project continues.
- ✅ **Done (follow-ups PR):** `AGENTS.md`'s `public/` row said `sw.js` and `offline.html` live there. The worker template is `src/client/sw.js`, built by `vite.config.ts`, and the offline fallback page is inline in it.
- **Declined (PO accepted, follow-ups review):** column removal flies only one of the three removed cards to the discard. Flying all three needs temporary clone elements, which is more code than the polish is worth (Visual polish already scores 4). `flightsBetween` keeps one source per target, so the other two vanish.
- ✅ **Done (follow-ups PR), Pixel only:** small-phone scroll with motion allowed had no E2E. Playwright's headless WebKit never animates `scrollIntoView({ behavior: "smooth" })` inside an overflow container: a 10-line page failed 5 out of 5. So the iPhone project can only check the reduced-motion path. The 375×548 check now runs with `reducedMotion: "no-preference"` on the Pixel project. The PO confirmed its 8-player case fails when the scroll is removed.
- **Open, needs the user:** the Spanish install hint says "Agregar a inicio". Check the share-sheet label on an iPhone set to Latin American Spanish.
- **Open, needs the user:** on a real iPhone SE (or any phone about 548 px tall in the browser), check that your whole grid scrolls into view when your turn starts, with motion on. Headless WebKit can't test this.

### After M6: follow-ups

Follow-ups from the M6 PO reviews (Game feel scored 4): one test gap, then game-feel items. None blocks. **Planned (PO, 2026-10-24):** the first item goes into M8, the final-reveal hold into M9, and the rest into the M10+ triage pool.
- **→ M8. Do first: an E2E for a full discard-and-flip turn.** Since PR #7, `botStep` swaps the drawn card into a face-down slot, so no E2E in CI, and not the live smoke test, ever finishes draw → discard → flip; "discard mode can be cancelled" only enters the mode and leaves it. Add one test on all 3 devices: draw, discard, flip, then check that one fewer card is face down, the drawn card is on the discard pile, and the turn has passed. The PO ran this as a throwaway spec in round 2: it passed in 2.2–3.1 s per device.
- **→ M8. Fix the race in `e2e/sound.spec.ts`.** It failed the `main` run for PR #8 on Pixel (run 40105073659), and `failOnFlakyTests` blocked that deploy. The check "Ben heard a sound after Ana's flip" already passes on the deal sound, so Ana's second tap can land before her first flip comes back and hit the same card: Ben's table then shows 1 face-up card, not 2. Wait for Ana's grid to show 1 face-up card before the second tap, and count sounds from after the deal (PO, PR #10 review).
- **→ M9. Let the final reveal play before the round summary.** At round end the summary sheet is fully opaque 200 ms after the last move, while the R11 flips are still animating under it (4 running animations at 0 ms; WebKit, 2 phones). Nobody sees the last hidden cards turn over or who gets doubled. Hold the sheet about 1 s, or until the flips finish (no hold with reduced motion).
- **A real game-over moment.** `public/sfx/end.mp3` lasts 0.16 s, a click rather than an ending (`win.mp3` is 0.52 s). Give game over a fuller cue.
- **Last-round cue.** When someone reveals their whole grid, only the header pill turns red. Play a short cue for everyone (and vibrate where supported), since everyone's next turn is now their last.
- **Spectators lose the piles at 8 seats.** At 390×664 with 8 players, a spectator's deck, discard and drawn card were off screen on 16 of 16 turns while the table followed whoever was playing, and R6 makes the drawn card public. Keep the piles in view, for example above the grids.
- **Nit:** `sound.ts` swallows decode errors in an empty `.catch` with no comment. (The CHANGELOG and AGENTS nits were fixed in PR #7.)
- **Idea, the user's call:** quick reactions (👏 😂 😱) for friends who aren't in the same room or on a call.

## Process

**One PR at a time.** The next PR starts only after the previous one merges: its branch is cut from the `main` that includes it. That way every milestone builds on the shipped game and every PO review sees a single change (user request, 2026-10-24). Docs-only PRs, such as plan or triage edits, follow the same rule but don't bump the version. CI's CHANGELOG check passes because the current version already has its section, and the release job skips a version that is already released.

Per milestone:
1. Branch `m<N>-<slug>` from `main`. Build test-first for engine and room code.
2. Run the `superpowers:requesting-code-review` review, then fix its findings.
3. CI green.
4. Open a PR with a summary, mobile screenshots (Playwright, committed under `docs/screenshots/m<N>/`), and test results. Bump the `package.json` version, add its `CHANGELOG.md` section, and refresh the README (rerun `npm run shots:readme` if the UI changed). Merging to `main` then deploys and publishes the GitHub Release.
5. Dispatch the PO agent: a fresh subagent that has not seen the implementation. It reads this plan and the PR, runs the game locally, plays it through Playwright at a mobile viewport, and scores the rubric. It then posts review comments and either merges or requests specific changes. It may edit this plan, with justification in the PR.
6. At most 3 PO review rounds per PR. If still not approved, stop and summarize the open issues for the user.

**GitHub constraint.** Author and PO both act as `jack1590`, and GitHub forbids approving or requesting changes on your own PR. So the PO posts a comment review whose first line is `PO VERDICT: APPROVE` or `PO VERDICT: CHANGES REQUESTED`, adds inline comments through the API, and merges with `gh pr merge --squash` once CI is green. Branch protection therefore requires 0 approvals but does require CI.

### PO rubric

Each criterion is scored 1–5, or N/A when the milestone has no surface for it (multiplayer in M1–M2, for example).

| Criterion             | 5 means                                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rules correctness     | Every rule R1–R15 behaves as specified in play and in tests                                                                                                                                      |
| Mobile UX             | One-handed portrait play, clear turn state, ≥ 44 px targets, no dead ends                                                                                                                        |
| Visual polish         | Original, cohesive art; readable cards; smooth, purposeful motion                                                                                                                                |
| Multiplayer stability | No desyncs; reload and network drop recover; no leaked hidden info                                                                                                                               |
| Security              | A scripted client can't take the service down, use up a free-plan quota, get into rooms by guessing, or disrupt another room's game; every limit is tested; no open critical or high SEC finding |
| Code health           | Small, tested, readable; matches `AGENTS.md`; no dead code                                                                                                                                       |
| Delivery health       | PR CI wall time ≤ 3 min; no flaky, retried or timed-out jobs; every CI job has `timeout-minutes`; `npm run e2e` runs locally in ≤ 2 min                                                          |
| Game feel             | Sound, haptics and motion make every move feel physical; any player count is readable at a glance; friends would want a rematch                                                                  |

Security is scored on any PR that touches the server, the protocol or a route, and is N/A otherwise. The PO lists each new entry point (a message type, an HTTP route, an alarm, a storage write) with the limit that bounds it. An entry point with no bound is a blocking defect.

The PO measures delivery health on every review, using `gh run view --json jobs` for wall and per-job times and a timed local `npm run e2e`, and reports the numbers with the score.

**Approve when** no applicable criterion is below 3, no blocking defect is open, CI is green, and the release checklist is done: version bumped, CHANGELOG section matches the PR, README text and images show the current game.

### Stop and ask the user before

- choosing a hosting provider that needs a credit card;
- exposing this computer to the internet;
- any destructive git operation (force-push, history rewrite, deleting branches with unmerged work).

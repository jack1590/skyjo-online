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
| `src/client/`          | React app (hot-seat and online modes)                                                        | browser                  |
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
- **`motion`** (the current package name of Framer Motion) for animations. CSS 2D, no PixiJS unless profiling demands it.
- **No router or state library.** `/r/:code` is parsed by hand; state lives in `useReducer` (hot-seat) or server snapshots (online).
- **Hand-written message validation.** The protocol has fewer than 10 message types.
- **`vite-plugin-pwa`** for the manifest and service worker.
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
- Self-host fallback: `src/server/node.ts` (Node + `ws`, serves `dist/`, rooms in memory). The README documents running it behind `cloudflared tunnel`. It is never exposed without asking the user first.
- CI's `concurrency` group cancels in-progress runs. A deploy on `main` must never be cancelled halfway, so `cancel-in-progress` applies to PRs only.

- Rate-limit `POST /api/rooms` per client IP with the Workers Rate Limiting binding (or a WAF rule). Room creation is otherwise unthrottled: each call writes storage and sets an alarm (M3 review).
- A flaky test fails CI: set `failOnFlakyTests` when `CI` in `playwright.config.ts`, so `retries: 1` can no longer turn a flake green. In M3 the 2-phone game failed about 1 run in 4 (the bot tripped the 40-message flood limit), and the retry hid it until the M4 review (PO, M3 review).

**Acceptance:** the public URL works on a real phone. The smoke test passes against it. The Node fallback passes the same E2E locally. A test that passes only on retry fails its CI job.

### M5 — Polish, animations, PWA

- Animations: card flip (3D rotate), draw, discard and swap travel, column removal, score count-up. All honor `prefers-reduced-motion`.
- PWA: manifest, generated icons, service worker for the app shell, an offline page explaining the game needs a connection, and an "Add to Home Screen" hint on iOS.
- Art v2 pass. README completed: how to play, run locally, deploy, self-host.
- Small phones: at 375×548 the acting player's whole grid is on screen when their turn starts, either because it fits or because it is scrolled into view, and cards stay ≥ 44 px. In M2 the bottom row ended at 592 px with 2 players and at 615 px with 8, so it had to be scrolled to every turn.
- Waiting on an offline player: when the seat the table waits on is offline, everyone sees that it is offline and when the stall guard will move for it (for example "Cris is offline · auto-move in 42 s"). In M3 the table showed only "Waiting for Cris…" and a dimmed tile for the whole 60 s, on every one of that player's turns (PO, M3 review).

**Acceptance:** Playwright verifies the manifest and service worker are installable. Reduced motion disables animations. The README covers every section listed in the brief. At 375×548, Playwright asserts the acting player's grid is fully in view at the start of a turn for 2 and 8 players. Playwright asserts the offline notice and countdown appear when the current player's phone closes. The PO scores visual polish ≥ 4.

## Process

Per milestone:
1. Branch `m<N>-<slug>` from `main`. Build test-first for engine and room code.
2. Run the `superpowers:requesting-code-review` review, then fix its findings.
3. CI green.
4. Open a PR with a summary, mobile screenshots (Playwright, committed under `docs/screenshots/m<N>/`), and test results.
5. Dispatch the PO agent: a fresh subagent that has not seen the implementation. It reads this plan and the PR, runs the game locally, plays it through Playwright at a mobile viewport, and scores the rubric. It then posts review comments and either merges or requests specific changes. It may edit this plan, with justification in the PR.
6. At most 3 PO review rounds per PR. If still not approved, stop and summarize the open issues for the user.

**GitHub constraint.** Author and PO both act as `jack1590`, and GitHub forbids approving or requesting changes on your own PR. So the PO posts a comment review whose first line is `PO VERDICT: APPROVE` or `PO VERDICT: CHANGES REQUESTED`, adds inline comments through the API, and merges with `gh pr merge --squash` once CI is green. Branch protection therefore requires 0 approvals but does require CI.

### PO rubric

Each criterion is scored 1–5, or N/A when the milestone has no surface for it (multiplayer in M1–M2, for example).

| Criterion             | 5 means                                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Rules correctness     | Every rule R1–R15 behaves as specified in play and in tests                                                                             |
| Mobile UX             | One-handed portrait play, clear turn state, ≥ 44 px targets, no dead ends                                                               |
| Visual polish         | Original, cohesive art; readable cards; smooth, purposeful motion                                                                       |
| Multiplayer stability | No desyncs; reload and network drop recover; no leaked hidden info                                                                      |
| Code health           | Small, tested, readable; matches `AGENTS.md`; no dead code                                                                              |
| Delivery health       | PR CI wall time ≤ 3 min; no flaky, retried or timed-out jobs; every CI job has `timeout-minutes`; `npm run e2e` runs locally in ≤ 2 min |

The PO measures delivery health on every review, using `gh run view --json jobs` for wall and per-job times and a timed local `npm run e2e`, and reports the numbers with the score.

**Approve when** no applicable criterion is below 3, no blocking defect is open, and CI is green.

### Stop and ask the user before

- choosing a hosting provider that needs a credit card;
- exposing this computer to the internet;
- any destructive git operation (force-push, history rewrite, deleting branches with unmerged work).

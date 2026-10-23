# M0 Bootstrap + M1 Rules Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Public repo with CI and a protected `main` (M0), then a pure, deterministic, fully tested Skyjo-style rules engine (M1).

**Architecture:** Single npm package. Engine in `src/engine/` is plain TypeScript with no DOM/Node/`Math.random`/`Date`; state is plain JSON-serializable data; `apply` clones with `structuredClone` and mutates the clone. Hidden info is stripped by `toView`, which is identical for every viewer (in this game nobody, owner included, sees face-down values).

**Tech Stack:** TypeScript (strict), Vite + React (minimal shell only in M0), Vitest + `@vitest/coverage-v8`, Biome, GitHub Actions, `gh` CLI.

**Spec:** `docs/PLAN.md` (roadmap, milestones M0/M1) and `AGENTS.md` § Rules (R1–R15, canonical after Task 1).

## Global Constraints

- Repo: `jack1590/skyjo-online`, public, remote `git@github.com:jack1590/skyjo-online.git`.
- `gh` calls as jack1590: prefix `GH_TOKEN=$(gh auth token --user jack1590)`; never switch the global active account.
- `.env` (holds `GEMINI_API_KEY`) is never committed.
- Node 22, npm. Lockfile committed.
- Engine imports only from `./` within `src/engine`; no `Math.random`, `Date`, `window`, `process`.
- Engine coverage thresholds: 95% lines and branches.
- Test names for rules start with the rule id, e.g. `"R9: removes a column of three equal face-up cards"`.
- Original wording only; no official Skyjo rulebook text or art.

## Review Focus

1. Out-of-turn or wrong-seat action → `RuleError`, state unchanged. Test in Task 3.
2. `pos` outside 0–11, non-integer, or pointing at a removed slot → `RuleError`. Test in Task 3.
3. Flipping an already face-up card (initial flip or discard-and-flip) → `RuleError`. Test in Task 3.
4. `createGame` with <2 or >8 names, or a blank name → throws. Test in Task 3.
5. Any action after `gameOver`, or `nextRound` outside `roundOver` → `RuleError`. Test in Task 4.

---

### Task 1: M0 bootstrap — repo, tooling, CI, protection

**Files:**
- Create: `package.json`, `package-lock.json`, `tsconfig.json`, `biome.json`, `vite.config.ts`, `index.html`, `src/client/main.tsx`, `.gitignore`, `.editorconfig`, `LICENSE`, `README.md`, `AGENTS.md`, `CLAUDE.md` (`@AGENTS.md` only), `.github/workflows/ci.yml`
- Modify: `docs/PLAN.md` (rules table → pointer to `AGENTS.md` § Rules)

**Interfaces:**
- Produces npm scripts: `dev` (vite), `build` (vite build), `lint` (biome check .), `format` (biome check --write .), `typecheck` (tsc --noEmit), `test` (vitest run --passWithNoTests; Task 5 swaps in coverage).
- Produces CI job id `ci` (required status check name).

- [ ] **Step 1:** `git init -b main`; set repo-local `user.email`/`user.name` for the personal account if global identity is a work one.
- [ ] **Step 2:** `npm init`, install dev deps `typescript vite @vitejs/plugin-react vitest @vitest/coverage-v8 @biomejs/biome @types/react @types/react-dom`, deps `react react-dom`.
- [ ] **Step 3:** Write config + docs files listed above. `src/client/main.tsx` renders a single "Skyjo Online — coming soon" heading. AGENTS.md holds: architecture, commands, conventions, agent workflow (incl. PO verdict format and 3-round cap), stop-and-ask list, Rules R1–R15.
- [ ] **Step 4:** Run `npm run lint && npm run typecheck && npm test && npm run build`. Expected: all exit 0.
- [ ] **Step 5:** Commit `chore: bootstrap repo`, `gh repo create jack1590/skyjo-online --public --source . --remote origin` (then set remote URL to SSH), push `main`.
- [ ] **Step 6:** Repo settings: squash-merge only, delete branch on merge. Branch protection via `gh api -X PUT repos/jack1590/skyjo-online/branches/main/protection` with `required_status_checks {strict: true, contexts: ["ci"]}`, `enforce_admins: true`, `required_pull_request_reviews {required_approving_review_count: 0}`, `required_linear_history: true`, `allow_force_pushes: false`, `allow_deletions: false`, `restrictions: null`.
- [ ] **Step 7:** Verify: `gh run watch` on the push run → success; `gh api .../branches/main/protection` shows `enforce_admins.enabled: true`.

### Task 2: Seeded RNG and game creation (R1, R2, R15 deal)

**Files:**
- Create: `src/engine/rng.ts`, `src/engine/game.ts`, `src/engine/game.test.ts`

**Interfaces:**
- Produces (`rng.ts`):
  - `nextRandom(rng: number): [value: number, next: number]` — mulberry32, `value` in [0, 1).
  - `shuffle<T>(items: readonly T[], rng: number): [T[], number]` — Fisher–Yates using `nextRandom`.
- Produces (`game.ts`):
  - `type Card = number`
  - `interface Slot { card: Card; up: boolean }`
  - `type Grid = (Slot | null)[]` — length 12, index `row * 4 + col`, `null` = removed.
  - `interface Player { name: string; grid: Grid; total: number; scores: number[] }`
  - `type Phase = 'flip' | 'draw' | 'place' | 'roundOver' | 'gameOver'`
  - `interface GameState { rng: number; round: number; phase: Phase; current: number; players: Player[]; deck: Card[]; discard: Card[]; drawn: Card | null; drawnFrom: 'deck' | 'discard' | null; ender: number | null; doubled: boolean; winners: number[] }` — `discard` top is the last element.
  - `type Action = { type: 'flip'; seat: number; pos: number } | { type: 'draw'; seat: number; source: 'deck' | 'discard' } | { type: 'swap'; seat: number; pos: number } | { type: 'discardAndFlip'; seat: number; pos: number } | { type: 'nextRound' }`
  - `class RuleError extends Error`
  - `const ROWS = 3, COLS = 4, TARGET = 100`
  - `newDeck(): Card[]` — R1 distribution, unshuffled.
  - `createGame(names: string[], seed: number): GameState` — round 1, phase `'flip'`.

- [ ] **Step 1: Write failing tests**
  - `"R1: deck has 150 cards: -2×5, -1×10, 0×15, 1..12×10"` — count per value.
  - `"R2: deals 12 face-down cards per player and starts the discard with one card"` — every slot `up: false`, `discard.length === 1`, `deck.length === 150 - 12n - 1`.
  - `"createGame is deterministic for a seed and differs across seeds"`.
- [ ] **Step 2:** `npx vitest run src/engine` → FAIL (module not found).
- [ ] **Step 3:** Implement `rng.ts`, types, `newDeck`, `createGame` (private `deal(state)` reused by `nextRound`).
- [ ] **Step 4:** `npx vitest run src/engine` → PASS.
- [ ] **Step 5:** Commit `feat(engine): seeded rng, deck, deal`.

### Task 3: Turn actions (R3–R9) and input guards

**Files:**
- Modify: `src/engine/game.ts`, `src/engine/game.test.ts`

**Interfaces:**
- Produces: `apply(state: GameState, action: Action): GameState` (throws `RuleError`, never mutates input); `legalActions(state: GameState): Action[]` (flip phase lists actions for every seat with < 2 face-up cards).

Tests build exact states by mutating a fresh `createGame` result (test helper `rig(state, { grids?, deck?, discard? })`).
- [ ] **Step 1: Write failing tests**
  - `"R3: each player flips exactly two cards; a third flip is rejected"`.
  - `"R4: highest flipped sum starts"`, `"R4: ties go to the lowest seat"`.
  - `"R5: turn passes to the next seat and wraps"`.
  - `"R6: drawing from the deck sets drawn/drawnFrom and phase 'place'"`, `"R6: discardAndFlip discards the drawn card and flips the chosen face-down card"`.
  - `"R7: a card taken from the discard cannot be discarded"` (`discardAndFlip` throws).
  - `"R8: swap puts the drawn card face up and the old card face up on the discard"` (both for face-down and face-up targets).
  - `"R9: removes a column of three equal face-up cards; discard order is swapped card then column"` — top three of discard equal the column value, the one beneath is the swapped-out card; slots become `null`.
  - `"R9: no removal when a matching column has a face-down card"`.
  - Guards: out-of-turn seat; `pos` 12, -1, 1.5, removed slot; flipping a face-up card; `createGame` with 1 or 9 names or `"  "`; input state deep-equals its clone after a throwing `apply`.
  - `"legalActions: every listed action applies without throwing"` on a few seeded states per phase.
- [ ] **Step 2:** `npx vitest run src/engine` → new tests FAIL.
- [ ] **Step 3:** Implement `apply` (clone, validate, dispatch per action type, `removeColumns(state, seat)` after grid changes, advance turn) and `legalActions`.
- [ ] **Step 4:** `npx vitest run src/engine` → PASS.
- [ ] **Step 5:** Commit `feat(engine): turn actions and column removal`.

### Task 4: Round end, scoring, game end (R10–R15)

**Files:**
- Modify: `src/engine/game.ts`, `src/engine/game.test.ts`

**Interfaces:**
- Consumes: `apply`, `legalActions` from Task 3.
- `nextRound` action valid only in `'roundOver'`; it reshuffles all 150 cards (R15) and re-enters `'flip'`.

- [ ] **Step 1: Write failing tests**
  - `"R10: revealing the last card sets ender; each other player gets exactly one more turn"` (4 players: ender seat 2 → turns 3, 0, 1 then `roundOver`).
  - `"R10: a fully removed grid counts as revealed"`.
  - `"R11: final reveal flips everything and removes newly matching columns"`.
  - `"R12: round score is the sum of remaining cards"`.
  - `"R12: ender not strictly lowest with a positive score is doubled"`, `"R12: tie with another player doubles"`, `"R12: ender strictly lowest is not doubled"`, `"R12: ender with score ≤ 0 is never doubled"`.
  - `"R13: drawing from an empty deck reshuffles the discard except its top card"`.
  - `"R14: reaching 100 ends the game; lowest total wins; ties share the win"`.
  - `"R15: nextRound redeals a full 150-card deck and returns to flip phase"`.
  - `"R4: start-player rule also applies in round 2"`.
  - Guards: any action in `'gameOver'` throws; `nextRound` outside `'roundOver'` throws.
- [ ] **Step 2:** `npx vitest run src/engine` → new tests FAIL.
- [ ] **Step 3:** Implement end-of-turn check, `endRound(state)` (reveal, remove columns, score, double, totals, game-over), `nextRound`, lazy reshuffle in deck draw.
- [ ] **Step 4:** `npx vitest run src/engine` → PASS.
- [ ] **Step 5:** Commit `feat(engine): round end, scoring, game end`.

### Task 5: View projection, simulation, purity, coverage gate

**Files:**
- Create: `src/engine/view.ts`, `src/engine/sim.test.ts`
- Modify: `vite.config.ts` (coverage include `src/engine/**`, exclude tests, thresholds lines/branches 95), `package.json` (`test` → `vitest run --coverage`)

**Interfaces:**
- Produces: `type ViewSlot = Card | 'down' | null`; `interface GameView { round; phase; current; ender; doubled; winners; players: { name: string; grid: ViewSlot[]; total: number; scores: number[] }[]; deckCount: number; discardTop: Card | null; drawn: Card | null; drawnFrom: 'deck' | 'discard' | null }`; `toView(state: GameState): GameView`.

- [ ] **Step 1: Write failing tests** (`sim.test.ts`)
  - `"simulates 1000 seeded games (2–8 players) to completion"` — random legal action each step; after every step: card multiset over deck + discard + grids + drawn equals `newDeck()` multiset; each game ends in `'gameOver'` within 20,000 actions; each total equals the sum of its `scores`.
  - `"rejects random illegal actions"` — random action from the full action space that is not in `legalActions` throws `RuleError`.
  - `"same seed and same actions produce identical states"`.
  - `"toView never exposes face-down values or deck order"` — on sim states, `view.players[*].grid` is `'down'` exactly where the slot is face-down, and `JSON.stringify(view)` has no `deck`, `rng` keys.
  - `"engine is pure"` — every non-test file in `src/engine` imports only `./…` and contains no `Math.random`, `Date`, `window`, `process`.
- [ ] **Step 2:** `npx vitest run src/engine` → FAIL (no `view.ts`).
- [ ] **Step 3:** Implement `toView`; update coverage config and `test` script.
- [ ] **Step 4:** `npm run lint && npm run typecheck && npm test && npm run build` → all exit 0, coverage ≥ 95%.
- [ ] **Step 5:** Commit `feat(engine): view projection and simulation tests`.
- [ ] **Step 6:** Code review (`superpowers:requesting-code-review`), fix findings, push `m1-rules-engine`, open PR (summary, test results; no screenshots — no UI yet), then run the PO loop from `docs/PLAN.md` § Process.

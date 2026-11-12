// Round celebrations (M30): the round's winner in the summary's heading, with confetti on their
// phone, one highlight line, a kind line for every place at game over, and asking for a rematch.
// At exact states through the harness, in both looks.
import { expect, type Page } from "@playwright/test";
import type { GameState } from "../src/engine/game";
import { type GameView, toView } from "../src/engine/view";
import { knockoutGame, roundOver, type Shown, show } from "./harness";
import { expectMobileFriendly, test } from "./helpers";
import { m27Summary } from "./m27-states";

const LOOKS = ["classic", "casual"] as const;
const SHOTS = !!process.env.SHOTS;

/** The table in one of the two looks, measured once its fonts are in. */
async function showIn(page: Page, look: (typeof LOOKS)[number], table: Shown) {
  await page.addInitScript((l) => localStorage.setItem("skyjo:theme", l), look);
  await show(page, table);
  await page.evaluate(() => document.fonts.ready);
}
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  // The sheet has risen; the confetti is still in the air.
  await page.waitForTimeout(500);
  await page.screenshot({ path: `docs/screenshots/m30/${name}.jpg`, quality: 85, scale: "css" });
};

/** M27's round 3: Leo (seat 1) scored 14, the lowest. Here he also cleared two columns. */
const round3 = (): GameView => {
  const { view } = m27Summary();
  const players = view.players.map((p, i) =>
    i === 1 ? { ...p, grid: p.grid.map((slot, pos) => (pos % 4 < 2 ? null : slot)) } : p,
  );
  return { ...view, players };
};

/** A finished knockout game of four (seed 53), as table.spec.ts ranks it. */
const finished = () => toView(knockoutGame(["Ana", "Ben", "Cris", "Dani"], 53).at(-1) as GameState);

for (const look of LOOKS) {
  test(`M30 (${look}): the round summary opens with the round's winner and one highlight; only the winner's phone gets confetti, and none with reduced motion`, async ({
    page,
  }, info) => {
    const view = round3();
    const summary = page.getByTestId("round-summary");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await showIn(page, look, { view, seat: 0, lead: true });
    await expect(summary.getByRole("heading")).toHaveText("Leo won round 3!");
    await expect(summary.getByTestId("summary-recap")).toHaveText("Leo cleared 2 columns.");
    await expect(summary.getByTestId("summary-why")).toBeVisible();
    await expect(summary.getByTestId("confetti")).toHaveCount(0);
    await expectMobileFriendly(page);
    if (info.project.name === "iphone") await shot(page, `01-round-${look}`);

    await showIn(page, look, { view, seat: 1 });
    await expect(summary.getByRole("heading")).toHaveText("You won round 3!");
    await expect(summary.getByTestId("confetti")).toHaveCount(1);
    await expectMobileFriendly(page);
    if (info.project.name === "iphone") await shot(page, `02-round-won-${look}`);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await showIn(page, look, { view, seat: 1 });
    await expect(summary.getByRole("heading")).toHaveText("You won round 3!");
    await expect(summary.getByTestId("confetti")).toHaveCount(0);
  });

  test(`M30 (${look}): at game over every place reads a kind line; a guest asks for a rematch once, and whoever leads reads who asked`, async ({
    page,
  }, info) => {
    const view = finished();
    const over = page.getByTestId("game-over");
    const [winner] = view.winners;
    const guest = (winner + 1) % 4;
    const lines = new Set<string>();
    for (const seat of [0, 1, 2, 3]) {
      await showIn(page, look, { view, seat, lead: seat === winner });
      await expect(over.getByTestId("summary-kind")).toBeVisible();
      lines.add(await over.getByTestId("summary-kind").textContent());
    }
    expect(lines.size).toBe(4);

    // A guest: no Play again, a request instead.
    await showIn(page, look, { view, seat: guest });
    // Its line sits beside who won: the sheet is no taller than before M30.
    const top = async (id: string) => (await over.getByTestId(id).boundingBox())?.y ?? 0;
    expect(Math.abs((await top("summary-kind")) - (await top("summary-sub")))).toBeLessThan(4);
    await expect(over.getByText("The host can start a new game")).toBeVisible();
    await expect(over.getByRole("button", { name: "Play again" })).toHaveCount(0);
    await over.getByRole("button", { name: "Rematch?" }).click();
    await expect(over.getByRole("button", { name: "Rematch asked" })).toBeDisabled();
    const name = view.players[guest].name;
    await expect(over.getByTestId("rematch-asked")).toHaveText(`${name} wants a rematch`);
    await expect(over.getByText("The host can start a new game")).toHaveCount(0);
    await expectMobileFriendly(page);
    if (info.project.name === "iphone") await shot(page, `03-game-over-guest-${look}`);

    // Whoever leads keeps Play again, and reads who asked, in order. A request the room forgot
    // (it slept) stays on the phone that saw it.
    const other = (winner + 2) % 4;
    await showIn(page, look, { view, seat: winner, lead: true, rematch: [guest] });
    await expect(over.getByTestId("rematch-asked")).toHaveText(`${name} wants a rematch`);
    await page.evaluate(
      (detail) => window.dispatchEvent(new CustomEvent("skyjo:table", { detail })),
      { rematch: [other] },
    );
    await expect(over.getByTestId("rematch-asked")).toHaveText(
      `${name} & ${view.players[other].name} want a rematch`,
    );
    await expect(over.getByRole("button", { name: "Play again" })).toBeVisible();
    await expect(over.getByRole("button", { name: "Rematch?" })).toHaveCount(0);
    await expectMobileFriendly(page);
    if (info.project.name === "iphone") await shot(page, `04-game-over-host-${look}`);

    // Watching: nothing to ask with.
    await showIn(page, look, { view, seat: null });
    await expect(over.getByRole("button", { name: "Rematch?" })).toHaveCount(0);
    await expect(over.getByTestId("summary-kind")).toHaveCount(0);
  });

  test(`M30 (${look}): 8 players at 360 × 640: the round summary and game over never scroll sideways; Next round is on screen`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 360, height: 640 });
    // Seat 1, as M27's and M28's fit checks: the ender's own row wraps on their phone (PLAN, M27).
    const round: GameView = { ...toView(roundOver(8, 344)), phase: "roundOver", winners: [] };
    await showIn(page, look, { view: round, seat: 1, lead: true });
    await expect(page.getByRole("button", { name: "Next round" })).toBeInViewport({ ratio: 1 });
    const sheet = page.locator("dialog.overlay .sheet");
    expect(await sheet.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(0);
    await expectMobileFriendly(page);
    if (info.project.name === "iphone") await shot(page, `05-eight-round-${look}`);

    // Game over, with the longest lines: a guest in the middle, and three who asked.
    const over: GameView = { ...round, phase: "gameOver", winners: [2] };
    await showIn(page, look, { view: over, seat: 5, rematch: [0, 3, 6] });
    await expect(page.getByTestId("rematch-asked")).toBeVisible();
    expect(await sheet.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    if (info.project.name === "iphone") await shot(page, `06-eight-game-over-${look}`);
    await page.getByRole("button", { name: "Rematch?" }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "Rematch?" })).toBeInViewport({ ratio: 0.9 });
    await expectMobileFriendly(page);
  });
}

test("M30: the heading, the highlight and the rematch lines in Spanish and Portuguese", async ({
  page,
}) => {
  const view = finished();
  const guest = (view.winners[0] + 1) % 4;
  const name = view.players[guest].name;
  for (const [locale, title, recap, ask, wants] of [
    ["es", "¡Leo ganó la ronda 3!", "Leo eliminó 2 columnas.", "¿Revancha?", "quiere la revancha"],
    ["pt", "Leo venceu a rodada 3!", "Leo eliminou 2 colunas.", "Revanche?", "quer revanche"],
  ]) {
    await page.addInitScript((l) => localStorage.setItem("skyjo:locale", l), locale);
    await show(page, { view: round3(), seat: 0, lead: true });
    await expect(page.getByTestId("round-summary").getByRole("heading")).toHaveText(title);
    await expect(page.getByTestId("summary-recap")).toHaveText(recap);
    await show(page, { view, seat: guest });
    await page.getByRole("button", { name: ask }).click();
    await expect(page.getByTestId("rematch-asked")).toHaveText(`${name} ${wants}`);
    await expectMobileFriendly(page);
  }
});

// M31: the first-game tutorial. A scripted round on the real table, with no room and no server:
// offered once on Home, skippable at every step, replayable from "Learn to play".
import { expect, type Page } from "@playwright/test";
import { expectMobileFriendly, test } from "./helpers";

/** What each step waits for, in script order: grid positions, a pile, or the bubble's "Next". */
const TAPS: (number | "deck" | "discard" | "next")[][] = [
  [8, 9],
  ["next"],
  ["discard"],
  [9],
  ["deck"],
  ["discard", 5],
  ["discard"],
  [1],
  ["next"],
  ["discard"],
  [0],
];
/** The bubble's words at each of those taps, in English. */
const SAYS = [
  ["Flip these two cards.", "Flip these two cards."],
  ["−2 is great, 12 is bad. Low wins."],
  ["A 3 is low. Take it."],
  ["Swap it for your 12."],
  ["Now draw from the deck."],
  ["An 11 is too high. Throw it away.", "Then flip this card."],
  ["Leo left a 3. Take it."],
  ["Three equal cards clear a column. Swap here."],
  ["Cleared! Let's skip ahead a few turns."],
  ["One card left. Take the 1."],
  ["Swap your last card to end the round."],
];

const card = (page: Page, pos: number) => page.getByTestId("my-grid").locator(".card").nth(pos);
const target = (page: Page, at: number | "deck" | "discard") =>
  typeof at === "number" ? card(page, at) : page.getByTestId(at);
const coach = (page: Page) => page.getByTestId("coach");

/** The bubble is on screen, off the card or pile it points at, and its buttons are 44 px. */
async function expectCoached(page: Page, at: number | "deck" | "discard" | "next") {
  await expectMobileFriendly(page);
  const bubble = await coach(page).boundingBox();
  const size = page.viewportSize();
  if (!bubble || !size) throw new Error("no bubble");
  expect(bubble.x).toBeGreaterThanOrEqual(0);
  expect(bubble.y).toBeGreaterThanOrEqual(0);
  expect(bubble.x + bubble.width).toBeLessThanOrEqual(size.width);
  expect(bubble.y + bubble.height).toBeLessThanOrEqual(size.height);
  if (at === "next") return;
  const box = await target(page, at).boundingBox();
  if (!box) throw new Error("no target");
  const apart =
    bubble.y + bubble.height <= box.y ||
    bubble.y >= box.y + box.height ||
    bubble.x + bubble.width <= box.x ||
    bubble.x >= box.x + box.width;
  expect(apart).toBe(true);
}

/** Plays step `i`: each of its taps, once the bubble asks for it. `measure`: not mid-flight. */
async function playStep(page: Page, i: number, says?: string[], measure = true) {
  await expect(page.getByTestId("tutorial")).toHaveAttribute("data-step", String(i));
  for (const [n, at] of TAPS[i].entries()) {
    if (says) await expect(coach(page)).toContainText(says[n]);
    // Thrown away, the bubble moves from the pile to the card to flip.
    if (n > 0 && typeof at === "number" && i === 5) {
      await expect(page.getByTestId("my-grid")).toHaveClass(/discarding/);
    }
    if (measure) await expectCoached(page, at);
    if (at === "next") await coach(page).getByRole("button").last().click();
    else await target(page, at).click();
  }
}

test("M31: Home offers the tutorial once; it plays a whole scripted round on the real table, one instruction and one real tap at a time, explains the doubling at the summary and ends on Home, ready to create or join a room", async ({
  page,
}) => {
  // What the tutorial asks the server for while it plays: nothing (Home's own polls stop too).
  const requests: string[] = [];
  let playing = false;
  page.on("request", (r) => {
    if (playing && new URL(r.url()).pathname.startsWith("/api")) requests.push(r.url());
  });
  await page.goto("/");
  await expect(page.getByTestId("tutorial-offer")).toContainText("New here?");
  await expectMobileFriendly(page);
  await page.getByRole("button", { name: "Show me" }).click();
  playing = true;
  await expect(page.getByTestId("table")).toHaveAttribute("data-phase", "flip");
  // The table's own names and no dead controls: you, against Leo.
  await expect(page.getByTestId("mine-head")).toContainText("You");
  await expect(page.getByTestId("opponent")).toContainText("Leo");
  await expect(page.getByRole("checkbox", { name: "Auto-play" })).toBeHidden();

  // A tap the step doesn't ask for does nothing: the card stays down and isn't lifted.
  await card(page, 0).click();
  await expect(card(page, 0)).toHaveAttribute("data-face", "down");
  await expect(card(page, 0)).not.toHaveAttribute("data-pending");

  await playStep(page, 0, SAYS[0]);
  await expect(card(page, 8)).toContainText("−2");
  await expect(card(page, 9)).toContainText("12");
  // While Leo flips, the bubble says so and nothing can be tapped into the game.
  for (let i = 1; i < 5; i++) await playStep(page, i, SAYS[i]);
  await expect(page.getByTestId("drawn")).toContainText("11");
  await playStep(page, 5, SAYS[5]);
  await expect(card(page, 5)).toContainText("3");
  await playStep(page, 6, SAYS[6]);
  await playStep(page, 7, SAYS[7]);
  // R9: the three 3s are gone.
  for (const pos of [1, 5, 9]) await expect(card(page, pos)).toHaveAttribute("data-face", "gone");
  await playStep(page, 8, SAYS[8]);
  await expect(page.getByTestId("my-grid").locator('[data-face="down"]')).toHaveCount(1);
  await playStep(page, 9, SAYS[9]);
  await playStep(page, 10, SAYS[10]);

  // The real summary, with the tutorial's own sentence for the doubling.
  const summary = page.getByTestId("round-summary");
  await expect(summary).toBeVisible();
  await expect(coach(page)).toBeHidden();
  await expect(summary.getByTestId("summary-why")).toHaveText(
    "You ended the round, but Leo scored lower, so your 9 counts double.",
  );
  await expect(summary.locator('tr[data-seat="0"]')).toContainText("9×2 = 18");
  await expect(summary.locator('tr[data-seat="1"]')).toContainText("7");
  playing = false;
  await summary.getByRole("button", { name: "Continue" }).click();

  // Home again: "You're ready", over the buttons to create a room or join one.
  await expect(page.getByTestId("tutorial-ready")).toContainText("You're ready!");
  await expect(page.getByRole("button", { name: "Create a room" })).toBeEnabled();
  await expect(page.getByRole("textbox", { name: "Room code" })).toBeVisible();
  await expectMobileFriendly(page);
  expect(requests).toEqual([]);

  // Never offered again, and replayable.
  await page.reload();
  await expect(page.getByRole("button", { name: "Learn to play" })).toBeVisible();
  await expect(page.getByTestId("tutorial-offer")).toBeHidden();
  await expect(page.getByTestId("tutorial-ready")).toBeHidden();
  await page.getByRole("button", { name: "Learn to play" }).click();
  await playStep(page, 0, SAYS[0]);
});

test("M31: Skip at every step, and while Leo plays, lands on Home; the tutorial is never offered again", async ({
  page,
}) => {
  await page.goto("/");
  for (let stop = 0; stop <= TAPS.length; stop++) {
    if (stop === TAPS.length) {
      // The last pass skips while Leo makes his first moves: at full speed, 1.1 s apart.
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.getByRole("button", { name: "Learn to play" }).click();
      await card(page, 8).click();
      await card(page, 9).click();
      await expect(coach(page)).toContainText("Leo is playing…");
    } else {
      await page.getByRole("button", { name: stop ? "Learn to play" : "Show me" }).click();
      for (let i = 0; i < stop; i++) await playStep(page, i);
      await expect(coach(page)).toContainText(SAYS[stop][0]);
    }
    await coach(page).getByRole("button", { name: "Skip" }).click();
    await expect(page.getByRole("button", { name: "Create a room" })).toBeVisible();
    await expect(page.getByTestId("tutorial-offer")).toBeHidden();
    await expect(page.getByTestId("tutorial-ready")).toBeHidden();
  }
  await page.reload();
  await expect(page.getByRole("button", { name: "Learn to play" })).toBeVisible();
  await expect(page.getByTestId("tutorial-offer")).toBeHidden();
});

test("M31: turning the offer down is remembered too, and the table's ✕ leaves the tutorial", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.getByTestId("tutorial-offer")).toBeHidden();
  await page.reload();
  await expect(page.getByTestId("tutorial-offer")).toBeHidden();
  await page.getByRole("button", { name: "Learn to play" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Quit to home" }).click();
  await expect(page.getByRole("button", { name: "Create a room" })).toBeVisible();
});

test("M31: with motion on, the round plays through too: the deal, Leo's moves 1.1 s apart, the turns skipped in one view, the final reveal", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "pixel", "one browser plays it at full speed");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/");
  await page.getByRole("button", { name: "Show me" }).click();
  for (let i = 0; i < TAPS.length; i++) await playStep(page, i, undefined, false);
  // The summary waits for the final reveal (UX-27).
  await expect(page.getByTestId("round-summary")).toBeVisible({ timeout: 10_000 });
  expect(errors).toEqual([]);
});

for (const locale of ["es", "pt"] as const) {
  for (const look of ["casual", "classic"] as const) {
    test(`M31: at 360 px in ${locale}, ${look} look, every bubble fits, stays off its target and nothing scrolls sideways`, async ({
      page,
    }, info) => {
      test.skip(info.project.name !== "pixel", "one browser measures the narrow layout");
      await page.setViewportSize({ width: 360, height: 640 });
      await page.addInitScript(
        ([locale, look]) => {
          localStorage.setItem("skyjo:locale", locale);
          localStorage.setItem("skyjo:theme", look);
        },
        [locale, look],
      );
      await page.goto("/");
      await expectMobileFriendly(page);
      await page.getByTestId("tutorial-offer").getByRole("button").last().click();
      await page.evaluate(() => document.fonts.ready);
      for (let i = 0; i < TAPS.length; i++) await playStep(page, i);
      await expect(page.getByTestId("round-summary")).toBeVisible();
      await expectMobileFriendly(page);
      await page.getByTestId("round-summary").getByRole("button").last().click();
      await expect(page.getByTestId("tutorial-ready")).toBeVisible();
      await expectMobileFriendly(page);
    });
  }
}

test("screenshots: M31 the tutorial in both looks", async ({ page }, info) => {
  test.skip(!process.env.SHOTS || info.project.name !== "iphone", "run with SHOTS=1");
  await page.setViewportSize({ width: 390, height: 844 });
  for (const look of ["casual", "classic"] as const) {
    const shot = async (name: string) => {
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({
        path: `docs/screenshots/m31/${look === "casual" ? "modern" : "classic"}-${name}.jpg`,
        type: "jpeg",
        quality: 85,
        scale: "css",
        animations: "disabled",
      });
    };
    await page.goto("/");
    await page.evaluate((look) => {
      localStorage.clear();
      localStorage.setItem("skyjo:theme", look);
    }, look);
    await page.reload();
    await shot("01-home-offer");
    await page.getByRole("button", { name: "Show me" }).click();
    await expect(coach(page)).toContainText(SAYS[0][0]);
    await shot("02-flip-two");
    await playStep(page, 0);
    await expect(coach(page)).toContainText(SAYS[1][0]);
    await shot("03-low-is-good");
    await playStep(page, 1);
    await shot("04-take-the-discard");
    await playStep(page, 2);
    await playStep(page, 3);
    await playStep(page, 4);
    await shot("05-throw-it-away");
    await target(page, "discard").click();
    await expect(coach(page)).toContainText(SAYS[5][1]);
    await shot("06-then-flip");
    await card(page, 5).click();
    await playStep(page, 6);
    await shot("07-column");
    await playStep(page, 7);
    await shot("08-skip-ahead");
    await playStep(page, 8);
    await playStep(page, 9);
    await shot("09-last-card");
    await playStep(page, 10);
    await expect(page.getByTestId("round-summary")).toBeVisible();
    await shot("10-doubling");
    await page.getByRole("button", { name: "Continue" }).click();
    await shot("11-ready");
  }
});

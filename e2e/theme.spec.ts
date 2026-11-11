// M28: the two looks. Modern ("Polished casual") is the default; Classic (M27) is a tap away, on
// Home and at the table. The harness (`show`) keeps Classic for the other specs, so these opt in.
import { expect, type Page } from "@playwright/test";
import { apply, legalActions } from "../src/engine/game";
import { toView } from "../src/engine/view";
import { atTurnStart, firstTurn, lastTurnGame, roundOver, type Shown, show } from "./harness";
import { botStep, expectMobileFriendly, seatedRoom, startGame, test } from "./helpers";
import { m27Summary, m27Table } from "./m27-states";

/** The table in Modern, measured once its fonts are in (they swap in over the system's). */
const showModern = async (page: Page, table: Shown) => {
  await show(page, table);
  await page.evaluate(() => document.fonts.ready);
};
const modern = (page: Page) =>
  page.addInitScript(() => localStorage.setItem("skyjo:theme", "casual"));
const look = (page: Page) => page.locator("html").getAttribute("data-theme");
const barColor = (page: Page) => page.locator('meta[name="theme-color"]').getAttribute("content");
/** What a card is painted with: Classic's art is a picture, Modern's a gradient. */
const paint = (page: Page, testId: string) =>
  page
    .getByTestId(testId)
    .evaluate((el) =>
      getComputedStyle(el).backgroundImage.includes("linear-gradient") ? "drawn" : "art",
    );

test("M28: Modern is the default look; Home's switch is two card previews, applies at once without a reload and is remembered on this device", async ({
  page,
}) => {
  await page.goto("/");
  expect(await look(page)).toBe("casual");
  expect(await barColor(page)).toBe("#2a1f7a");
  const looks = page.getByTestId("looks");
  await expect(looks.getByRole("button")).toHaveText(["7Modern", "7Classic"]);
  await expect(looks.locator(".look-card")).toHaveCount(2);
  await expect(looks.getByRole("button", { name: "Modern" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expectMobileFriendly(page);
  // A mark a reload would wipe.
  await page.evaluate(() => {
    (window as { stayed?: boolean }).stayed = true;
  });
  const stage = () => page.evaluate(() => getComputedStyle(document.body).backgroundImage);
  const before = await stage();
  await looks.getByRole("button", { name: "Classic" }).click();
  expect(await look(page)).toBe("classic");
  expect(await barColor(page)).toBe("#0f2234");
  expect(await stage()).not.toBe(before);
  expect(await page.evaluate(() => (window as { stayed?: boolean }).stayed)).toBe(true);
  await expect(looks.getByRole("button", { name: "Classic" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.reload();
  expect(await look(page)).toBe("classic");
  await page.getByTestId("looks").getByRole("button", { name: "Modern" }).click();
  await page.reload();
  expect(await look(page)).toBe("casual");
});

for (const [locale, title, names] of [
  ["es", "Estilo", ["Moderno", "Clásico"]],
  ["pt", "Visual", ["Moderno", "Clássico"]],
] as const) {
  test(`M28 (${locale}): the switch reads '${title}': ${names.join(", ")}`, async ({ page }) => {
    await page.addInitScript((l) => localStorage.setItem("skyjo:locale", l), locale);
    await page.goto("/");
    await expect(page.getByTestId("looks").locator("legend")).toHaveText(title);
    for (const name of names) {
      await expect(page.getByTestId("looks").getByRole("button", { name })).toBeVisible();
    }
    await expectMobileFriendly(page);
  });
}

test("M28: in Modern, 2–8 players fit at the device's width and at 360 px: no sideways scroll, targets ≥ 44 px, opponents' numbers ≥ 12 px, and your cards as wide as in Classic (±3 px)", async ({
  page,
}) => {
  const device = page.viewportSize() ?? { width: 390, height: 664 };
  const cardWidth = async () =>
    (await page.getByTestId("my-grid").locator(".card").first().boundingBox())?.width ?? 0;
  for (const size of [device, { width: 360, height: 740 }]) {
    await page.setViewportSize(size);
    for (let players = 2; players <= 8; players++) {
      const turn = atTurnStart(players);
      const table: Shown = {
        ...turn,
        wait: [{ seat: turn.seat ?? 0, inMs: 8_950, reason: "timer" }],
      };
      await show(page, table);
      const classic = await cardWidth();
      await expect(page.getByTestId("opponent").first().locator(".av")).toBeHidden();
      await page.evaluate(() => localStorage.setItem("skyjo:theme", "casual"));
      await showModern(page, table);
      const where = `${players} seats at ${size.width} px`;
      expect(await look(page), where).toBe("casual");
      await expect(page.getByTestId("clock")).toBeVisible();
      // In its last 10 s the clock's seconds are orange, not Modern's mint.
      await expect(page.locator(".secs")).toHaveCSS("color", "rgb(255, 166, 48)");
      await expectMobileFriendly(page);
      await expect(page.getByTestId("opponent")).toHaveCount(players - 1);
      const smallest = await page.evaluate(() =>
        Math.min(
          ...[...document.querySelectorAll('[data-testid="opponent"] :is(.num, .sum)')].map((n) =>
            Number.parseFloat(getComputedStyle(n).fontSize),
          ),
        ),
      );
      expect(smallest, where).toBeGreaterThanOrEqual(12);
      expect(Math.abs((await cardWidth()) - classic), where).toBeLessThanOrEqual(3);
      // Each opponent has a disc with their initial; Classic draws none.
      await expect(page.getByTestId("opponent").first().locator(".av")).toBeVisible();
      await page.evaluate(() => localStorage.setItem("skyjo:theme", "classic"));
    }
  }
});

test("M28: in Modern, 8 players' summary fits a small phone, and the prompts stay within 2 lines in en, es and pt", async ({
  page,
}) => {
  await modern(page);
  await page.setViewportSize({ width: 360, height: 640 });
  await showModern(page, {
    view: { ...toView(roundOver(8, 3)), phase: "roundOver", winners: [] },
    seat: 0,
    lead: true,
  });
  await expect(page.getByRole("button", { name: "Next round" })).toBeInViewport({ ratio: 1 });
  const sheet = page.getByTestId("round-summary").locator(".sheet");
  expect(await sheet.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(0);
  await expectMobileFriendly(page);
  const state = firstTurn(4, 5);
  const view = toView(apply(state, { type: "draw", seat: state.current, source: "deck" }));
  for (const locale of ["en", "es", "pt"]) {
    await page.addInitScript((l) => localStorage.setItem("skyjo:locale", l), locale);
    await showModern(page, { view, seat: state.current });
    const lines = () =>
      page.getByTestId("prompt").evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return new Set([...range.getClientRects()].map((r) => Math.round(r.bottom))).size;
      });
    expect(await lines(), locale).toBeLessThanOrEqual(2);
    for (const label of await page.locator(".piles .pile-label").all()) {
      expect((await label.boundingBox())?.height, locale).toBeLessThan(22);
    }
    await page.getByTestId("discard").click();
    expect(await lines(), `${locale}, discard mode`).toBeLessThanOrEqual(2);
    await expectMobileFriendly(page);
  }
});

test("M28: numerals pass WCAG AA in both looks: on every band, the digit against its outline or its card is 4.5:1 or more", async ({
  page,
}) => {
  const state = lastTurnGame(4, 3);
  const grid = state.players[state.current].grid;
  for (const [pos, card] of [-2, 0, 3, 7, 12].entries()) grid[pos] = { card, up: true };
  const ratios = () =>
    page.evaluate(() => {
      const probe = document.createElement("canvas").getContext("2d");
      const rgb = (color: string) => {
        if (!probe) return [0, 0, 0];
        probe.fillStyle = color;
        probe.fillRect(0, 0, 1, 1);
        return [...probe.getImageData(0, 0, 1, 1).data].slice(0, 3);
      };
      const light = (color: string) => {
        const [r, g, b] = rgb(color).map((v) => {
          const c = v / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      return [...document.querySelectorAll('[data-testid="my-grid"] .card.up')]
        .slice(0, 5)
        .map((card) => {
          const style = getComputedStyle(card);
          const num = getComputedStyle(card.querySelector(".num") as Element);
          // What the digit's edge meets: its outline, or with none (Modern's 0) the card's face.
          const stroke = Number.parseFloat(num.webkitTextStrokeWidth) > 0;
          const around = stroke
            ? style.getPropertyValue("--ink")
            : style.getPropertyValue("--c2") || "#000";
          const [a, b] = [light(num.color), light(around)].sort((x, y) => y - x);
          return Math.round(((a + 0.05) / (b + 0.05)) * 10) / 10;
        });
    });
  for (const theme of ["classic", "casual"]) {
    await page.addInitScript((t) => localStorage.setItem("skyjo:theme", t), theme);
    await show(page, { view: toView(state), seat: state.current });
    expect(await look(page)).toBe(theme);
    for (const ratio of await ratios()) expect(ratio, theme).toBeGreaterThanOrEqual(4.5);
  }
});

test("M28: mid-game, the round label opens the looks: the table changes look at once, the game goes on, and the choice is saved; closing the sheet gives focus back", async ({
  page,
}) => {
  await modern(page);
  const state = firstTurn(4, 5);
  await show(page, { view: toView(state), seat: state.current });
  expect(await paint(page, "discard")).toBe("drawn");
  await expect(page.locator(".num").first()).toHaveCSS("font-family", /Barlow Condensed/);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check('700 20px "Barlow Condensed"'))).toBe(true);
  expect(await page.evaluate(() => document.fonts.check('800 16px "Nunito Sans"'))).toBe(true);
  const opener = page.getByRole("button", { name: "Round 1. Look" });
  await expect(opener).toBeVisible();
  await opener.click();
  const sheet = page.getByTestId("look-sheet");
  await expect(sheet).toBeVisible();
  await expectMobileFriendly(page);
  await sheet.getByRole("button", { name: "Classic" }).click();
  expect(await look(page)).toBe("classic");
  expect(await paint(page, "discard")).toBe("art");
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(opener).toBeFocused();
  // The game goes on in the new look: the next view draws as before.
  const next = apply(state, legalActions(state)[0]);
  await page.evaluate(
    (view) => window.dispatchEvent(new CustomEvent("skyjo:table", { detail: { view } })),
    toView(next),
  );
  await expect(page.getByTestId("table")).toHaveAttribute("data-phase", "place");
  expect(await paint(page, "drawn")).toBe("art");
  // Escape closes the sheet too, and Modern comes back the same way.
  await opener.click();
  await sheet.getByRole("button", { name: "Modern" }).click();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  expect(await paint(page, "drawn")).toBe("drawn");
  expect(await page.evaluate(() => localStorage.getItem("skyjo:theme"))).toBe("casual");
});

test("M28: two phones at one table hold different looks: Ana switches to Classic mid-game, Ben stays on Modern, and both keep playing", async ({
  browser,
}, info) => {
  const { pages } = await seatedRoom(browser, info, ["Ana", "Ben"]);
  const [ana, ben] = pages;
  await startGame(ana);
  await expect(ben.getByTestId("table")).toHaveAttribute("data-phase", "flip");
  expect([await look(ana), await look(ben)]).toEqual(["casual", "casual"]);
  await ana.getByRole("button", { name: "Round 1. Look" }).click();
  await ana.getByTestId("look-sheet").getByRole("button", { name: "Classic" }).click();
  await ana.getByTestId("look-sheet").getByRole("button", { name: "Close" }).click();
  expect([await look(ana), await look(ben)]).toEqual(["classic", "casual"]);
  expect([await paint(ana, "deck"), await paint(ben, "deck")]).toEqual(["art", "drawn"]);
  // Both flip their two cards and the first turn is played: the looks change nothing of the game.
  for (let step = 0; step < 8; step++) {
    await botStep(ana);
    await botStep(ben);
  }
  await expect(ana.getByTestId("table")).not.toHaveAttribute("data-phase", "flip");
  await expect(ben.getByTestId("table")).not.toHaveAttribute("data-phase", "flip");
  expect([await look(ana), await look(ben)]).toEqual(["classic", "casual"]);
  // Ana's reload keeps her look, and her seat.
  await ana.reload();
  await expect(ana.getByTestId("my-grid")).toBeVisible();
  expect(await look(ana)).toBe("classic");
  // Before the app's code runs: index.html sets a Classic player's look itself.
  expect(
    await ana.evaluate(() => document.querySelector("head script:not([src])")?.textContent),
  ).toContain("skyjo:theme");
});

test("M28: the service worker precaches the default look's fonts", async ({ page }, info) => {
  test.skip(!!process.env.BASE_URL || process.env.SERVER === "node", "runs on the Worker build");
  test.skip(info.project.name !== "pixel", "one browser reads the built file");
  await page.goto("/");
  const sw = await page.evaluate(async () => (await fetch("/sw.js")).text());
  expect(sw).toContain('"/fonts/barlow-condensed-700-latin.woff2"');
  expect(sw).toContain('"/fonts/nunito-sans-800-latin.woff2"');
  for (const file of ["barlow-condensed-700-latin", "nunito-sans-800-latin"]) {
    const res = await page.request.get(`/fonts/${file}.woff2`);
    expect(res.status()).toBe(200);
  }
});

test("screenshots: M28 the two looks", async ({ page }, info) => {
  test.skip(!process.env.SHOTS || info.project.name !== "iphone", "run with SHOTS=1");
  await page.setViewportSize({ width: 390, height: 844 });
  const shot = async (name: string) => {
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: `docs/screenshots/m28/${name}.jpg`,
      type: "jpeg",
      quality: 85,
      scale: "css",
    });
  };
  await modern(page);
  await page.goto("/");
  await shot("01-home");
  // The mockup's states (docs/screenshots/m28/target-*.jpg).
  await show(page, m27Table());
  await shot("02-your-turn");
  await page.getByRole("button", { name: "Round 3. Look" }).click();
  await shot("03-look-sheet");
  await show(page, m27Summary());
  await shot("04-summary");
  const eight = atTurnStart(8);
  await page.setViewportSize({ width: 390, height: 664 });
  await show(page, eight);
  await shot("05-eight-players");
  await page.getByTestId("opponent").first().click();
  await shot("06-zoom-and-throws");
  const over = roundOver(8, 3);
  await show(page, { view: toView(over), seat: over.winners[0] ?? 0, lead: true });
  await shot("07-game-over");
});

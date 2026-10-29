// Reactions (M23): the button by your grid (or in your name bar), its fan, each reaction on the
// right seat, and the server path between two phones.
import { expect, type Page } from "@playwright/test";
import { apply, createGame } from "../src/engine/game";
import { toView } from "../src/engine/view";
import type { Reaction } from "../src/protocol";
import { atTurnStart, firstTurn, lastTurnGame, roundOver, show } from "./harness";
import { botStep, expectMobileFriendly, playUntil, seatedRoom, startGame, test } from "./helpers";

const react = (page: Page, reaction: Omit<Reaction, "id">) =>
  page.evaluate((reaction) => {
    const detail = { reaction: { ...reaction, id: Math.floor(Math.random() * 2 ** 31) } };
    window.dispatchEvent(new CustomEvent("skyjo:table", { detail }));
  }, reaction);

const box = async (page: Page, selector: string) => {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`no box for ${selector}`);
  return b;
};

/** The seat whose panel is the n-th in the strip (names are "Player <seat + 1>"). */
const seatOf = async (page: Page, n: number) =>
  Number(
    ((await page.getByTestId("opponent").nth(n).locator(".opp-name").textContent()) ?? "").replace(
      /\D/g,
      "",
    ),
  ) - 1;

test("M23: the button sits by your grid's third row, or in your name bar on a phone the cards fill; ≥ 44 px, covering no card", async ({
  page,
}, info) => {
  for (const players of [2, 8]) {
    const turn = atTurnStart(players);
    await show(page, turn);
    const button = page.getByTestId("react-button");
    await expect(button).toHaveCount(1);
    const b = await box(page, "[data-testid=react-button]");
    expect(Math.min(b.width, b.height)).toBeGreaterThanOrEqual(44);
    const vp = page.viewportSize() ?? { width: 0, height: 0 };
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(vp.width);
    expect(b.y + b.height).toBeLessThanOrEqual(vp.height);
    await expectMobileFriendly(page);
    const cards = await page
      .getByTestId("my-grid")
      .locator(".card")
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON() as DOMRect));
    // No card loses size to it (Pixel 7's stay 91 px wide).
    for (const c of cards)
      expect(c.width).toBeGreaterThanOrEqual(info.project.name === "pixel" ? 87 : 44);
    for (const c of cards) {
      const apart =
        b.x >= c.right || b.x + b.width <= c.left || b.y >= c.bottom || b.y + b.height <= c.top;
      expect(apart).toBe(true);
    }
    // Every card still takes its tap at its centre.
    const hits = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="my-grid"] .card')].every((card) => {
        const r = card.getBoundingClientRect();
        return card.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      }),
    );
    expect(hits).toBe(true);
    const cy = b.y + b.height / 2;
    if (info.project.name === "pixel") {
      const bar = await box(page, "[data-testid=mine-head]");
      expect(cy).toBeGreaterThan(bar.y);
      expect(cy).toBeLessThan(bar.y + bar.height);
    } else {
      const row3 = cards[11];
      expect(cy).toBeGreaterThanOrEqual(row3.top);
      expect(cy).toBeLessThanOrEqual(row3.bottom);
      expect(b.x).toBeGreaterThanOrEqual(row3.right + 4);
    }
  }
  // The "Fun" switch takes it away with the throws.
  await page.getByTestId("opponent").first().click();
  await page.getByRole("checkbox", { name: "Fun" }).click();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("react-button")).toHaveCount(0);
  await page.getByTestId("opponent").first().click();
  await page.getByRole("checkbox", { name: "Fun" }).click();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("react-button")).toHaveCount(1);
  // Spectators get none, nor does anyone at the summary.
  await show(page, { ...atTurnStart(4), seat: null });
  await expect(page.getByTestId("react-button")).toHaveCount(0);
  const over = roundOver(2, 11);
  await show(page, { view: toView(over), seat: 0 });
  await expect(page.getByTestId("round-summary")).toBeVisible();
  await expect(page.getByTestId("react-button")).toHaveCount(0);
});

test("M23: the fan opens 4 big reactions on screen and closes on Escape, on a choice and on a tap outside, which still reaches your card", async ({
  page,
}) => {
  await show(page, atTurnStart(4));
  const button = page.getByTestId("react-button");
  const fan = page.getByTestId("react-fan");
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  const items = fan.getByRole("button");
  await expect(items).toHaveCount(4);
  const vp = page.viewportSize() ?? { width: 0, height: 0 };
  for (const b of await items.evaluateAll((els) =>
    els.map((el) => el.getBoundingClientRect().toJSON() as DOMRect),
  )) {
    expect(Math.min(b.width, b.height)).toBeGreaterThanOrEqual(44);
    expect(b.left).toBeGreaterThanOrEqual(0);
    expect(b.top).toBeGreaterThanOrEqual(0);
    expect(b.right).toBeLessThanOrEqual(vp.width);
    expect(b.bottom).toBeLessThanOrEqual(vp.height);
  }
  // Someone moved before you: the migajero is at them.
  await expect(fan.getByRole("button", { name: "Pigeon feeder" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(fan).toHaveCount(0);
  await expect(button).toBeFocused();
  await button.click();
  await fan.getByRole("button", { name: "Laugh" }).click();
  await expect(fan).toHaveCount(0);
  // It rests like the throws.
  await expect(button).toBeDisabled();
  await expect(button).toBeEnabled({ timeout: 4_000 });

  // In the opening flip a tap on your card closes the fan and turns the card over.
  await show(page, { view: toView(createGame(["Ana", "Ben"], [3, 0, 0, 0])), seat: 0 });
  await button.click();
  await expect(fan.getByRole("button", { name: "Pigeon feeder" })).toBeDisabled();
  const card = page.getByTestId("my-grid").locator(".card").first();
  await card.click();
  await expect(fan).toHaveCount(0);
  await expect(card).toHaveAttribute("data-pending", "true");

  // At a round's first turn there's nobody to call a migajero.
  await show(page, { view: toView(firstTurn(3, 3)), seat: 0 });
  await button.click();
  await expect(fan.getByRole("button", { name: "Pigeon feeder" })).toBeDisabled();
});

test("M23: the migajero is greyed out when the last mover is you", async ({ page }) => {
  const turn = atTurnStart(3);
  const me = ((turn.seat ?? 0) + 2) % 3; // the seat before the one to move
  await show(page, { ...turn, seat: me });
  await page.getByTestId("react-button").click();
  await expect(
    page.getByTestId("react-fan").getByRole("button", { name: "Pigeon feeder" }),
  ).toBeDisabled();
});

test("M23: each reaction shows on its seat: laugh on the reactor's panel or your name bar, the migajero on its target with a sign naming the reactor", async ({
  page,
}) => {
  const turn = atTurnStart(4);
  const me = turn.seat ?? 0;
  await show(page, turn);
  const panel = page.getByTestId("opponent").first();
  const them = await seatOf(page, 0);
  const sticker = page.getByTestId("reaction");
  const centre = async () => {
    const b = await sticker.boundingBox();
    if (!b) throw new Error("no sticker");
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const inside = (p: { x: number; y: number }, b: { x: number; y: number; width: number }) =>
    p.x >= b.x && p.x <= b.x + b.width;

  await react(page, { from: them, kind: "laugh" });
  await expect(sticker).toHaveAttribute("data-kind", "laugh");
  expect(inside(await centre(), (await panel.boundingBox()) ?? { x: 0, y: 0, width: 0 })).toBe(
    true,
  );
  await expect(
    page.getByRole("status").filter({ hasText: `Player ${them + 1} laughs` }),
  ).toHaveCount(1);
  await expect(sticker.locator(".react-gag")).toHaveText("Hahaha!");
  expect(await sticker.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
  await expect(sticker).toHaveCount(0, { timeout: 4_000 });

  await react(page, { from: me, kind: "love" });
  const bar = await box(page, "[data-testid=mine-head]");
  const c = await centre();
  expect(c.y).toBeLessThan(bar.y + bar.height);
  expect(c.y).toBeGreaterThan(bar.y - 80);
  await expect(sticker).toHaveCount(0, { timeout: 4_000 });

  await react(page, { from: me, kind: "migajero", to: them });
  await expect(sticker).toHaveAttribute("data-kind", "migajero");
  expect(inside(await centre(), (await panel.boundingBox()) ?? { x: 0, y: 0, width: 0 })).toBe(
    true,
  );
  const sign = page.getByTestId("migajero-sign");
  await expect(sign).toContainText("PIGEON FEEDER!");
  await expect(sign).toContainText(`— Player ${me + 1}`);
  const s = await sign.boundingBox();
  const vp = page.viewportSize() ?? { width: 0, height: 0 };
  if (!s) throw new Error("no sign");
  expect(s.x).toBeGreaterThanOrEqual(0);
  expect(s.y).toBeGreaterThanOrEqual(0);
  expect(s.x + s.width).toBeLessThanOrEqual(vp.width);
  // Reduced motion: nothing moves but opacity.
  const moving = await page.evaluate(() =>
    document
      .querySelector("[data-testid=reaction]")
      ?.getAnimations({ subtree: true })
      .flatMap((a) =>
        (a.effect as KeyframeEffect)
          .getKeyframes()
          .flatMap((k) => Object.keys(k))
          .filter(
            (p) => !["offset", "computedOffset", "easing", "composite", "opacity"].includes(p),
          ),
      ),
  );
  expect(moving).toEqual([]);
});

test("M23: a throw or reaction at a panel scrolled out of the strip brings it into view and lands on it", async ({
  page,
}) => {
  const turn = atTurnStart(8);
  const me = turn.seat ?? 0;
  await show(page, turn);
  const strip = page.getByTestId("opponents");
  const last = page.getByTestId("opponent").last();
  const target = await seatOf(page, 6);
  const out = async () => {
    const [p, s] = await Promise.all([last.boundingBox(), strip.boundingBox()]);
    if (!p || !s) throw new Error("no box");
    return p.x >= s.x + s.width || p.x + p.width <= s.x;
  };
  expect(await out()).toBe(true);
  const from = [0, 1, 2, 3, 4, 5, 6, 7].find((s) => s !== me && s !== target) ?? 0;
  await page.evaluate(
    (toss) =>
      window.dispatchEvent(
        new CustomEvent("skyjo:table", { detail: { toss: { ...toss, id: 7 } } }),
      ),
    { from, to: target, item: "tomato" },
  );
  const onTarget = async (selector: string) => {
    const [t, p] = await Promise.all([page.locator(selector).boundingBox(), last.boundingBox()]);
    if (!t || !p) return false;
    const x = t.x + t.width / 2;
    return x >= p.x && x <= p.x + p.width;
  };
  await expect.poll(() => onTarget("[data-testid=toss]")).toBe(true);
  expect(await out()).toBe(false);
  await expect(page.getByTestId("toss")).toHaveCount(0, { timeout: 5_000 });

  // The same for a migajero at a seat out of view.
  await strip.evaluate((el) => el.scrollTo({ left: 0, behavior: "instant" }));
  expect(await out()).toBe(true);
  await react(page, { from: me, kind: "migajero", to: target });
  await expect.poll(() => onTarget("[data-testid=reaction]")).toBe(true);

  // A laugh from there doesn't scroll: it shows at the strip's edge, saying who.
  await expect(page.getByTestId("reaction")).toHaveCount(0, { timeout: 4_000 });
  await strip.evaluate((el) => el.scrollTo({ left: 0, behavior: "instant" }));
  await react(page, { from: target, kind: "laugh" });
  await expect(page.locator(".react-gag")).toHaveText(`Player ${target + 1}: Hahaha!`);
  expect(await strip.evaluate((el) => el.scrollLeft)).toBe(0);
  expect(await out()).toBe(true);
});

test("M23: your choice keeps the focus on the button, which rests", async ({ page }) => {
  await show(page, atTurnStart(3));
  const button = page.getByTestId("react-button");
  await button.click();
  await page.getByTestId("react-fan").getByRole("button", { name: "Love" }).click();
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute("aria-disabled", "true");
  await button.click({ force: true });
  await expect(page.getByTestId("react-fan")).toHaveCount(0);
});

for (const [locale, auto] of [
  ["es-MX", "Juego automático"],
  ["pt-BR", "Jogada automática"],
] as const) {
  test.describe(`${locale}, a long name`, () => {
    test.use({ locale });

    test(`M23: the name bar holds a long name, "${auto}" and the button without overlap`, async ({
      page,
    }, info) => {
      test.skip(info.project.name !== "pixel", "the bar placement: Pixel 7");
      const turn = atTurnStart(4);
      const me = turn.seat ?? 0;
      turn.view.players[me].name = "Maximiliano Gómz"; // NAME_MAX, 16
      await show(page, turn);
      await expect(page.getByTestId("mine-head")).toContainText(auto);
      await expectMobileFriendly(page);
      const rects = await page.evaluate(() => {
        const r = (s: string) =>
          document.querySelector(`[data-testid=mine-head] ${s}`)?.getBoundingClientRect().toJSON();
        return {
          me: r(".me"),
          sum: r("[data-testid=sum]"),
          auto: r(".auto"),
          button: r("[data-testid=react-button]"),
        };
      });
      const apart = (a: DOMRect, b: DOMRect) => a.right <= b.left || b.right <= a.left;
      expect(apart(rects.me, rects.auto)).toBe(true);
      expect(apart(rects.auto, rects.button)).toBe(true);
      expect(Math.min(rects.button.width, rects.button.height)).toBeGreaterThanOrEqual(44);
      // Only the name gives way: your points and round score stay whole.
      expect(rects.sum.right).toBeLessThanOrEqual(rects.auto.left);
      expect(rects.sum.right).toBeLessThanOrEqual(rects.me.right + 1);
      expect(rects.button.right).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
    });
  });
}

test.describe("with motion", () => {
  test.use({ reducedMotion: "no-preference" });

  test("M23: a throw at a panel out of view waits for the move's cards to land before scrolling to it; a laugh never scrolls", async ({
    page,
  }) => {
    await page.clock.install();
    const turn = atTurnStart(8);
    const me = turn.seat ?? 0;
    await show(page, turn);
    const strip = page.getByTestId("opponents");
    const last = page.getByTestId("opponent").last();
    const target = await seatOf(page, 6);
    const out = async () => {
      const [p, s] = await Promise.all([last.boundingBox(), strip.boundingBox()]);
      if (!p || !s) throw new Error("no box");
      return p.x >= s.x + s.width - 24;
    };
    expect(await out()).toBe(true);
    const from = [0, 1, 2, 3, 4, 5, 6, 7].find((s) => s !== me && s !== target) ?? 0;
    // You draw from the deck (the turn stays yours) as someone else's laugh, then a throw, arrive.
    const drawn = toView(apply(lastTurnGame(8, 3), { type: "draw", seat: me, source: "deck" }));
    await page.evaluate(
      (detail) => window.dispatchEvent(new CustomEvent("skyjo:table", { detail })),
      { view: drawn, reaction: { id: 5, from: target, kind: "laugh" } },
    );
    await expect(page.locator(".react-gag")).toHaveText(`Player ${target + 1}: Hahaha!`);
    await page.evaluate(
      (detail) => window.dispatchEvent(new CustomEvent("skyjo:table", { detail })),
      { toss: { id: 6, from, to: target, item: "tomato" } },
    );
    await page.clock.runFor(50);
    expect(await strip.evaluate((el) => el.scrollLeft)).toBe(0);
    await page.clock.runFor(1_000);
    await expect.poll(out).toBe(false);
  });

  test("M23: the open fan stays under your thumb while a throw knocks your name bar", async ({
    page,
  }, info) => {
    test.skip(info.project.name !== "pixel", "the fan in the name bar: Pixel 7");
    const turn = atTurnStart(4);
    const me = turn.seat ?? 0;
    await show(page, turn);
    await page.getByTestId("react-button").click();
    const fan = page.getByTestId("react-fan");
    await expect(fan.getByRole("button")).toHaveCount(4);
    await page.waitForTimeout(300); // the fan's spring-out
    const at = () =>
      fan
        .getByRole("button", { name: "Laugh" })
        .evaluate((el) => Math.round(el.getBoundingClientRect().top));
    const before = await at();
    await page.evaluate(
      (detail) => window.dispatchEvent(new CustomEvent("skyjo:table", { detail })),
      { toss: { id: 9, from: (me + 1) % 4, to: me, item: "bomb" } },
    );
    // Sampled through the throw's knock on your bar and the quake of the table.
    const tops = await page.evaluate(
      () =>
        new Promise<number[]>((done) => {
          const seen: number[] = [];
          const t0 = performance.now();
          const frame = () => {
            const el = document.querySelector('[data-testid=react-fan] [data-kind="laugh"]');
            if (el) seen.push(Math.round(el.getBoundingClientRect().top));
            if (performance.now() - t0 < 1_400) requestAnimationFrame(frame);
            else done(seen);
          };
          requestAnimationFrame(frame);
        }),
    );
    expect(tops.length).toBeGreaterThan(0);
    for (const top of tops) expect(Math.abs(top - before)).toBeLessThanOrEqual(1);
  });

  test("M23: each sticker is in place at 300 ms and gone by 2.9 s; the pigeon lands at 820 ms and its sign hangs still by 1.6 s", async ({
    page,
  }) => {
    await page.clock.install();
    const turn = atTurnStart(4);
    const me = turn.seat ?? 0;
    await show(page, turn);
    const them = await seatOf(page, 0);
    const head = await box(page, "[data-testid=opponent] .opp-head");
    /** Freezes every animation of the reaction at `ms` and returns its sticker's box. */
    const at = (ms: number) =>
      page.evaluate((ms) => {
        const el = document.querySelector("[data-testid=reaction]");
        for (const a of el?.getAnimations({ subtree: true }) ?? []) {
          a.pause();
          a.currentTime = ms;
        }
        return el?.querySelector(".react-face")?.getBoundingClientRect().toJSON() as DOMRect;
      }, ms);
    for (const kind of ["laugh", "love", "anger"] as const) {
      await react(page, { from: them, kind });
      await expect(page.getByTestId("reaction")).toHaveCount(1);
      const b = await at(300);
      expect(b.width).toBeGreaterThan(50);
      expect(Math.abs(b.x + b.width / 2 - (head.x + head.width / 2))).toBeLessThan(12);
      await page.clock.runFor(2900);
      await expect(page.getByTestId("reaction")).toHaveCount(0);
    }
    await react(page, { from: me, kind: "migajero", to: them });
    await expect(page.getByTestId("reaction")).toHaveCount(1);
    const early = await at(400);
    const landed = await at(900);
    expect(Math.abs(landed.x + landed.width / 2 - (head.x + head.width / 2))).toBeLessThan(12);
    expect(Math.abs(early.y - landed.y)).toBeGreaterThan(40); // still on its way at 400 ms
    await at(1600);
    expect(
      await page
        .getByTestId("migajero-sign")
        .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).isIdentity),
    ).toBe(true);
    await page.clock.runFor(2900);
    await expect(page.getByTestId("reaction")).toHaveCount(0);
  });
});

for (const [locale, word] of [
  ["es-MX", "¡MIGAJERO!"],
  ["pt-BR", "MIGALHEIRO!"],
] as const) {
  test.describe(locale, () => {
    test.use({ locale });

    test(`M23: the sign reads ${word}`, async ({ page }) => {
      const turn = atTurnStart(3);
      const me = turn.seat ?? 0;
      await show(page, turn);
      await react(page, { from: me, kind: "migajero", to: await seatOf(page, 0) });
      await expect(page.getByTestId("migajero-sign")).toContainText(word);
    });
  });
}

test("M23: Ana laughs and calls Ben a migajero between two phones: both see it, Ben feels the peck, and her button rests 3 s", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "pixel", "the server path; one device is enough");
  const { pages } = await seatedRoom(browser, info, ["Ana", "Ben"]);
  const [ana, ben] = pages;
  await ben.evaluate(() => {
    const w = window as unknown as { buzzes: number[][] };
    w.buzzes = [];
    Object.defineProperty(navigator, "userActivation", { value: { hasBeenActive: true } });
    navigator.vibrate = (p) => {
      w.buzzes.push([p].flat() as number[]);
      return true;
    };
  });
  await startGame(ana);
  const button = ana.getByTestId("react-button");
  await button.click();
  await ana.getByRole("button", { name: "Laugh" }).click();
  const benSees = ben.locator('[data-testid="reaction"][data-kind="laugh"]');
  await expect(benSees).toHaveCount(1);
  const [s, panel] = await Promise.all([
    benSees.boundingBox(),
    ben.getByTestId("opponent").boundingBox(),
  ]);
  if (!s || !panel) throw new Error("no box");
  expect(s.x + s.width / 2).toBeGreaterThanOrEqual(panel.x);
  expect(s.x + s.width / 2).toBeLessThanOrEqual(panel.x + panel.width);
  await expect(ana.locator('[data-testid="reaction"][data-kind="laugh"]')).toHaveCount(1);
  await expect(button).toBeDisabled();
  await expect(button).toBeEnabled({ timeout: 4_000 });
  // A throw rests it too.
  await ana.getByTestId("opponent").click();
  await ana.getByRole("button", { name: "Kiss" }).click();
  await expect(button).toBeDisabled();
  // Her move right after goes through.
  expect(await botStep(ana)).toBe(true);

  // Once Ben has moved, Ana calls him a migajero on her turn.
  await playUntil(pages, async () => {
    const table = ana.getByTestId("table");
    return (
      (await table.getAttribute("data-myturn")) === "true" &&
      (await table.getAttribute("data-phase")) === "draw" &&
      !(await ana.getByTestId("prompt").textContent())?.includes("highest pair")
    );
  });
  await expect(button).toBeEnabled({ timeout: 4_000 });
  await button.click();
  await ana.getByRole("button", { name: "Pigeon feeder" }).click();
  const sign = ben.getByTestId("migajero-sign");
  await expect(sign).toContainText("PIGEON FEEDER!");
  await expect(sign).toContainText("— Ana");
  await expect
    .poll(() => ben.evaluate(() => (window as unknown as { buzzes: number[][] }).buzzes))
    .toContainEqual([15, 60, 15]);
  expect(await botStep(ana)).toBe(true);
});

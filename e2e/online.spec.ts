import { type Browser, expect, type Page, type TestInfo, test } from "@playwright/test";

/** Separate browser contexts = separate phones (own storage, own token). */
async function phones(browser: Browser, info: TestInfo, n: number): Promise<Page[]> {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, locale, baseURL } =
    info.project.use;
  return Promise.all(
    Array.from({ length: n }, async () => {
      const context = await browser.newContext({
        viewport,
        userAgent,
        deviceScaleFactor,
        isMobile,
        hasTouch,
        locale,
        baseURL,
      });
      return context.newPage();
    }),
  );
}

async function createRoom(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByRole("button", { name: "Create a room" }).click();
  await page.waitForURL(/\/r\/[A-Z0-9]{5}$/);
  return new URL(page.url()).pathname.slice(3);
}

async function join(page: Page, code: string, name: string) {
  if (!page.url().endsWith(`/r/${code}`)) await page.goto(`/r/${code}`);
  await page.getByRole("textbox", { name: "Your name" }).fill(name);
  await page.getByRole("button", { name: "Join", exact: true }).click();
  await expect(page.getByTestId("seats")).toContainText(name);
}

/** A room with `names.length` seated phones; the first created it and hosts. */
async function seatedRoom(browser: Browser, info: TestInfo, names: string[]) {
  const pages = await phones(browser, info, names.length);
  const code = await createRoom(pages[0]);
  for (const [i, page] of pages.entries()) await join(page, code, names[i]);
  return { pages, code };
}

/**
 * Makes one move on `page` if it's that phone's turn (flip, draw from deck, discard then flip),
 * or advances the round as host. Waits for the server's answer before returning true.
 */
async function botStep(page: Page): Promise<boolean> {
  const table = page.getByTestId("table");
  const phase = await table.getAttribute("data-phase");
  const next = page.getByRole("button", { name: "Next round" });
  if (phase === "roundOver") {
    if (!(await next.count())) return false;
    await next.click();
    await expect(table).not.toHaveAttribute("data-phase", "roundOver");
    return true;
  }
  if ((await table.getAttribute("data-myturn")) !== "true") return false;
  const grid = page.getByTestId("my-grid");
  const faceDown = grid.locator('button[data-face="down"]');
  if (phase === "flip") {
    const before = await grid.locator('[data-face="down"]').count();
    await faceDown.first().click();
    await expect(grid.locator('[data-face="down"]')).toHaveCount(before - 1);
  } else if (phase === "draw") {
    await page.getByTestId("deck").click();
    await expect(page.getByTestId("drawn")).toBeVisible();
  } else if (phase === "place") {
    await page.getByTestId("discard").click();
    await expect(page.getByText("Tap a face-down card to flip it")).toBeVisible();
    await faceDown.first().click();
    await expect(table).not.toHaveAttribute("data-phase", "place");
  }
  return true;
}

async function playToEnd(pages: Page[]) {
  const over = pages[0].getByTestId("game-over");
  for (let idle = 0; !(await over.count()); ) {
    let moved = false;
    for (const page of pages) moved = (await botStep(page)) || moved;
    idle = moved ? 0 : idle + 1;
    if (idle > 200) throw new Error("table stalled");
  }
}

const startGame = async (host: Page) => {
  await host.getByRole("button", { name: "Start game" }).click();
  await expect(host.getByTestId("table")).toHaveAttribute("data-phase", "flip");
};

test("two phones create, join, and play a full game to 100", async ({ browser }, info) => {
  test.skip(info.project.name !== "pixel", "long play-throughs run on Pixel only");
  const { pages } = await seatedRoom(browser, info, ["Ana", "Ben"]);
  await expect(pages[1].getByText("Waiting for the host…")).toBeVisible();
  await startGame(pages[0]);
  await playToEnd(pages);
  for (const page of pages) await expect(page.getByTestId("game-over")).toBeVisible();
  // Only the host can rematch.
  await expect(pages[1].getByRole("button", { name: "Play again" })).toHaveCount(0);
  await pages[0].getByRole("button", { name: "Play again" }).click();
  await expect(pages[1].getByTestId("table")).toHaveAttribute("data-phase", "flip");
});

test("8 phones finish a game", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "8-context play-through runs on Desktop only");
  test.setTimeout(600_000);
  const names = ["Ana", "Ben", "Cris", "Dani", "Eli", "Fer", "Gabi", "Hugo"];
  const { pages } = await seatedRoom(browser, info, names);
  await startGame(pages[0]);
  await playToEnd(pages);
});

test("a reload mid-game keeps your seat", async ({ browser }, info) => {
  const { pages } = await seatedRoom(browser, info, ["Ana", "Ben"]);
  await startGame(pages[0]);
  await botStep(pages[1]);
  await pages[1].reload();
  const grid = pages[1].getByTestId("my-grid");
  await expect(grid.locator('[data-face="up"]')).toHaveCount(1);
  await expect(pages[1].getByText("Ben", { exact: true })).toBeVisible();
});

test("a phone that joins mid-game watches without a grid", async ({ browser }, info) => {
  const { pages, code } = await seatedRoom(browser, info, ["Ana", "Ben"]);
  await startGame(pages[0]);
  const [watcher] = await phones(browser, info, 1);
  await watcher.goto(`/r/${code}`);
  await expect(watcher.getByText("You're watching this game")).toBeVisible();
  await expect(watcher.getByTestId("opponent")).toHaveCount(2);
  await expect(watcher.getByTestId("my-grid")).toHaveCount(0);
  const tooSmall = await watcher.evaluate(
    () =>
      [...document.querySelectorAll("button:not(:disabled)")].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.width < 44 || r.height < 44);
      }).length,
  );
  expect(tooSmall).toBe(0);
});

test("a 9th phone can't take a seat and watches instead", async ({ browser }, info) => {
  test.skip(info.project.name !== "pixel", "9 contexts; one device is enough");
  const names = ["Ana", "Ben", "Cris", "Dani", "Eli", "Fer", "Gabi", "Hugo"];
  const { code } = await seatedRoom(browser, info, names);
  const [ninth] = await phones(browser, info, 1);
  await ninth.goto(`/r/${code}`);
  await expect(ninth.getByText("The room is full (8 players). You can watch.")).toBeVisible();
  await expect(ninth.getByRole("button", { name: "Join", exact: true })).toHaveCount(0);
});

test("an unknown room code says so", async ({ page }) => {
  await page.goto("/r/ZZZZZ");
  await expect(page.getByText("There's no room ZZZZZ.")).toBeVisible();
});

test("joining from the home screen with a code", async ({ browser }, info) => {
  const [host, guest] = await phones(browser, info, 2);
  const code = await createRoom(host);
  await guest.goto("/");
  await guest.getByRole("textbox", { name: "Room code" }).fill(code.toLowerCase());
  await guest.getByRole("button", { name: "Join", exact: true }).click();
  await guest.waitForURL(`**/r/${code}`);
  await expect(guest.getByTestId("room-code")).toHaveText(code);
});

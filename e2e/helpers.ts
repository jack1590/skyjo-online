import {
  type Browser,
  type BrowserContextOptions,
  expect,
  type Page,
  type TestInfo,
} from "@playwright/test";

/** Separate browser contexts = separate phones (own storage, own token). */
export async function phones(
  browser: Browser,
  info: TestInfo,
  n: number,
  extra: BrowserContextOptions = {},
): Promise<Page[]> {
  const {
    viewport,
    userAgent,
    deviceScaleFactor,
    isMobile,
    hasTouch,
    locale,
    baseURL,
    reducedMotion,
  } = info.project.use;
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
        reducedMotion,
        ...extra,
      });
      return context.newPage();
    }),
  );
}

export async function createRoom(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByRole("button", { name: "Create a room" }).click();
  await page.waitForURL(/\/r\/[A-Z0-9]{5}$/);
  return new URL(page.url()).pathname.slice(3);
}

export async function join(page: Page, code: string, name: string) {
  if (!page.url().endsWith(`/r/${code}`)) await page.goto(`/r/${code}`);
  await page.getByRole("textbox", { name: "Your name" }).fill(name);
  await page.getByRole("button", { name: "Join", exact: true }).click();
  await expect(page.getByTestId("seats")).toContainText(name);
}

/** A room with `names.length` seated phones; the first created it and hosts. */
export async function seatedRoom(
  browser: Browser,
  info: TestInfo,
  names: string[],
  extra: BrowserContextOptions = {},
) {
  const pages = await phones(browser, info, names.length, extra);
  const code = await createRoom(pages[0]);
  for (const [i, page] of pages.entries()) await join(page, code, names[i]);
  return { pages, code };
}

/**
 * Makes one move on `page` if it's that phone's turn (flip, draw from deck, discard then flip),
 * or advances the round as host. Waits for the server's answer before returning true.
 */
export async function botStep(page: Page): Promise<boolean> {
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

export async function playToEnd(pages: Page[]) {
  const over = pages[0].getByTestId("game-over");
  for (let idle = 0; !(await over.count()); ) {
    let moved = false;
    for (const page of pages) moved = (await botStep(page)) || moved;
    idle = moved ? 0 : idle + 1;
    if (idle > 200) throw new Error("table stalled");
  }
}

export const startGame = async (host: Page) => {
  await host.getByRole("button", { name: "Start game" }).click();
  await expect(host.getByTestId("table")).toHaveAttribute("data-phase", "flip");
};

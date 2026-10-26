import {
  type Browser,
  type BrowserContextOptions,
  test as base,
  expect,
  type Page,
  type TestInfo,
} from "@playwright/test";

/**
 * Playwright's `test`, closing every phone when the test ends. Playwright closes only the contexts
 * it made, so a phone from `phones()` outlived its test: it stayed in its room, and the next
 * failing test in the worker screenshot it too (7 shots for a 2-phone test, PO PR #29).
 */
export const test = base.extend<{ closePhones: undefined }>({
  closePhones: [
    async ({ browser }, use) => {
      await use(undefined);
      await Promise.all(browser.contexts().map((context) => context.close()));
    },
    { auto: true },
  ],
});

/** Context options, plus `audio: true` to keep Web Audio (only e2e/sound.spec.ts needs it). */
type PhoneOptions = BrowserContextOptions & { audio?: boolean };

/**
 * Separate browser contexts = separate phones (own storage, own token). Web Audio is hidden by
 * default: headless WebKit has no audio device, and a running AudioContext slowed every click
 * enough to time out a 2-phone round (PR #7). Use `test` from this file, which closes them.
 */
export async function phones(
  browser: Browser,
  info: TestInfo,
  n: number,
  { audio = false, ...extra }: PhoneOptions = {},
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
      if (!audio) {
        await context.addInitScript(() => {
          delete (window as { AudioContext?: unknown }).AudioContext; // the app then stays silent
        });
      }
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
  extra: PhoneOptions = {},
) {
  const pages = await phones(browser, info, names.length, extra);
  const code = await createRoom(pages[0]);
  for (const [i, page] of pages.entries()) await join(page, code, names[i]);
  return { pages, code };
}

/**
 * Makes one move on `page` if it's that phone's turn (flip, draw from deck, swap the drawn card
 * into a face-down slot), or advances the round as host. Waits for the server's answer before
 * returning true.
 */
export async function botStep(page: Page): Promise<boolean> {
  // A bot doesn't check tap targets, and CI's WebKit takes ~0.5 s per click to call an element
  // "stable"; forcing skips that wait. Each move is still confirmed by the expect after it.
  const tap = { force: true };
  const table = page.getByTestId("table");
  const phase = await table.getAttribute("data-phase");
  const next = page.getByRole("button", { name: "Next round" });
  if (phase === "roundOver") {
    if (!(await next.count())) return false;
    await next.click(tap);
    await expect(table).not.toHaveAttribute("data-phase", "roundOver");
    return true;
  }
  if ((await table.getAttribute("data-myturn")) !== "true") return false;
  const grid = page.getByTestId("my-grid");
  const faceDown = grid.locator('button[data-face="down"]');
  if (phase === "flip") {
    const before = await grid.locator('[data-face="down"]').count();
    await faceDown.first().click(tap);
    await expect(grid.locator('[data-face="down"]')).toHaveCount(before - 1);
  } else if (phase === "draw") {
    await page.getByTestId("deck").click(tap);
    await expect(page.getByTestId("drawn")).toBeVisible();
  } else if (phase === "place") {
    await faceDown.first().click(tap);
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

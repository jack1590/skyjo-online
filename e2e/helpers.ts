import {
  type Browser,
  type BrowserContextOptions,
  test as base,
  expect,
  type Page,
  type TestInfo,
} from "@playwright/test";

/** The running test's phones (a worker runs one test at a time) and their sockets' closes. */
let phoneCount = 0;
let closes: string[] = [];
let started = 0;

/**
 * Playwright's `test`, closing every phone when the test ends. Playwright closes only the contexts
 * it made, so a phone from `phones()` outlived its test: it stayed in its room, and the next
 * failing test in the worker screenshot it too (7 shots for a 2-phone test, PO PR #29). It also
 * attaches each phone's socket closes, with their codes (a 1008 is the per-IP message limit), and
 * prints them when the test fails (M13, PO PR #31: a live smoke flake left no trace of them).
 */
export const test = base.extend<{ closePhones: undefined }>({
  closePhones: [
    async ({ browser }, use, info) => {
      [phoneCount, closes, started] = [0, [], Date.now()];
      await use(undefined);
      if (phoneCount) {
        const body = closes.join("\n") || "none";
        await info.attach("socket closes", { body, contentType: "text/plain" });
        if (info.status !== info.expectedStatus) console.log(`Socket closes:\n${body}`);
      }
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
  // Numbered as in `pages`, whichever context opens first.
  const first = phoneCount + 1;
  phoneCount += n;
  return Promise.all(
    Array.from({ length: n }, async (_, i) => {
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
      const phone = first + i;
      // Through a binding, so a close is logged even when its page then reloads or dies.
      await context.exposeBinding("__socketClosed", (_, code: number, reason: string) => {
        const at = ((Date.now() - started) / 1000).toFixed(1);
        closes.push(`${at} s · phone ${phone} · ${code}${reason ? ` ${reason}` : ""}`);
      });
      await context.addInitScript(() => {
        type Logged = { __socketClosed?: (code: number, reason: string) => Promise<void> };
        window.WebSocket = class extends window.WebSocket {
          constructor(...args: ConstructorParameters<typeof WebSocket>) {
            super(...args);
            this.addEventListener("close", (e) => {
              void (window as Logged).__socketClosed?.(e.code, e.reason);
            });
          }
        };
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

/**
 * Bot moves on every phone until `done()`. The table has stalled when its phase and the seat to
 * move (as `pages[0]` shows them) stay the same for 15 s; the error names that seat. Time, not a
 * count of idle loops: those ran out while the server's Auto-play steps (2 s, then 1.2 s) were
 * still coming (M13, PO PR #31).
 */
export async function playUntil(pages: Page[], done: () => Promise<boolean>) {
  const table = pages[0].getByTestId("table");
  let seen = "";
  let since = Date.now();
  while (!(await done())) {
    for (const page of pages) await botStep(page);
    // In a turn the table waits on one seat; in the opening flip on everyone, at a summary on the
    // host.
    const phase = await table.getAttribute("data-phase");
    const turn = phase === "draw" || phase === "place";
    const seat = turn ? `, waiting on seat ${await table.getAttribute("data-current")}` : "";
    const now = `${phase}${seat}`;
    if (now !== seen) [seen, since] = [now, Date.now()];
    else if (Date.now() - since > 15_000) {
      const pill = await pages[0].getByTestId("pill").textContent();
      throw new Error(`table stalled for 15 s in ${now} (phone 1's pill: "${pill}")`);
    }
  }
}

export const playToEnd = (pages: Page[]) =>
  playUntil(pages, async () => (await pages[0].getByTestId("game-over").count()) > 0);

export const startGame = async (host: Page) => {
  await host.getByRole("button", { name: "Start game" }).click();
  await expect(host.getByTestId("table")).toHaveAttribute("data-phase", "flip");
};

import { expect, type Page, test } from "@playwright/test";
import { botStep, createRoom, phones, playToEnd, seatedRoom, startGame } from "./helpers";

test("two phones create, join, and play a full game to 100", async ({ browser }, info) => {
  test.skip(info.project.name !== "pixel", "long play-throughs run on Pixel only");
  const { pages } = await seatedRoom(browser, info, ["Ana", "Ben"]);
  await expect(pages[1].getByText("Waiting for the host…")).toBeVisible();
  await startGame(pages[0]);
  await playToEnd(pages);
  for (const page of pages) await expect(page.getByTestId("game-over")).toBeVisible();
  // Only the host can rematch.
  await expect(pages[1].getByRole("button", { name: "Play again" })).toHaveCount(0);
  // Play again returns everyone to the lobby with the same seats; the host starts.
  await pages[0].getByRole("button", { name: "Play again" }).click();
  await expect(pages[1].getByTestId("seats")).toContainText("Ana");
  await startGame(pages[0]);
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

test("everyone sees who is offline and when the server will move for them", async ({
  browser,
}, info) => {
  const { pages } = await seatedRoom(browser, info, ["Ana", "Ben"]);
  await startGame(pages[0]);
  await pages[1].context().close(); // Ben's phone dies during the opening flip
  await expect(pages[0].getByText(/^Ben is offline · auto-move in \d+ s$/)).toBeVisible();
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

test("online screenshots", async ({ browser }, info) => {
  test.skip(!process.env.SHOTS || info.project.name !== "iphone", "run with npm run screenshots");
  const shot = (page: Page, name: string) =>
    page.screenshot({
      path: `docs/screenshots/m3/${name}.jpg`,
      type: "jpeg",
      quality: 80,
      scale: "css",
      animations: "disabled",
    });
  const [host] = await phones(browser, info, 1);
  await host.goto("/");
  await shot(host, "01-home");
  const { pages, code } = await seatedRoom(browser, info, ["Ana", "Ben", "Cris"]);
  await shot(pages[0], "02-lobby-host");
  await shot(pages[1], "03-lobby-guest");
  await startGame(pages[0]);
  while ((await pages[0].getByTestId("table").getAttribute("data-phase")) === "flip") {
    for (const page of pages) await botStep(page);
  }
  const current = Number(await pages[0].getByTestId("table").getAttribute("data-current"));
  await shot(pages[current], "04-your-turn");
  await shot(pages[(current + 1) % 3], "05-waiting");
  const [watcher] = await phones(browser, info, 1);
  await watcher.goto(`/r/${code}`);
  await expect(watcher.getByText("You're watching this game")).toBeVisible();
  await shot(watcher, "06-spectator");
});

test("bad input doesn't take the server down", async ({ page, request, baseURL }) => {
  const code = await createRoom(page);
  // An oversized frame: the server rejects it (error reply or closed socket), never crashes.
  await page.evaluate(
    (url) =>
      new Promise<void>((done) => {
        const ws = new WebSocket(url);
        ws.onopen = () => ws.send("x".repeat(10_000));
        ws.onmessage = (e) => String(e.data).includes('"t":"error"') && done();
        ws.onclose = () => done();
      }),
    `${baseURL?.replace(/^http/, "ws")}/api/rooms/${code}/ws`,
  );
  // A path that `new URL()` rejects (it used to crash the Node server). Any status is fine.
  await request.get(`${baseURL}//`);
  // Still serving, and the room still exists.
  await page.goto(`/r/${code}`);
  await expect(page.getByTestId("room-code")).toHaveText(code);
});

test("m5 screenshots", async ({ browser }, info) => {
  test.skip(!process.env.SHOTS || info.project.name !== "iphone", "run with SHOTS=1");
  const shot = (page: Page, name: string) =>
    page.screenshot({
      path: `docs/screenshots/m5/${name}.jpg`,
      type: "jpeg",
      quality: 80,
      scale: "css",
      animations: "disabled",
    });
  const [home] = await phones(browser, info, 1);
  await home.goto("/");
  await shot(home, "01-home-install-hint");
  const { pages } = await seatedRoom(browser, info, ["Ana", "Ben", "Cris"]);
  await startGame(pages[0]);
  await pages[2].context().close();
  await expect(pages[0].getByText(/Cris is offline/)).toBeVisible();
  await shot(pages[0], "02-offline-countdown");
});

test("discard mode can be cancelled and the drawn card swapped in", async ({ browser }, info) => {
  const { pages } = await seatedRoom(browser, info, ["Ana", "Ben"]);
  await startGame(pages[0]);
  while ((await pages[0].getByTestId("table").getAttribute("data-phase")) === "flip") {
    for (const page of pages) await botStep(page);
  }
  const mover =
    (await pages[0].getByTestId("table").getAttribute("data-myturn")) === "true"
      ? pages[0]
      : pages[1];
  await mover.getByTestId("deck").click();
  const drawn = (await mover.getByTestId("drawn").getAttribute("aria-label"))?.split(": ")[1];
  await mover.getByTestId("discard").click();
  await expect(mover.getByText("Tap a face-down card to flip it")).toBeVisible();
  await mover.getByTestId("drawn").click();
  await expect(mover.getByText("Tap a grid card to swap")).toBeVisible();
  const target = mover.getByTestId("my-grid").locator('button[data-face="up"]').first();
  const position = (await target.getAttribute("aria-label"))?.split(":")[0];
  await target.click();
  await expect(mover.getByLabel(`${position}: ${drawn}`, { exact: true })).toBeVisible();
});

test("an unknown room code says so, including codes that can't exist", async ({ page }) => {
  await page.goto("/r/ZZZZZ");
  await expect(page.getByText("There's no room ZZZZZ.")).toBeVisible();
  await page.goto("/r/ABCD0"); // 0 is not in the code alphabet
  await expect(page.getByText("There's no room ABCD0.")).toBeVisible();
});

test("the host can remove a player who left without leaving", async ({ browser }, info) => {
  const { pages } = await seatedRoom(browser, info, ["Ana", "Ben", "Cris"]);
  await pages[1].context().close(); // Ben closes the tab
  const remove = pages[0].getByRole("button", { name: "Remove Ben" });
  await expect(remove).toBeVisible({ timeout: 10_000 });
  await remove.click();
  await expect(pages[0].getByTestId("seats")).not.toContainText("Ben");
  await expect(pages[2].getByTestId("seats")).not.toContainText("Ben");
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

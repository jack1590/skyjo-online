import { expect, type Page, test } from "@playwright/test";
import type { RoomView } from "../src/protocol";
import { botStep, createRoom, join, phones, playToEnd, seatedRoom, startGame } from "./helpers";

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
  // Ana's own flips come first in her prompt line; then it says who the table waits for.
  while (await botStep(pages[0]));
  await expect(pages[0].getByText(/^Ben is offline · auto-play in \d+ s$/)).toBeVisible();
});

/** Plays the opening flip on every phone; returns the phone to move first, then the others. */
async function pastFlips(pages: Page[]) {
  while ((await pages[0].getByTestId("table").getAttribute("data-phase")) === "flip") {
    for (const page of pages) await botStep(page);
  }
  const current = Number(await pages[0].getByTestId("table").getAttribute("data-current"));
  return [pages[current], ...pages.filter((_, i) => i !== current)];
}

test("M8: a player who ticks Auto-play is played for, a step at a time, until they untick it", async ({
  browser,
}, info) => {
  const all = await phones(browser, info, 2);
  /** Every message each phone sends, and every room state it gets, with when. */
  const sent = new Map(all.map((page) => [page, [] as { at: number; msg: string }[]]));
  const states = new Map(all.map((page) => [page, [] as { at: number; room: RoomView }[]]));
  for (const page of all) {
    page.on("websocket", (ws) => {
      ws.on("framesent", (f) => sent.get(page)?.push({ at: Date.now(), msg: String(f.payload) }));
      ws.on("framereceived", (f) => {
        const msg = String(f.payload).startsWith("{") ? JSON.parse(String(f.payload)) : null;
        if (msg?.t === "state") states.get(page)?.push({ at: Date.now(), room: msg.room });
      });
    });
  }
  const code = await createRoom(all[0]);
  for (const [i, page] of all.entries()) await join(page, code, ["Ana", "Ben"][i]);
  await startGame(all[0]);
  const [a, b] = await pastFlips(all);
  const name = (await a.getByTestId("mine-head").locator("strong").textContent()) ?? "";
  const seat = Number(await a.getByTestId("my-grid").getAttribute("data-seat"));
  const toggle = a.getByRole("checkbox", { name: "Auto-play" });
  // Taps here are forced: CI's WebKit spends up to a second per click on actionability alone.
  await toggle.click({ force: true });
  await expect(toggle).toBeChecked();
  await expect(a.getByTestId("mine-head")).toHaveText(/^Auto-play (is|was) on/);
  const ticked = sent.get(a)?.find((m) => m.msg.includes('"t":"auto"'))?.at ?? 0;
  // B's own states: A's drawn card within 4 s, then the card placed in a later state.
  const seen = () => {
    const after = states.get(b)?.filter((s) => s.at >= ticked) ?? [];
    const drew = after.findIndex(
      (s) => s.room.game?.current === seat && s.room.game.drawn !== null,
    );
    const placed = after.findIndex((s, i) => i > drew && s.room.game?.current !== seat);
    if (drew === -1) return "waiting";
    if (after[drew].at - ticked > 4_000) return "late";
    return placed === -1 ? "drawn" : "placed";
  };
  await expect.poll(seen, { timeout: 6_000 }).toBe("placed");
  await expect(b.getByTestId("table")).toHaveAttribute("data-myturn", "true");
  await expect(b.getByRole("img", { name: "Auto-play" })).toBeVisible();
  await expect(b.getByTestId("opponent")).toContainText(name);
  if (process.env.SHOTS && info.project.name === "iphone") {
    await b.screenshot({ path: "docs/screenshots/m8/10-others-see-auto-play.jpg", scale: "css" });
    await a.screenshot({ path: "docs/screenshots/m8/11-auto-play-on.jpg", scale: "css" });
  }
  // A's taps on its cards and on the deck point at the switch and send no move.
  const moves = () => (sent.get(a) ?? []).filter((m) => m.msg.includes('"t":"act"')).length;
  const before = moves();
  await a.getByTestId("my-grid").locator("button").first().click({ force: true });
  await a.getByTestId("deck").click({ force: true });
  await expect(a.getByTestId("mine-head")).toHaveText(/^Auto-play (is|was) on/);
  expect(moves()).toBe(before);
  // Unticked, A's next turn waits for A: its clock is a 30 s timer, not an auto-play step.
  await toggle.click({ force: true });
  await expect(toggle).not.toBeChecked();
  await botStep(b);
  await botStep(b);
  await expect(a.getByTestId("table")).toHaveAttribute("data-myturn", "true");
  const last = states.get(a)?.at(-1)?.room;
  expect(last?.game?.current).toBe(seat);
  expect(last?.clocks).toEqual([{ seat, inMs: expect.any(Number), reason: "timer" }]);
  expect(last?.clocks[0].inMs).toBeGreaterThan(25_000);
  await expect(b.getByRole("img", { name: "Auto-play" })).toHaveCount(0);
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
  while (await botStep(pages[0])); // Ana's own flips come first in her prompt line
  await expect(pages[0].getByText(/Cris is offline/)).toBeVisible();
  await shot(pages[0], "02-offline-countdown");
});

test("a round runs to its summary, then the next round (or the game ends)", async ({
  browser,
}, info) => {
  const { pages } = await seatedRoom(browser, info, ["Ana", "Ben"]);
  await startGame(pages[0]);
  const phase = () => pages[0].getByTestId("table").getAttribute("data-phase");
  for (let idle = 0; !["roundOver", "gameOver"].includes((await phase()) ?? ""); ) {
    let moved = false;
    for (const page of pages) moved = (await botStep(page)) || moved;
    idle = moved ? 0 : idle + 1;
    if (idle > 100) throw new Error("table stalled");
  }
  if ((await phase()) === "gameOver") {
    // Doubling can end a game in round 1; then the summary must offer a rematch instead.
    await expect(pages[0].getByRole("button", { name: "Play again" })).toBeVisible();
    return;
  }
  await expect(pages[1].getByTestId("round-summary")).toBeVisible();
  await expect(pages[1].getByText("Waiting for the host…")).toBeVisible();
  await pages[0].getByRole("button", { name: "Next round" }).click();
  for (const page of pages) {
    await expect(page.getByTestId("table")).toHaveAttribute("data-phase", "flip");
    await expect(page.getByText("Round 2")).toBeVisible();
  }
});

test("discard mode can be cancelled and the drawn card swapped in; then a whole discard-and-flip turn", async ({
  browser,
}, info) => {
  const { pages } = await seatedRoom(browser, info, ["Ana", "Ben"]);
  await startGame(pages[0]);
  const [mover, other] = await pastFlips(pages);
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

  // The other player draws, throws the card away and flips one (After M6: no other E2E does).
  const grid = other.getByTestId("my-grid");
  await expect(other.getByTestId("table")).toHaveAttribute("data-myturn", "true");
  const down = await grid.locator('[data-face="down"]').count();
  // Forced taps, as in botStep: each move is confirmed by the expect after it.
  await other.getByTestId("deck").click({ force: true });
  const card = (await other.getByTestId("drawn").getAttribute("aria-label"))?.split(": ")[1];
  await other.getByTestId("discard").click({ force: true });
  await expect(other.getByTestId("drawn")).toHaveJSProperty("tagName", "BUTTON"); // discard mode
  await grid.locator('button[data-face="down"]').first().click({ force: true });
  await expect(grid.locator('[data-face="down"]')).toHaveCount(down - 1);
  await expect(other.getByTestId("discard")).toHaveAttribute("aria-label", `Discard pile: ${card}`);
  await expect(other.getByTestId("table")).toHaveAttribute("data-myturn", "false");
  await expect(mover.getByTestId("table")).toHaveAttribute("data-myturn", "true");
});

test("an unknown room code says so, including codes that can't exist", async ({ page }) => {
  await page.goto("/r/ZZZZZ");
  await expect(page.getByText("There's no room ZZZZZ.")).toBeVisible();
  await page.goto("/r/ABCD0"); // 0 is not in the code alphabet
  await expect(page.getByText("There's no room ABCD0.")).toBeVisible();
});

test("a network over the server's per-IP limit is asked to wait, not to check its connection", async ({
  browser,
}, info) => {
  // Local runs at http://localhost aren't limited, so stand in for the Worker's 429. The app's
  // service worker would see the request before page.route does.
  const [page] = await phones(browser, info, 1, { serviceWorkers: "block" });
  await page.route("**/api/rooms", (route) => route.fulfill({ status: 429, body: "Too many" }));
  await page.goto("/");
  await page.getByRole("button", { name: "Create a room" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Too many requests from your network. Wait a minute and try again.",
  );
  await expect(page.getByRole("button", { name: "Create a room" })).toBeEnabled();
  if (process.env.SHOTS && info.project.name === "iphone") {
    await page.screenshot({ path: "docs/screenshots/sec1/01-too-many-requests.jpg", scale: "css" });
  }
});

test("a room with 20 connections turns a spectator away for good, and a player who reloads still gets in", async ({
  browser,
}, info) => {
  const [host, filler, late] = await phones(browser, info, 3);
  const code = await createRoom(host);
  await join(host, code, "Ana");
  // 19 more spectators' sockets, from one page: the room is at its cap of 20.
  await filler.goto("/");
  await filler.evaluate(
    ({ code, n }) => {
      const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/rooms/${code}/ws`;
      const sockets = Array.from({ length: n }, () => new WebSocket(url));
      (window as unknown as { sockets: WebSocket[] }).sockets = sockets;
      return Promise.all(
        sockets.map(
          (ws, i) =>
            new Promise((done) => {
              ws.onopen = () =>
                ws.send(JSON.stringify({ t: "hello", token: `watcher-${i}-abcdef` }));
              ws.onmessage = done;
            }),
        ),
      );
    },
    { code, n: 19 },
  );
  let opened = 0;
  late.on("websocket", () => opened++);
  await late.goto(`/r/${code}`);
  const full = `Room ${code} is full: too many people are connected. Try again later.`;
  await expect(late.getByText(full)).toBeVisible();
  await expect(late.getByRole("button", { name: "Home" })).toBeVisible();
  if (process.env.SHOTS && info.project.name === "iphone") {
    await late.screenshot({ path: "docs/screenshots/sec2/01-room-full.jpg", scale: "css" });
  }
  // Whether or not the server sees the old socket close first, the player gets its seat back
  // and no spectator loses their place.
  await host.reload();
  await expect(host.getByTestId("seats")).toContainText("you");
  const open = await filler.evaluate(
    () =>
      (window as unknown as { sockets: WebSocket[] }).sockets.filter(
        (ws) => ws.readyState === WebSocket.OPEN,
      ).length,
  );
  expect(open).toBe(19);
  // The turned-away phone doesn't retry (a retry would come within 0.5 s).
  await late.waitForTimeout(2_000);
  expect(opened).toBe(1);
  await expect(late.getByText(full)).toBeVisible();
});

test("a socket can't slip past the 20-socket cap by saying hello again as someone else", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "pixel", "a server rule; one device is enough");
  await page.goto("/");
  const open = await page.evaluate(async () => {
    const { code } = (await (await fetch("/api/rooms", { method: "POST" })).json()) as {
      code: string;
    };
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/rooms/${code}/ws`;
    const sockets: WebSocket[] = [];
    /** Sends `msg` and waits for the server's answer. */
    const say = (ws: WebSocket, msg: object) =>
      new Promise((done) => {
        ws.onmessage = done;
        ws.send(JSON.stringify(msg));
      });
    const connect = async (token: string) => {
      const ws = new WebSocket(url);
      sockets.push(ws);
      await new Promise((done) => {
        ws.onopen = done;
      });
      await say(ws, { t: "hello", token });
      return ws;
    };
    const [a, b] = ["seat-a-abcdef", "seat-b-abcdef"];
    await say(await connect(a), { t: "join", name: "A" });
    await say(await connect(b), { t: "join", name: "B" });
    for (let i = 0; i < 18; i++) await connect(b);
    // Each round gets a socket in as seat A, then says hello again as seat B. Before v2.0.5's fix,
    // every round added a socket.
    for (let i = 0; i < 10; i++) await say(await connect(a), { t: "hello", token: b });
    await new Promise((done) => setTimeout(done, 500));
    return sockets.filter((ws) => ws.readyState === WebSocket.OPEN).length;
  });
  expect(open).toBe(20);
});

test("a socket that never says hello gets nothing and is closed once it is 10 s old", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "pixel", "a server rule; one device is enough");
  test.setTimeout(90_000);
  await page.goto("/");
  const { quiet, pinged } = await page.evaluate(async () => {
    const { code } = (await (await fetch("/api/rooms", { method: "POST" })).json()) as {
      code: string;
    };
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/rooms/${code}/ws`;
    const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
    /** A socket that sends `first` once it opens, if given, and records what it gets. */
    const watch = (first?: string) => {
      const ws = new WebSocket(url);
      const seen = { got: 0, closed: 0, at: 0 };
      ws.onopen = () => first && ws.send(first);
      ws.onmessage = (e) => {
        if (e.data !== "pong") seen.got++;
      };
      ws.onclose = (e) => {
        seen.closed = e.code;
        seen.at = Date.now();
      };
      return { ws, seen };
    };
    const host = watch(JSON.stringify({ t: "hello", token: "host-abcdef" }));
    const quiet = watch();
    const pinged = watch("ping");
    await wait(500);
    host.ws.send(JSON.stringify({ t: "join", name: "Ana" })); // a broadcast the silent ones mustn't get
    await wait(10_500);
    const swept = Date.now();
    watch(); // the next socket's arrival sweeps them
    for (let i = 0; i < 90 && !quiet.seen.closed; i++) await wait(500);
    const after = ({ seen }: typeof quiet) => ({ ...seen, after: seen.at - swept });
    return { quiet: after(quiet), pinged: after(pinged) };
  });
  expect(pinged).toMatchObject({ got: 0, closed: 1000 });
  expect(pinged.after).toBeLessThan(2_000);
  // On workerd, a socket that never sent a frame only learns of its close once the room's object
  // goes idle (about 10 s) or after a 30 s close timeout. The server ignores it from the sweep on.
  expect(quiet).toMatchObject({ got: 0, closed: 1000 });
  expect(quiet.after).toBeLessThan(35_000);
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

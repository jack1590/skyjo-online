// Chat (M29): the button and its sheet, a bubble by whoever spoke, quick phrases in each phone's
// language, and the switch. Between three real phones, then at exact layouts through the harness.
import { expect, type Page } from "@playwright/test";
import { toView } from "../src/engine/view";
import type { ChatMsg } from "../src/protocol";
import { atTurnStart, roundOver, show } from "./harness";
import { createRoom, expectMobileFriendly, phones, startGame, test } from "./helpers";

const SHOTS = !!process.env.SHOTS;
const shot = (page: Page, name: string) =>
  SHOTS ? page.screenshot({ path: `docs/screenshots/m29/${name}.png`, scale: "css" }) : null;

const bubble = (page: Page, from: number) =>
  page.locator(`[data-testid=bubble][data-from="${from}"]`);
const openChat = (page: Page) => page.getByTestId("chat-button").click();
/** The middle of a box. */
const mid = (box: { x: number; y: number; width: number; height: number } | null) => {
  if (!box) throw new Error("no box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

test("M29: a quick phrase pops by its sender on every phone, each in its own language; typed text shows as typed; the badge counts; the switch hides it all", async ({
  browser,
}, info) => {
  const [[ana], [beto], [caio]] = await Promise.all(
    ["en-US", "es-419", "pt-BR"].map((locale) => phones(browser, info, 1, { locale })),
  );
  const code = await createRoom(ana);
  for (const [page, name] of [
    [ana, "Ana"],
    [beto, "Beto"],
    [caio, "Caio"],
  ] as const) {
    // By class: each phone labels the form in its own language.
    if (page !== ana) await page.goto(`/r/${code}`);
    await page.locator(".name-input").fill(name);
    await page.locator(".join-row button").click();
    await expect(page.getByTestId("seats")).toContainText(name);
  }

  // The lobby: Ana wishes luck with a quick phrase, and her sheet closes.
  await openChat(ana);
  await expect(ana.getByTestId("chat")).toContainText("No messages yet");
  await shot(ana, "01-sheet-empty");
  await ana.getByRole("button", { name: "Good luck!" }).click();
  await expect(ana.getByTestId("chat")).toHaveCount(0);
  await expect(bubble(ana, 0)).toHaveText("Good luck!");
  await expect(bubble(beto, 0)).toHaveText("¡Suerte!");
  await expect(bubble(caio, 0)).toHaveText("Boa sorte!");
  // By her name in the list, and taps go through it.
  const [at, row] = [
    await bubble(beto, 0).boundingBox(),
    await beto.locator(".seats li").first().boundingBox(),
  ];
  if (!at || !row) throw new Error("no box");
  expect(at.y).toBeGreaterThanOrEqual(row.y);
  expect(at.y).toBeLessThanOrEqual(row.y + row.height);
  expect(await bubble(beto, 0).evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
  await shot(beto, "02-lobby-bubble-es");
  // Unread on the others' buttons, not on hers.
  await expect(beto.getByTestId("chat-badge")).toHaveText("1");
  await expect(beto.getByTestId("chat-button")).toHaveAccessibleName("Chat, 1 nuevos");
  await expect(ana.getByTestId("chat-badge")).toHaveCount(0);

  await startGame(ana);
  await expect(caio.getByTestId("table")).toBeVisible();
  // The badge and the history came along to the table. Beto types in Spanish.
  await expect(beto.getByTestId("chat-badge")).toHaveText("1");
  await openChat(beto);
  await expect(beto.getByTestId("chat-badge")).toHaveCount(0);
  await expect(beto.getByTestId("chat-log")).toHaveText("Ana ¡Suerte!");
  await beto.getByRole("textbox", { name: "Escribe un mensaje" }).fill("¿Quién empieza?");
  await beto.getByRole("button", { name: "Enviar" }).click();
  // His sheet stays open, with his message in it; the box is empty again.
  await expect(beto.getByTestId("chat-log").locator(".mine")).toContainText("¿Quién empieza?");
  await expect(beto.getByRole("textbox", { name: "Escribe un mensaje" })).toHaveValue("");
  await shot(beto, "03-sheet-es");
  // As typed on the Portuguese phone, over Beto's panel there.
  await expect(bubble(caio, 1)).toHaveText("¿Quién empieza?");
  const panel = await caio.getByTestId("opponent").filter({ hasText: "Beto" }).boundingBox();
  const over = mid(await bubble(caio, 1).boundingBox());
  if (!panel) throw new Error("no panel");
  expect(over.x).toBeGreaterThanOrEqual(panel.x);
  expect(over.x).toBeLessThanOrEqual(panel.x + panel.width);
  await shot(caio, "04-table-bubble-pt");
  await openChat(caio);
  await expect(caio.getByTestId("chat-log")).toHaveText("Ana Boa sorte!Beto ¿Quién empieza?");

  // Caio switches chat off: no history, nothing to send, and it's remembered.
  await caio.getByRole("checkbox", { name: "Chat" }).uncheck();
  await expect(caio.getByTestId("chat-log")).toHaveCount(0);
  await expect(caio.getByTestId("chat")).toContainText("O chat está desligado");
  await caio.getByRole("button", { name: "Fechar" }).click();
  await beto.getByRole("button", { name: "¡Uy!" }).click();
  await expect(bubble(ana, 1)).toHaveText("Oops!");
  await expect(caio.getByTestId("bubble")).toHaveCount(0);
  await expect(caio.getByTestId("chat-badge")).toHaveCount(0);
  expect(await caio.evaluate(() => localStorage.getItem("skyjo:chat"))).toBe("0");
  // Ana saw two messages arrive with her sheet closed.
  await expect(ana.getByTestId("chat-badge")).toHaveText("2");

  // Three at once, then Send and the chips rest until the room allows another.
  await openChat(ana);
  const box = ana.getByRole("textbox", { name: "Write a message" });
  const sendButton = ana.getByRole("button", { name: "Send" });
  for (const text of ["one", "two", "three"]) {
    await box.fill(text);
    await expect(sendButton).toBeEnabled();
    await box.press("Enter");
    await expect(box).toHaveValue("");
  }
  await box.fill("four");
  await expect(sendButton).toBeDisabled();
  await expect(ana.getByRole("button", { name: "Haha" })).toBeDisabled();
  await expect(beto.getByTestId("chat-badge")).toHaveText("3");
});

test("M29: at 360 px the sheet's controls are 44 px, nothing scrolls sideways, and the text box stays above an open keyboard", async ({
  browser,
}, info) => {
  const [page] = await phones(browser, info, 1, { viewport: { width: 360, height: 640 } });
  // A keyboard can't be opened here: the page gets a visual viewport the test can shrink.
  await page.addInitScript(() => {
    const vv = Object.assign(new EventTarget(), { height: window.innerHeight, offsetTop: 0 });
    Object.defineProperty(window, "visualViewport", { value: vv });
  });
  await createRoom(page);
  await openChat(page);
  const sheet = page.getByTestId("chat").locator(".sheet");
  await expect(sheet).toBeVisible();
  await expectMobileFriendly(page);
  expect(await page.getByTestId("chat").getByRole("button").count()).toBe(22);
  // Nobody is seated here: a spectator's message hangs from the chat button, labelled, and their
  // sheet stays open.
  await page.getByRole("button", { name: "Good luck!" }).click();
  await expect(page.getByTestId("bubble")).toHaveText("Spectator Good luck!");
  await expect(page.getByTestId("chat-log")).toHaveText("Spectator Good luck!");
  await page.evaluate(() => {
    const vv = window.visualViewport as unknown as { height: number } & EventTarget;
    vv.height = 320;
    vv.dispatchEvent(new Event("resize"));
  });
  const box = page.getByRole("textbox", { name: "Write a message" });
  await expect
    .poll(async () => {
      const b = await box.boundingBox();
      return b ? b.y + b.height : Infinity;
    })
    .toBeLessThanOrEqual(320);
  const top = (await sheet.boundingBox())?.y ?? -1;
  expect(top).toBeGreaterThanOrEqual(0);
  await expectMobileFriendly(page);
  await shot(page, "05-keyboard-360");
});

test("M29: with 8 players at 360 px a bubble sits on its sender, follows them as the strip scrolls, stays on screen, and takes no tap; at the summary it points at their row", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const turn = atTurnStart(8);
  const me = turn.seat ?? 0;
  const [next, far] = [(me + 1) % 8, (me + 2) % 8];
  const say = (from: number, text: string, id: number): ChatMsg => ({ id, from, name: "", text });
  const said = [
    say(next, "Good luck! May the lowest score win tonight, friends", 1),
    say(far, "😂", 2),
    say(me, "Thanks!", 3),
  ];
  await show(page, { ...turn, said });
  await expect(page.getByTestId("bubble")).toHaveCount(3);
  // The button fits the top bar: 44 px, nothing scrolls sideways, and the pill isn't cut.
  await expectMobileFriendly(page);
  await expect(page.getByTestId("chat-badge")).toHaveText("2");
  const pill = page.getByTestId("pill");
  await expect(pill).toHaveText("Your last turn");
  expect(await pill.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  // The long one is by the first panel, at the screen's left edge: its body stays on screen.
  const body = await bubble(page, next).locator(".bubble-body").boundingBox();
  if (!body) throw new Error("no body");
  expect(body.x).toBeGreaterThanOrEqual(0);
  expect(body.x + body.width).toBeLessThanOrEqual(360);
  // Yours is above your name bar; your cards under it still take a tap.
  const [mine, bar] = [
    await bubble(page, me).boundingBox(),
    await page.getByTestId("mine-head").boundingBox(),
  ];
  if (!mine || !bar) throw new Error("no box");
  expect(mine.y).toBeGreaterThanOrEqual(bar.y);
  expect(mine.y).toBeLessThanOrEqual(bar.y + bar.height);
  const mineBody = await bubble(page, me).locator(".bubble-body").boundingBox();
  if (!mineBody) throw new Error("no body");
  expect(mineBody.y + mineBody.height).toBeLessThanOrEqual(mine.y);
  const under = await bubble(page, me)
    .locator(".bubble-body")
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit?.closest(".bubble") === null;
    });
  expect(under).toBe(true);
  await shot(page, "06-eight-players-360");
  // The strip scrolls: the bubble goes with its panel.
  const head = page.getByTestId("opponent").nth(1).locator(".opp-head");
  const off = async () =>
    Math.abs(
      Math.round(mid(await bubble(page, far).boundingBox()).x - mid(await head.boundingBox()).x),
    );
  const before = mid(await head.boundingBox()).x;
  expect(await off()).toBe(0);
  await page.getByTestId("opponents").evaluate((el) => {
    el.scrollLeft += 60;
  });
  await expect.poll(async () => mid(await head.boundingBox()).x).toBeLessThan(before - 30);
  await expect.poll(off).toBe(0);

  // The summary is a modal over the table: the bubbles are in it, by their senders' rows.
  const over = toView(roundOver(8, 3));
  await show(page, { view: over, seat: me, lead: true, said: [say(far, "Well played", 4)] });
  const row = await page.locator(`tr[data-seat="${far}"]`).boundingBox();
  const at = await page.locator("dialog.overlay").getByTestId("bubble").boundingBox();
  if (!row || !at) throw new Error("no box");
  expect(at.y).toBeGreaterThanOrEqual(row.y);
  expect(at.y).toBeLessThanOrEqual(row.y + row.height);
  await shot(page, "07-summary-bubble");
  // So is the button, since the modal makes the top bar inert. Escape closes the chat only.
  await expect(page.getByTestId("chat-button")).toHaveCount(1);
  await page.locator("dialog.overlay").getByTestId("chat-button").click();
  await expect(page.getByTestId("chat-log")).toContainText("Well played");
  await expectMobileFriendly(page);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("chat")).toHaveCount(0);
  await expect(page.locator("dialog.overlay")).toBeVisible();
});

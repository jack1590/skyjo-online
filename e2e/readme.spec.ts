// Regenerates the README's images of the current game (docs/readme/). Run `npm run shots:readme`
// whenever the UI changes (the PR checklist in AGENTS.md requires it). Needs ffmpeg for the GIF.
import { execFileSync } from "node:child_process";
import { expect, type Page } from "@playwright/test";
import { toView } from "../src/engine/view";
import type { ChatMsg } from "../src/protocol";
import { atTurnStart, knockoutGame, lastTurnGame, roundOver, show } from "./harness";
import { botStep, createRoom, join, phones, seatedRoom, startGame, test } from "./helpers";

test.skip(!process.env.SHOTS, "run with npm run shots:readme");
// The default look (M28): the harness would show Classic.
test.beforeEach(({ page }) =>
  page.addInitScript(() => localStorage.setItem("skyjo:theme", "casual")),
);

/** The characters (M32) the README's players wear, by seat. */
const FACES = [0, 7, 4, 12, 9, 2, 13, 5];

const shot = (page: Page, name: string) =>
  page.screenshot({
    path: `docs/readme/${name}.jpg`,
    type: "jpeg",
    quality: 82,
    scale: "css",
    animations: "disabled",
  });

test("README stills", async ({ browser, page }, info) => {
  await page.goto("/");
  const gotIt = page.getByRole("button", { name: "Got it" });
  if (await gotIt.count()) await gotIt.click();

  // Each with a character of their own (M32), the same in every run.
  const pages = await phones(browser, info, 4);
  for (const [i, phone] of pages.entries()) {
    await phone.addInitScript((char) => localStorage.setItem("skyjo:char", char), `${FACES[i]}`);
  }
  const code = await createRoom(pages[0]);
  for (const [i, name] of ["Ana", "Ben", "Cris", "Dani"].entries())
    await join(pages[i], code, name);
  // A fifth arrives: the characters to pick from, the taken ones greyed out, and a rolled name.
  const [guest] = await phones(browser, info, 1);
  await guest.goto(`/r/${code}`);
  await guest.getByRole("textbox", { name: "Your name" }).fill("Brave Otter");
  await guest.getByTestId("characters").getByRole("button", { name: "Otter" }).click();
  await guest.locator(".join-row").evaluate((el) => el.scrollIntoView({ block: "end" }));
  await guest.waitForLoadState("networkidle");
  // Show the live site's address, not the test server's.
  for (const phone of [pages[0], guest]) {
    await phone.locator(".link").evaluate((el) => {
      el.textContent =
        el.textContent?.replace(location.origin, "https://skyjo-online.jcarl-30.workers.dev") ?? "";
    });
  }
  await shot(guest, "characters");
  await pages[0].getByRole("checkbox", { name: "Play until one is left" }).click({ force: true });
  await expect(pages[1].getByRole("checkbox", { name: "Play until one is left" })).toBeChecked();
  // A public room (M24): the switch in the lobby, and the room on Home's list.
  await pages[0].getByRole("checkbox", { name: "Public room" }).click({ force: true });
  await expect(pages[1].getByRole("checkbox", { name: "Public room" })).toBeChecked();
  await shot(pages[0], "lobby");
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByTestId("public-rooms")).toContainText("Ana's room");
  await shot(page, "home");

  // Your turn with 9 s on the clock (M8).
  const four = atTurnStart(4);
  // `said` (no messages yet) gives the harness the chat button every real table has (M29).
  await show(page, {
    ...four,
    chars: FACES,
    said: [],
    wait: [{ seat: four.seat ?? 0, inMs: 9_000, reason: "timer" }],
  });
  await shot(page, "table-4");
  // Waiting on a player whose clock runs, with another on Auto-play.
  const eight = lastTurnGame(8, 3);
  const me = (eight.current + 2) % 8;
  await show(page, {
    view: toView(eight),
    seat: me,
    chars: FACES,
    said: [],
    auto: Array.from({ length: 8 }, (_, i) => i === (eight.current + 1) % 8),
    wait: [{ seat: eight.current, inMs: 7_000, reason: "timer" }],
  });
  await shot(page, "table-8");
  await page.getByTestId("opponent").first().click();
  await expect(page.getByTestId("zoom")).toBeVisible();
  await shot(page, "zoom");
  // Ranked from the lowest total, your row tagged, and the ender doubled (UX-14).
  await show(page, {
    view: toView(roundOver(4, 344)),
    seat: 2,
    lead: true,
    chars: FACES,
    said: [],
  });
  await shot(page, "summary");
  // The chat's sheet over the table (M29): the history, quick phrases, emojis and a text box.
  const says = (from: number, said: Partial<ChatMsg>, id: number): ChatMsg => ({
    id,
    from,
    name: `Player ${from + 1}`,
    ...said,
  });
  const you = four.seat ?? 0;
  const chat = [
    says((you + 1) % 4, { preset: "luck" }, 1),
    says((you + 2) % 4, { text: "Who shuffled this?! 😭" }, 2),
    says(you, { preset: "haha" }, 3),
    says((you + 3) % 4, { text: "Last round, I'm coming for you" }, 4),
  ];
  await show(page, { ...four, chars: FACES, said: chat });
  await page.getByTestId("chat-button").click();
  await expect(page.getByTestId("chat-log")).toBeVisible();
  await shot(page, "chat");

  // Play until one is left (R16), seed 61: Dani goes out after round 1; Cris is the one left.
  const knockout = knockoutGame(["Ana", "Ben", "Cris", "Dani"], 61);
  const firstOut = knockout.find((s) => s.phase === "roundOver");
  const round2 = knockout.find((s) => s.round === 2 && s.phase === "draw");
  if (!firstOut || !round2) throw new Error("seed 61 no longer plays out this way");
  await show(page, { view: toView(firstOut), seat: 0, lead: true, chars: FACES });
  await shot(page, "knockout-summary");
  await show(page, { view: toView(round2), seat: 3, chars: FACES });
  await shot(page, "knockout-out");
  await show(page, { view: toView(knockout[knockout.length - 1]), seat: 2, chars: FACES });
  await shot(page, "knockout-over");
});

/** Few colors and frame-to-frame diffs keep the GIF near 1 MB despite the detailed card art. */
const PALETTE =
  "[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle";

test("README card-flight GIF", async ({ browser }, info) => {
  const t0 = Date.now();
  const { pages } = await seatedRoom(browser, info, ["Ana", "Ben"], {
    reducedMotion: "no-preference",
    recordVideo: { dir: "test-results/readme-video", size: { width: 390, height: 664 } },
  });
  const [ana, ben] = pages;
  // The video starts with the page: skip the lobby (its link shows the test server), up to the tap
  // on Start; the GIF opens on the deal (UX-28).
  const dealt = (Date.now() - t0) / 1000;
  await startGame(ana);
  const grid = ana.getByTestId("my-grid");
  const faceDown = grid.locator('button[data-face="down"]');
  const pause = () => ana.waitForTimeout(800);
  await pause();
  while (await botStep(ben)); // Ben flips his two
  for (let i = 0; i < 2; i++) {
    await faceDown.first().click();
    await pause();
  }
  for (const slot of [5, "discard", 10] as const) {
    while (await botStep(ben)) await pause(); // Ben's turn plays out in the strip
    await expect(ana.getByTestId("table")).toHaveAttribute("data-myturn", "true");
    await ana.getByTestId("deck").click();
    await pause();
    if (slot === "discard") {
      await ana.getByTestId("discard").click();
      await pause(); // discard mode: your face-down cards glow (M18)
      await faceDown.first().click();
    } else {
      await grid.locator("button").nth(slot).click();
    }
    await pause();
  }
  const done = (Date.now() - t0) / 1000;
  const video = ana.video();
  await ana.context().close(); // finishes writing the video
  execFileSync("ffmpeg", [
    ...["-loglevel", "error", "-y", "-ss", String(dealt), "-to", String(done)],
    ...["-i", String(await video?.path())],
    ...["-vf", `fps=10,scale=300:-1:flags=lanczos,split[a][b];${PALETTE}`],
    "docs/readme/card-flights.gif",
  ]);
});

import { expect, type Page, test } from "@playwright/test";
import { seatedRoom, startGame } from "./helpers";

/** Counts sounds actually started (Web Audio buffer sources). */
const countSounds = (page: Page) =>
  page.addInitScript(() => {
    const original = AudioBufferSourceNode.prototype.start;
    (window as unknown as { sounds: number }).sounds = 0;
    AudioBufferSourceNode.prototype.start = function (...args) {
      (window as unknown as { sounds: number }).sounds++;
      return original.apply(this, args);
    };
  });
const soundsOn = (page: Page) =>
  page.evaluate(() => (window as unknown as { sounds: number }).sounds);

test("moves make sounds; the mute switch silences them and is remembered", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "pixel", "one engine is enough for audio wiring");
  const { pages } = await seatedRoom(browser, info, ["Ana", "Ben"]);
  const [ana, ben] = pages;
  await countSounds(ben);
  await ben.reload();
  await ben.getByTestId("seats").click(); // a tap unlocks audio and loads the sounds
  await ben.waitForTimeout(500);
  await startGame(ana);
  await ana.getByTestId("my-grid").locator("button").first().click(); // Ana flips
  await expect.poll(() => soundsOn(ben)).toBeGreaterThan(0);

  const mute = ben.getByRole("button", { name: "Sound" });
  await expect(mute).toHaveAttribute("aria-pressed", "true");
  await mute.click();
  const before = await soundsOn(ben);
  await ana.getByTestId("my-grid").locator('button[data-face="down"]').first().click();
  await ben.waitForTimeout(500);
  expect(await soundsOn(ben)).toBe(before);
  await ben.reload();
  await expect(ben.getByRole("button", { name: "Sound" })).toHaveAttribute("aria-pressed", "false");
});

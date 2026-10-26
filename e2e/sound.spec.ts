import { expect, type Page } from "@playwright/test";
import { seatedRoom, startGame, test } from "./helpers";

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
  const { pages } = await seatedRoom(browser, info, ["Ana", "Ben"], { audio: true });
  const [ana, ben] = pages;
  await countSounds(ben);
  await ben.reload();
  await ben.getByTestId("seats").click(); // a tap unlocks audio and loads the sounds
  await expect
    .poll(() =>
      ben.evaluate(
        () => performance.getEntriesByName(new URL("/sfx/flip.mp3", location.href).href).length,
      ),
    )
    .toBeGreaterThan(0);
  await startGame(ana);
  // The deal makes a sound on its own: count from after it.
  await expect.poll(() => soundsOn(ben)).toBeGreaterThan(0);
  const dealt = await soundsOn(ben);
  const anaGrid = ana.getByTestId("my-grid");
  await anaGrid.locator("button").first().click(); // Ana flips
  await expect(anaGrid.locator('[data-face="up"]')).toHaveCount(1);
  await expect.poll(() => soundsOn(ben)).toBeGreaterThan(dealt);

  const mute = ben.getByRole("button", { name: "Sound" });
  await expect(mute).toHaveAttribute("aria-pressed", "true");
  await mute.click();
  const before = await soundsOn(ben);
  // Ana's first flip has landed, so her second tap can't hit the same card.
  await anaGrid.locator('button[data-face="down"]').first().click();
  // Ben's table shows Ana's second flip; still no new sound.
  await expect(ben.locator('[data-testid="opponent"] [data-face="up"]')).toHaveCount(2);
  expect(await soundsOn(ben)).toBe(before);
  await ben.reload();
  await expect(ben.getByRole("button", { name: "Sound" })).toHaveAttribute("aria-pressed", "false");
});

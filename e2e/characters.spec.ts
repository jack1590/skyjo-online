// Characters and friendly names (M32): picking a face and rolling a name when joining, in both
// looks, between real phones; then exact layouts through the harness.
import { expect, type Page } from "@playwright/test";
import { toView } from "../src/engine/view";
import { atTurnStart, roundOver, show } from "./harness";
import { createRoom, expectMobileFriendly, phones, startGame, test } from "./helpers";

const SHOTS = !!process.env.SHOTS;
const shot = (page: Page, name: string) =>
  SHOTS ? page.screenshot({ path: `docs/screenshots/m32/${name}.png`, scale: "css" }) : null;

const LOOKS = ["casual", "classic"] as const;
const wear = (page: Page, look: string) =>
  page.addInitScript((l) => localStorage.setItem("skyjo:theme", l), look);
const face = (page: Page, within: string, char: number) =>
  page.locator(`${within} .av.char[data-char="${char}"]`);
const size = async (page: Page, selector: string) => {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no ${selector}`);
  return [Math.round(box.width), Math.round(box.height)];
};

for (const look of LOOKS) {
  test(`M32 (${look}): pick a character and roll a name when joining; nobody takes yours; it shows in the lobby, on the table and after a reload`, async ({
    browser,
  }, info) => {
    const [[ana], [beto]] = await Promise.all(
      ["en-US", "es-419"].map((locale) => phones(browser, info, 1, { locale })),
    );
    await Promise.all([wear(ana, look), wear(beto, look)]);
    const code = await createRoom(ana);

    // 16 to choose from, one already picked for you.
    const picker = ana.getByTestId("characters");
    await expect(picker.getByRole("button")).toHaveCount(16);
    await expect(picker.locator('[aria-pressed="true"]')).toHaveCount(1);
    // Also on the narrowest phones: the name, the dice and Join share a row.
    const full = ana.viewportSize();
    await ana.setViewportSize({ width: 360, height: 740 });
    await expectMobileFriendly(ana);
    if (full) await ana.setViewportSize(full);
    // The dice offers a two-word name and picks its animal.
    const name = ana.getByRole("textbox", { name: "Your name" });
    await ana.getByRole("button", { name: "Suggest a name" }).click();
    await expect(name).toHaveValue(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    const rolled = (await name.inputValue()).split(" ")[1];
    await expect(picker.getByRole("button", { name: rolled, exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await shot(ana, `01-join-${look}`);
    // Typing your own stays, and so does choosing your own.
    await name.fill("Ana");
    await picker.getByRole("button", { name: "Otter" }).click();
    await ana.getByRole("button", { name: "Join", exact: true }).click();
    await expect(face(ana, "[data-testid=seats]", 1)).toBeVisible();

    // Beto, in Spanish: the otter is Ana's.
    await beto.goto(`/r/${code}`);
    const theirs = beto.getByTestId("characters");
    await expect(theirs.getByRole("button", { name: "Nutria" })).toBeDisabled();
    await expect(theirs.locator('[aria-pressed="true"]:not(:disabled)')).toHaveCount(1);
    await beto.getByRole("button", { name: "Sugerir un nombre" }).click();
    await expect(beto.locator(".name-input")).toHaveValue(/^\p{Lu}\p{Ll}+ \p{Lu}\p{Ll}+$/u);
    await beto.locator(".name-input").fill("Beto");
    await theirs.getByRole("button", { name: "León" }).click();
    await beto.locator(".join-row .primary").click();
    await expect(face(ana, "[data-testid=seats]", 7)).toBeVisible();
    await expect(face(beto, "[data-testid=seats]", 1)).toBeVisible();

    // Seated, in the lobby: change it, to any but Ana's.
    await beto.getByText("Cambiar personaje").click();
    await expect(
      beto.getByTestId("characters").getByRole("button", { name: "Nutria" }),
    ).toBeDisabled();
    await beto.getByTestId("characters").getByRole("button", { name: "Zorro" }).click();
    await expect(face(ana, "[data-testid=seats]", 0)).toBeVisible();
    await expect(face(ana, "[data-testid=seats]", 7)).toHaveCount(0);
    await expectMobileFriendly(beto);
    await shot(beto, `02-lobby-${look}`);

    // The table: your face in your name bar, theirs on their panel.
    await startGame(ana);
    await expect(face(ana, "[data-testid=mine-head]", 1)).toBeVisible();
    await expect(face(ana, "[data-testid=opponent]", 0)).toBeVisible();
    await expect(face(beto, "[data-testid=opponent]", 1)).toBeVisible();
    await shot(ana, `03-table-${look}`);

    // A reload is the same seat, with the same face.
    await ana.reload();
    await expect(face(ana, "[data-testid=mine-head]", 1)).toBeVisible();
  });

  test(`M32 (${look}): 8 characters at 360 px shrink no card and scroll nothing sideways; a seat without one keeps its initial; the summary and a migajero show them`, async ({
    page,
  }) => {
    await wear(page, look);
    await page.setViewportSize({ width: 360, height: 740 });
    const table = atTurnStart(8);
    await show(page, table);
    const bare = {
      card: await size(page, "[data-testid=my-grid] .card"),
      head: await size(page, "[data-testid=mine-head]"),
      panel: await size(page, "[data-testid=opponent]"),
    };
    await page.waitForLoadState("networkidle");
    // Seat 3 joined from a tab loaded before 2.14.0: no character.
    const chars = [0, 1, 2, undefined, 4, 5, 6, 7];
    await page.evaluate(
      (detail) => window.dispatchEvent(new CustomEvent("skyjo:table", { detail })),
      { chars },
    );
    await expect(page.locator(".av.char")).toHaveCount(7);
    expect({
      card: await size(page, "[data-testid=my-grid] .card"),
      head: await size(page, "[data-testid=mine-head]"),
      panel: await size(page, "[data-testid=opponent]"),
    }).toEqual(bare);
    const [w, h] = await size(page, "[data-testid=opponent] .av.char");
    expect(w).toBe(h);
    expect(w).toBeGreaterThanOrEqual(18);
    // Without a character: the Modern look's monogram, and in Classic the name alone.
    const plain = page.locator(".av-3");
    await expect(plain).toHaveAttribute("data-initial", "P");
    if (look === "casual") await expect(plain).toBeVisible();
    else await expect(plain).toBeHidden();
    await expectMobileFriendly(page);
    await page.waitForLoadState("networkidle");
    await shot(page, `04-eight-${look}`);

    // The migajero's sign names who sent it, with their face.
    const them = table.seat === 0 ? 1 : 0;
    await page.evaluate(
      (detail) => window.dispatchEvent(new CustomEvent("skyjo:table", { detail })),
      { reaction: { id: 1, from: them, kind: "migajero", to: table.seat } },
    );
    await expect(face(page, "[data-testid=migajero-sign]", them)).toHaveCount(1);

    await page.evaluate(
      (detail) => window.dispatchEvent(new CustomEvent("skyjo:table", { detail })),
      { view: toView(roundOver(8, 344)), seat: 0, lead: true },
    );
    await expect(page.locator(".who .av.char")).toHaveCount(7);
    await expectMobileFriendly(page);
    await page.waitForLoadState("networkidle");
    await shot(page, `05-summary-${look}`);
  });
}

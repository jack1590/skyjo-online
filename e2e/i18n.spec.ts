import { expect, test } from "@playwright/test";

test("switching language translates the UI and is remembered", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("combobox", { name: "Language" }).selectOption("es");
  await expect(page.getByRole("button", { name: "Empezar partida" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "es-419");
  await page.reload();
  await page.getByRole("button", { name: "Empezar partida" }).click();
  await expect(page.getByText("Voltea 2 cartas", { exact: true })).toBeVisible();
  await expect(page.getByText("Jugador 1: voltea 2 cartas")).toBeVisible();
});

test.describe("browser in Brazilian Portuguese", () => {
  test.use({ locale: "pt-BR" });

  test("defaults to Portuguese", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Começar partida" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "pt-BR");
  });
});

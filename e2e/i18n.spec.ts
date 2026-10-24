import { expect, test } from "@playwright/test";

test("switching language translates the UI and is remembered", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("combobox", { name: "Language" }).selectOption("es");
  await expect(page.getByRole("button", { name: "Crear una sala" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "es-419");
  await page.reload();
  await expect(page.getByRole("button", { name: "Crear una sala" })).toBeVisible();
  await expect(page.getByText("Cómo jugar")).toBeVisible();
});

test.describe("browser in Brazilian Portuguese", () => {
  test.use({ locale: "pt-BR" });

  test("defaults to Portuguese", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Criar uma sala" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "pt-BR");
  });
});

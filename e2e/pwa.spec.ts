import { expect, test } from "@playwright/test";

test("installable: manifest with icons, and a service worker controls the page", async ({
  page,
  request,
}, info) => {
  test.skip(info.project.name === "iphone", "install criteria are checked in Chromium");
  test.skip(!!process.env.BASE_URL || process.env.SERVER === "node", "runs on the Worker build");
  await page.goto("/");
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  const manifest = await (await request.get(href ?? "")).json();
  expect(manifest).toMatchObject({ name: "Skyjo Online", start_url: "/", display: "standalone" });
  const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
  expect(sizes).toEqual(expect.arrayContaining(["192x192", "512x512"]));
  for (const icon of manifest.icons) expect((await request.get(icon.src)).ok()).toBe(true);
  expect(await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state)).toBe(
    "activated",
  );
});

test("once loaded, the app opens offline and hot-seat still works", async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name === "iphone", "service-worker offline is checked in Chromium");
  test.skip(!!process.env.BASE_URL || process.env.SERVER === "node", "runs on the Worker build");
  await page.goto("/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload(); // now controlled by the service worker, which caches the shell and assets
  await expect(page.getByRole("button", { name: "Start game" })).toBeVisible();
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText("You're offline.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create a room" })).toBeDisabled();
  await page.getByRole("button", { name: "Start game" }).click();
  await expect(page.getByTestId("table")).toHaveAttribute("data-phase", "flip");
  await context.setOffline(false);
});

test("iOS Safari gets an Add to Home Screen hint, once", async ({ page }, info) => {
  test.skip(info.project.name !== "iphone", "iOS only");
  await page.goto("/");
  await page.getByRole("button", { name: "Got it" }).click();
  await page.reload();
  await expect(page.getByRole("note")).toHaveCount(0);
});

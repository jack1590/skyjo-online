import { createRoom, join, phones, test } from "./helpers";

// A measurement, not a check (SEC-11): how many /api requests 8 phones on bad Wi-Fi make in their
// busiest minute, to size API_REQUESTS. Run with MEASURE=1 npx playwright test e2e/flaky.spec.ts --project=desktop
test("8 phones on flaky Wi-Fi: the busiest minute of /api requests", async ({ browser }, info) => {
  test.skip(!process.env.MEASURE || info.project.name !== "desktop", "run with MEASURE=1");
  test.setTimeout(300_000);
  const pages = await phones(browser, info, 8);
  /** When each /api request reached the server: room creation, or a socket opening. */
  const hits: number[] = [];
  for (const page of pages) {
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().endsWith("/api/rooms")) hits.push(Date.now());
    });
    await page.routeWebSocket(/\/api\/rooms\/\w+\/ws$/, (ws) => {
      hits.push(Date.now());
      const server = ws.connectToServer();
      // Bad Wi-Fi: every connection drops 15–45 s after it opens, and the phone reconnects.
      setTimeout(
        () => {
          ws.close().catch(() => {});
          server.close().catch(() => {});
        },
        15_000 + Math.random() * 30_000,
      );
    });
  }
  const code = await createRoom(pages[0]);
  for (const [i, page] of pages.entries()) await join(page, code, `P${i}`);
  // Over the next 3 minutes, each phone is also reloaded once.
  const end = Date.now() + 180_000;
  await Promise.all(
    pages.map(async (page) => {
      await page.waitForTimeout(Math.random() * 150_000);
      await page.reload();
    }),
  );
  await pages[0].waitForTimeout(Math.max(0, end - Date.now()));
  const peak = Math.max(...hits.map((t, i) => hits.slice(i).filter((h) => h < t + 60_000).length));
  console.log(`busiest minute: ${peak} /api requests (${hits.length} in total)`);
});

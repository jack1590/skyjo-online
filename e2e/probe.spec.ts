// Probe only (m20-ci-probe): where M18's discard click spends its time on CI's WebKit.
import { test } from "@playwright/test";
import { apply } from "../src/engine/game";
import { toView } from "../src/engine/view";
import { firstTurn, show } from "./harness";

const placing = () => {
  const state = firstTurn(4, 5);
  return {
    view: toView(apply(state, { type: "draw", seat: state.current, source: "deck" })),
    seat: state.current,
  };
};

for (const viewport of [
  { width: 360, height: 740 },
  { width: 390, height: 664 },
]) {
  test.describe(`DEAL probe ${viewport.width}`, () => {
    test.use({ viewport });
    test(`DEAL probe ${viewport.width}: click phases`, async ({ page }) => {
      const t0 = Date.now();
      const log: string[] = [];
      const lap = (what: string) => log.push(`${what} ${Date.now() - t0}`);
      await show(page, placing());
      lap("shown");
      const raf = () =>
        page.evaluate(
          () =>
            new Promise<number>((r) => {
              const s = performance.now();
              requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now() - s)));
            }),
        );
      log.push(`raf2 ${Math.round(await raf())}`);
      lap("raf");
      log.push(`raf2 ${Math.round(await raf())}`);
      lap("raf");
      const discard = page.getByTestId("discard");
      await discard.click({ trial: true });
      lap("trial");
      await discard.click({ trial: true });
      lap("trial2");
      await discard.click({ force: true });
      lap("force");
      await page.getByTestId("discard").click({ force: true, noWaitAfter: true });
      lap("forceNoWait");
      await discard.dispatchEvent("click");
      lap("dispatch");
      await discard.click();
      lap("plain");
      console.log(`DEALPROBE ${viewport.width} ${log.join(", ")}`);
    });
  });
}

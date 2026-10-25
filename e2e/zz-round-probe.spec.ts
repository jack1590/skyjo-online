// Probe only (not for merge): where does a slow 2-phone round spend its time on CI's WebKit?
import { expect, test } from "@playwright/test";
import { botStep, createRoom, join, phones, startGame } from "./helpers";

test("round probe", async ({ browser }, info) => {
  test.setTimeout(120_000);
  const all = await phones(browser, info, 2);
  const t0 = Date.now();
  const log: string[] = [];
  const at = () => ((Date.now() - t0) / 1000).toFixed(2);
  for (const [i, page] of all.entries()) {
    page.on("websocket", (ws) => {
      ws.on("framereceived", (f) => {
        const s = String(f.payload);
        if (!s.startsWith("{")) return;
        const m = JSON.parse(s);
        if (m.t !== "state") return log.push(`${at()} p${i} recv ${m.t} ${s.slice(0, 80)}`);
        const g = m.room.game;
        log.push(`${at()} p${i} state ack=${m.ack} ${g?.phase} cur=${g?.current} drawn=${g?.drawn} auto=${m.room.seats.map((x: { auto: boolean }) => +x.auto).join("")} conn=${m.room.seats.map((x: { connected: boolean }) => +x.connected).join("")} clocks=${JSON.stringify(m.room.clocks)}`);
      });
      ws.on("framesent", (f) => {
        const s = String(f.payload);
        if (s !== "ping") log.push(`${at()} p${i} sent ${s.slice(0, 70)}`);
      });
      ws.on("close", () => log.push(`${at()} p${i} socket closed`));
    });
    page.on("console", (msg) => log.push(`${at()} p${i} console ${msg.type()} ${msg.text().slice(0, 100)}`));
  }
  const code = await createRoom(all[0]);
  for (const [i, page] of all.entries()) await join(page, code, ["Ana", "Ben"][i]);
  await startGame(all[0]);
  const phase = () => all[0].getByTestId("table").getAttribute("data-phase");
  for (let idle = 0; !["roundOver", "gameOver"].includes((await phase()) ?? ""); ) {
    let moved = false;
    for (const [i, page] of all.entries()) {
      const s = Date.now();
      const did = await botStep(page);
      const took = Date.now() - s;
      if (took > 700) log.push(`${at()} p${i} SLOW botStep ${did} took ${took} ms`);
      moved = did || moved;
    }
    idle = moved ? 0 : idle + 1;
    if (idle > 100) throw new Error("table stalled");
  }
  const total = (Date.now() - t0) / 1000;
  console.log(`ROUND total ${total.toFixed(1)} s`);
  if (total > 12) console.log(log.join("\n"));
  await expect(all[0].getByTestId("table")).toBeVisible();
});

// The Worker's fetch handler with fake bindings. Kept apart from worker.test.ts, which stubs the
// global Response (Node refuses status 101); these tests need the real one.
import { describe, expect, it, vi } from "vitest";
import worker from "./worker";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

/** A ratelimit binding allowing `max` calls per key; each test stays inside one window. */
const limiter = (max: number) => {
  const seen = new Map<string, number>();
  return {
    limit: async ({ key }: { key: string }) => {
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      return { success: n <= max };
    },
  };
};

/** The Worker with the production limits (wrangler.jsonc, checked in room.test.ts) and a fake DO namespace. */
function setup() {
  /** Every Durable Object stub the Worker asked for: each one is a DO request. */
  const touched: string[] = [];
  const env = {
    API_REQUESTS: limiter(30),
    ROOM_CREATION: limiter(10),
    MESSAGES: limiter(120),
    ROOMS: {
      idFromName: (name: string) => name,
      get: (id: string) => {
        touched.push(id);
        return { create: async () => true, fetch: async () => new Response("room") };
      },
    },
  };
  const call = (url: string, ip: string, init: RequestInit = {}) =>
    worker.fetch(
      new Request(url, { ...init, headers: { "cf-connecting-ip": ip, ...init.headers } }) as never,
      env as never,
    );
  const api = (path: string, ip: string, init?: RequestInit) =>
    call(`https://skyjo-online.example.workers.dev${path}`, ip, init);
  const upgrade = { headers: { Upgrade: "websocket" } };
  const create = { method: "POST" };
  return { env, touched, call, api, upgrade, create };
}

describe("Worker per-IP limits", () => {
  it("SEC-1: past 30 /api requests a minute an IP gets 429 and reaches no Durable Object", async () => {
    const t = setup();
    for (let i = 0; i < 15; i++) expect((await t.api("/api/x", "203.0.113.7")).status).toBe(404);
    for (let i = 0; i < 15; i++) {
      expect((await t.api("/api/rooms/ABCDE/ws", "203.0.113.7", t.upgrade)).status).toBe(200);
    }
    expect(t.touched.length).toBe(15);
    expect((await t.api("/api/x", "203.0.113.7")).status).toBe(429);
    expect((await t.api("/api/rooms/ABCDE/ws", "203.0.113.7", t.upgrade)).status).toBe(429);
    expect((await t.api("/api/rooms", "203.0.113.7", t.create)).status).toBe(429);
    expect(t.touched.length).toBe(15);
    // Another address has its own budget.
    expect((await t.api("/api/rooms/ABCDE/ws", "198.51.100.1", t.upgrade)).status).toBe(200);
  });

  it("SEC-1: addresses in one IPv6 /64 share a budget; another /64 doesn't", async () => {
    const t = setup();
    for (let i = 0; i < 30; i++) {
      expect((await t.api("/api/x", `2001:db8:1:2::${i.toString(16)}`)).status).toBe(404);
    }
    expect((await t.api("/api/x", "2001:0db8:0001:0002:ffff:ffff:ffff:ffff")).status).toBe(429);
    expect((await t.api("/api/x", "2001:db8:1:3::1")).status).toBe(404);
  });

  it("SEC-4: room creation is limited to 10 a minute per IP", async () => {
    const t = setup();
    for (let i = 0; i < 10; i++) {
      expect((await t.api("/api/rooms", "203.0.113.7", t.create)).status).toBe(200);
    }
    const touched = t.touched.length;
    const refused = await t.api("/api/rooms", "203.0.113.7", t.create);
    expect(refused.status).toBe(429);
    expect(t.touched.length).toBe(touched);
    expect((await t.api("/api/rooms", "198.51.100.1", t.create)).status).toBe(200);
  });

  it("SEC-11: a new room spends 3 of the IP's message budget, and isn't made without them", async () => {
    const t = setup();
    for (let i = 0; i < 118; i++) await t.env.MESSAGES.limit({ key: "203.0.113.7" });
    const touched = t.touched.length;
    expect((await t.api("/api/rooms", "203.0.113.7", t.create)).status).toBe(429);
    expect(t.touched.length).toBe(touched);
    for (let i = 0; i < 117; i++) await t.env.MESSAGES.limit({ key: "198.51.100.1" });
    expect((await t.api("/api/rooms", "198.51.100.1", t.create)).status).toBe(200);
  });

  it("SEC-1: a local run at http://localhost (dev, E2E) is not limited", async () => {
    const t = setup();
    for (let i = 0; i < 100; i++) {
      const res = await t.call("http://localhost:4173/api/rooms", "127.0.0.1", t.create);
      expect(res.status).toBe(200);
    }
    // Any other hostname is limited, so a local run at http://[::1] can try the limits out.
    for (let i = 0; i < 10; i++) await t.call("http://[::1]:4173/api/rooms", "127.0.0.1", t.create);
    expect((await t.call("http://[::1]:4173/api/rooms", "127.0.0.1", t.create)).status).toBe(429);
  });

  it("SEC-1: the hostname localhost alone doesn't exempt a client with a public address", async () => {
    const t = setup();
    for (let i = 0; i < 30; i++) {
      expect((await t.call("http://localhost/api/x", "203.0.113.7")).status).toBe(404);
    }
    expect((await t.call("http://localhost/api/x", "203.0.113.7")).status).toBe(429);
  });
});

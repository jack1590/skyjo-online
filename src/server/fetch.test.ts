// The Worker's fetch handler with fake bindings. Kept apart from worker.test.ts, which stubs the
// global Response (Node refuses status 101); these tests need the real one.
import { describe, expect, it, vi } from "vitest";
import type { PublicRoom } from "../protocol";
import { LIST_CACHE_MS } from "./directory";
import worker from "./worker";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

/** A ratelimit binding allowing `max` calls per key; each test stays inside one window. */
const limiter = (max: number) => {
  const seen = new Map<string, number>();
  return {
    seen,
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
  /** IPs whose budget the room refuses to spend on a new room. */
  const broke = new Set<string>();
  /** The public list (M24) and how often the Worker read it: each read is a DO request. */
  const list = { rooms: [] as PublicRoom[], reads: 0 };
  const env = {
    DIRECTORY: {
      idFromName: (name: string) => name,
      get: () => ({
        list: async () => {
          list.reads++;
          return list.rooms;
        },
      }),
    },
    API_REQUESTS: limiter(30),
    ROOM_CREATION: limiter(10),
    MESSAGES: limiter(120),
    ROOMS: {
      idFromName: (name: string) => name,
      get: (id: string) => {
        touched.push(id);
        return {
          create: async (_: string, ip: string | null) =>
            ip && broke.has(ip) ? "limited" : "created",
          fetch: async () => new Response("room"),
        };
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
  return { touched, broke, list, env, call, api, upgrade, create };
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

  it("SEC-11: a room the object won't make for its creator's budget gets 429", async () => {
    const t = setup();
    t.broke.add("203.0.113.7");
    expect((await t.api("/api/rooms", "203.0.113.7", t.create)).status).toBe(429);
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

describe("Worker public list (M24)", () => {
  const room: PublicRoom = { code: "ABCDE", host: "Ana", players: 3, knockout: true };
  /** Each test starts past the last one's cached list: the cache is the isolate's, not the test's. */
  let clock = 1_000_000_000;
  const at = (ms: number) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(ms);
  };

  it("M24: GET /api/public returns the list; an isolate reads the directory once per 10 s, whoever asks, and each read costs its caller 2 units", async () => {
    const t = setup();
    clock += 60_000;
    at(clock);
    t.list.rooms = [room];
    const first = await t.api("/api/public", "203.0.113.7");
    expect([first.status, await first.json()]).toEqual([200, [room]]);
    t.list.rooms = [];
    at(clock + LIST_CACHE_MS - 1);
    expect(await (await t.api("/api/public", "198.51.100.1")).json()).toEqual([room]);
    expect(t.list.reads).toBe(1);
    expect(t.env.MESSAGES.seen.get("198.51.100.1")).toBeUndefined();
    at(clock + LIST_CACHE_MS);
    expect(await (await t.api("/api/public", "198.51.100.1")).json()).toEqual([]);
    expect(t.list.reads).toBe(2);
    expect([...t.env.MESSAGES.seen]).toEqual([
      ["203.0.113.7", 2],
      ["198.51.100.1", 2],
    ]);
    expect((await t.api("/api/public", "203.0.113.7", t.create)).status).toBe(404); // GET only
  });

  it("M24: an IP past its message budget gets 429 and the directory isn't read; Home's polling uses none of the 30 /api requests, so 8 friends on Home can still create and join", async () => {
    const t = setup();
    clock += 60_000;
    at(clock);
    for (let i = 0; i < 120; i++) await t.env.MESSAGES.limit({ key: "203.0.113.7" });
    expect((await t.api("/api/public", "203.0.113.7")).status).toBe(429);
    expect(t.list.reads).toBe(0);
    for (let i = 0; i < 40; i++) {
      expect((await t.api("/api/public", "198.51.100.1")).status).toBe(200);
    }
    expect(t.list.reads).toBe(1);
    for (let i = 0; i < 30; i++) expect((await t.api("/api/x", "198.51.100.1")).status).toBe(404);
    expect((await t.api("/api/public", "198.51.100.1")).status).toBe(200); // even past that limit
  });

  it("M24: a local run reads the list every time, so its tests see a change at once", async () => {
    const t = setup();
    clock += 60_000;
    at(clock);
    for (let i = 0; i < 3; i++) await t.call("http://localhost:4173/api/public", "127.0.0.1");
    expect(t.list.reads).toBe(3);
  });
});

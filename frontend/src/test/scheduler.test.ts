import { describe, expect, it } from "vitest";
import { RequestScheduler, backoff, latencyKey } from "../api/scheduler";

function deferred() {
  let resolve!: () => void;
  const p = new Promise<void>((r) => (resolve = r));
  return { p, resolve };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("request scheduler", () => {
  it("never runs more than the limit at once", async () => {
    const s = new RequestScheduler(2);
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    const runs = gates.map((g, i) => s.run("background", async () => (started.push(i), g.p)));
    await tick();
    expect(started).toEqual([0, 1]);
    expect(s.pending).toBe(1);
    gates[0]!.resolve();
    await runs[0];
    await tick();
    expect(started).toEqual([0, 1, 2]);
    gates[1]!.resolve();
    gates[2]!.resolve();
    await Promise.all(runs);
    expect(s.running).toBe(0);
  });

  it("starts queued user requests before queued background polls", async () => {
    const s = new RequestScheduler(1);
    const first = deferred();
    const order: string[] = [];
    const a = s.run("background", async () => (order.push("bg-running"), first.p));
    const b = s.run("background", async () => void order.push("bg-queued"));
    const c = s.run("user", async () => void order.push("user"));
    await tick();
    first.resolve();
    await Promise.all([a, b, c]);
    expect(order).toEqual(["bg-running", "user", "bg-queued"]);
  });

  it("free requests bypass the queue", async () => {
    const s = new RequestScheduler(1);
    const gate = deferred();
    const busy = s.run("background", () => gate.p);
    let ran = false;
    await s.run("free", async () => void (ran = true));
    expect(ran).toBe(true);
    gate.resolve();
    await busy;
  });

  it("a request aborted while queued never runs", async () => {
    const s = new RequestScheduler(1);
    const gate = deferred();
    const busy = s.run("background", () => gate.p);
    const ctl = new AbortController();
    let ran = false;
    const queued = s.run("background", async () => void (ran = true), ctl.signal);
    ctl.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    gate.resolve();
    await busy;
    await tick();
    expect(ran).toBe(false);
  });
});

describe("polling backoff", () => {
  it("keeps the base interval when the backend is fast", () => {
    expect(backoff(5000, 30)).toBe(5000);
    expect(backoff(5000, undefined)).toBe(5000);
  });
  it("slows to 3x the measured latency, capped at 60 s", () => {
    expect(backoff(5000, 2000)).toBe(6000);
    expect(backoff(5000, 40000)).toBe(60000);
  });
  it("collapses ids in latency keys", () => {
    expect(latencyKey("GET", "/api/files/abc123?verify=true")).toBe("GET /api/files/:id");
    expect(latencyKey("GET", "/api/files")).toBe("GET /api/files");
    expect(latencyKey("GET", "/api/twin?verify=true&shards=true")).toBe("GET /api/twin");
  });
});

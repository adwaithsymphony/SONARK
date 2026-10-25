/**
 * Client-side request scheduling for the Sonark API.
 *
 * The API serializes storage requests behind one lock, and with a node down
 * each health sweep costs time. Firing every poll at once only fills the
 * browser's connection pool and lets background polls race user actions. So:
 *   - at most MAX_ACTIVE lock-bound requests are in flight at a time;
 *   - "user" requests (selection detail, preview, execute, mutations) start
 *     before queued "background" polls;
 *   - "free" requests (GET /api/health, lock-free on the server) bypass the queue;
 *   - a request still waiting in the queue can be aborted.
 * Measured latencies feed polling backoff and the "API slow" indicator.
 */
import { create } from "zustand";

export type Priority = "user" | "background" | "free";

export const MAX_ACTIVE = 2;

interface Waiter {
  prio: Exclude<Priority, "free">;
  seq: number;
  start: () => void;
}

export class RequestScheduler {
  private active = 0;
  private seq = 0;
  private queue: Waiter[] = [];
  constructor(private readonly maxActive = MAX_ACTIVE) {}

  get pending() {
    return this.queue.length;
  }
  get running() {
    return this.active;
  }

  /** Run `task` when a slot is free. `free` tasks run at once. */
  run<T>(prio: Priority, task: () => Promise<T>, signal?: AbortSignal | null): Promise<T> {
    if (prio === "free") return task();
    if (signal?.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
    return new Promise<T>((resolve, reject) => {
      const w: Waiter = {
        prio,
        seq: this.seq++,
        start: () => {
          signal?.removeEventListener("abort", onAbort);
          this.active++;
          task().then(resolve, reject).finally(() => {
            this.active--;
            this.next();
          });
        },
      };
      const onAbort = () => {
        const i = this.queue.indexOf(w);
        if (i >= 0) {
          this.queue.splice(i, 1);
          reject(new DOMException("aborted", "AbortError"));
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(w);
      this.next();
    });
  }

  private next() {
    while (this.active < this.maxActive && this.queue.length) {
      // user before background; FIFO within a priority
      this.queue.sort((a, b) => (a.prio === b.prio ? a.seq - b.seq : a.prio === "user" ? -1 : 1));
      this.queue.shift()!.start();
    }
  }
}

export const scheduler = new RequestScheduler();

/** Path without query string, used as the latency key ("/api/files/:id" collapsed). */
export function latencyKey(method: string, path: string): string {
  const p = path.split("?")[0]!.replace(/^\/api\/files\/[^/]+(\/content)?$/, "/api/files/:id$1").replace(/^\/api\/scenarios\/run-[0-9a-f]+$/, "/api/scenarios/:run");
  return `${method} ${p}`;
}

interface PerfState {
  /** last measured time to response headers, ms, per latencyKey */
  latency: Record<string, number>;
  /** time of the last measurement, ms epoch */
  at: number;
  record: (key: string, ms: number) => void;
}

export const usePerf = create<PerfState>((set) => ({
  latency: {},
  at: 0,
  record: (key, ms) => set((s) => ({ latency: { ...s.latency, [key]: ms }, at: Date.now() })),
}));

/**
 * Poll interval with backoff: never faster than three times the last measured
 * latency of that endpoint, so polling cannot outrun a slow backend.
 */
export function backoff(baseMs: number, lastLatencyMs: number | undefined): number {
  if (!lastLatencyMs) return baseMs;
  return Math.min(Math.max(baseMs, Math.round(lastLatencyMs * 3)), 60_000);
}

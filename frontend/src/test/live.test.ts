// @vitest-environment node
/**
 * Live contract test against a running `sonark serve --manage`.
 * Skipped unless SONARK_LIVE=1. It runs ONE real controlled failure (restart
 * mode) on the cluster at VITE_API_BASE_URL, so point it at a throwaway cluster.
 *   SONARK_LIVE=1 VITE_API_BASE_URL=http://127.0.0.1:8810 npx vitest run src/test/live.test.ts
 */
import { describe, expect, it } from "vitest";
import { ApiRequestError, apiBase } from "../api/client";
import { api } from "../api/endpoints";
import { sha256Hex } from "../lib/download";

const live = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.SONARK_LIVE === "1";

describe.skipIf(!live)(`live API at ${apiBase()}`, () => {
  it("read endpoints validate against the schemas", async () => {
    const h = await api.health();
    expect(h.node_control).toBe(true);
    const st = await api.status();
    expect(st.nodes.length).toBeGreaterThan(0);
    const files = await api.files();
    expect(files.files.length).toBeGreaterThan(0);
    const d = await api.fileDetail(files.files[0]!.file_id, true);
    expect(d.protection.stripes[0]!.shards!.length).toBe(d.k + d.m);
    const t = await api.twin({ verify: true, shards: true });
    expect(t.snapshot.verified).toBe(true);
    await api.scenarios();
    await api.events();
  });

  it("download bytes hash to the stored SHA-256", async () => {
    const f = (await api.files()).files[0]!;
    const d = await api.download(f.file_id);
    expect(await sha256Hex(d.bytes)).toBe(f.sha256);
    expect(d.sha256Header).toBe(f.sha256);
  });

  it("execute refuses a wrong confirmation with 428 and the expected id", async () => {
    const nodes = [(await api.status()).nodes[1]!.node_id];
    const p = await api.preview(nodes);
    const err = await api.execute(nodes, "scn-000000000000", "restart").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect((err as ApiRequestError).status).toBe(428);
    expect((err as ApiRequestError).expectedConfirm).toBe(p.scenario_id);
  });

  it("a real scenario returns a report that matches its preview", async () => {
    const nodes = [(await api.status()).nodes[1]!.node_id];
    const p = await api.preview(nodes);
    expect(p.executable).toBe(true);
    const t0 = Date.now();
    const report = await api.execute(nodes, p.scenario_id, "restart");
    console.log(`scenario ${report.run_id} on ${nodes} took ${Date.now() - t0} ms: ${report.summary}`);
    expect(report.scenario_id).toBe(p.scenario_id);
    expect(report.prediction.predictions).toEqual(p.predictions);
    expect(report.prediction_matched).toBe(true);
    expect(report.all_files_intact_after).toBe(true);
    const stored = await api.scenario(report.run_id);
    expect(stored.run_id).toBe(report.run_id);
    const ev = await api.events();
    expect(ev.events.some((e) => (e.detail as { run_id?: string } | null)?.run_id === report.run_id)).toBe(true);
    const st = await api.status();
    expect(st.nodes.find((n) => n.node_id === nodes[0])!.up).toBe(true);
  }, 120000);
});

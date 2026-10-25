import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, ApiUnreachableError, SchemaError, apiBase, describeError } from "../api/client";
import { api } from "../api/endpoints";
import { fixture, mockApi, r } from "./fixtures";

afterEach(() => vi.restoreAllMocks());

describe("api client", () => {
  it("defaults to the page's own origin, where the Vite server proxies /api", () => {
    expect(apiBase()).toBe(window.location.origin);
  });

  it("unwraps {data} and validates", async () => {
    mockApi([r("GET", /^\/api\/status$/, "status")]);
    const st = await api.status();
    expect(st.nodes.map((n) => n.node_id)).toEqual(["n1", "n2", "n3", "n4", "n5", "n6"]);
  });

  it("turns 428 into ApiRequestError with expectedConfirm", async () => {
    mockApi([r("POST", /^\/api\/scenarios\/execute$/, "error_428_execute")]);
    const err = await api.execute(["n2"], "scn-000000000000", "restart").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    const e = err as ApiRequestError;
    expect(e.status).toBe(428);
    expect(e.code).toBe("confirmation_required");
    expect(e.expectedConfirm).toBe(fixture("error_428_execute").body.error.details.expected_confirm);
    expect(describeError(e).title).toContain("Confirmation required");
  });

  it("sends nodes, confirm and mode exactly as given", async () => {
    const { calls } = mockApi([r("POST", /^\/api\/scenarios\/execute$/, "execute")]);
    await api.execute(["n2"], "scn-abcdefabcdef", "replace");
    expect(calls[0]!.body).toEqual({ nodes: ["n2"], confirm: "scn-abcdefabcdef", mode: "replace" });
  });

  it("preview asks for a verified snapshot", async () => {
    const { calls } = mockApi([r("POST", /^\/api\/scenarios\/preview$/, "preview_survive")]);
    const p = await api.preview(["n2"]);
    expect(calls[0]!.body).toEqual({ nodes: ["n2"], verify: true });
    expect(p.scenario_id).toMatch(/^scn-/);
  });

  it("reports schema mismatches with the raw body", async () => {
    mockApi([r("GET", /^\/api\/health$/, () => ({ status: 200, body: { data: { service: "sonark" } } }))]);
    const err = (await api.health().catch((e: unknown) => e)) as SchemaError;
    expect(err).toBeInstanceOf(SchemaError);
    expect(err.raw).toEqual({ data: { service: "sonark" } });
  });

  it("network failure becomes ApiUnreachableError", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(api.health()).rejects.toBeInstanceOf(ApiUnreachableError);
  });

  it("aborts propagate as AbortError, not as unreachable", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError"));
    await expect(api.health()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("non-JSON error bodies still produce ApiRequestError", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("boom", { status: 502 }));
    const err = (await api.health().catch((e: unknown) => e)) as ApiRequestError;
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err.status).toBe(502);
  });
});

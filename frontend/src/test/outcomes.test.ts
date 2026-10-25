import { describe, expect, it } from "vitest";
import { scenarioPreview, twin as twinSchema, type FileAnalysis, type PreviewFile, type PreviewStripe, type StripeReport } from "../api/schemas";
import { classifyPreviewFile, explainStripe, samePlacement, survivability } from "../lib/outcomes";
import { formatTolerance } from "../lib/format";
import { data } from "./fixtures";

const stripe = (chunk: number, k: number, m: number, valid: number, shards?: StripeReport["shards"]): StripeReport => ({
  chunk_index: chunk,
  k,
  m,
  n: k + m,
  valid,
  shard_status_counts: {},
  margin: valid - k,
  recoverable: valid >= k,
  valid_shards_per_node: {},
  min_node_failures_to_lose: null,
  shards,
});
const pStripe = (chunk: number, k: number, before: number, lost: Record<string, number>): PreviewStripe => {
  const n = Object.values(lost).reduce((a, b) => a + b, 0);
  return {
    chunk_index: chunk,
    k,
    m: 2,
    valid_before: before,
    valid_shards_lost: lost,
    valid_after: before - n,
    recoverable_after: before - n >= k,
    explanation: "",
  };
};
const pFile = (stripes: PreviewStripe[], recoverableBefore = true): PreviewFile => ({
  file_id: "f",
  name: "a.bin",
  sha256: "",
  status_before: "healthy",
  status_after: "degraded",
  recoverable_before: recoverableBefore,
  recoverable_after: stripes.every((s) => s.recoverable_after),
  fault_tolerance_after: null,
  stripes_affected: stripes.length,
  stripes_lost: stripes.filter((s) => !s.recoverable_after).map((s) => s.chunk_index),
  stripes,
  explanation: "",
});
const tFile = (stripes: StripeReport[]) => ({ stripes }) as unknown as FileAnalysis;

describe("per-file outcome", () => {
  it("4+2 losing one shard per stripe keeps spare redundancy", () => {
    const c = classifyPreviewFile(pFile([pStripe(0, 4, 6, { n1: 1 })]), tFile([stripe(0, 4, 2, 6)]));
    expect(c.outcome).toBe("reduced_redundancy");
    expect(c.minMargin).toBe(1);
  });
  it("exactly k left is zero margin", () => {
    const c = classifyPreviewFile(pFile([pStripe(0, 4, 6, { n1: 1, n2: 1 })]), tFile([stripe(0, 4, 2, 6)]));
    expect(c.outcome).toBe("zero_margin");
  });
  it("below k is unrecoverable", () => {
    expect(classifyPreviewFile(pFile([pStripe(0, 4, 6, { n1: 2, n2: 1 })]), undefined).outcome).toBe("unrecoverable");
  });
  it("an unaffected stripe already at zero margin makes the file zero margin", () => {
    const c = classifyPreviewFile(pFile([pStripe(0, 4, 6, { n1: 1 })]), tFile([stripe(0, 4, 2, 6), stripe(1, 4, 2, 4)]));
    expect(c.outcome).toBe("zero_margin");
    expect(c.tightest).toBe(1);
    expect(c.complete).toBe(true);
  });
  it("uses each stripe's own k (mixed coding, uneven placement)", () => {
    // a 2+1 file whose node holds two shards of one stripe
    const c = classifyPreviewFile(pFile([pStripe(0, 2, 3, { n1: 1 })]), tFile([stripe(0, 2, 1, 3)]));
    expect(c.outcome).toBe("zero_margin");
    expect(c.minMargin).toBe(0);
  });
  it("already lost files are reported as such", () => {
    expect(classifyPreviewFile(pFile([pStripe(0, 4, 3, { n1: 1 })], false), undefined).outcome).toBe("already_unrecoverable");
  });
});

describe("stripe explanation", () => {
  it("states valid vs k with the arithmetic and the shard indices", () => {
    const shards = [
      { shard_index: 0, node_id: "n1", status: "ok" as const },
      { shard_index: 1, node_id: "n6", status: "ok" as const },
      { shard_index: 2, node_id: "n3", status: "ok" as const },
      { shard_index: 3, node_id: "n2", status: "ok" as const },
      { shard_index: 4, node_id: "n6", status: "ok" as const },
      { shard_index: 5, node_id: "n2", status: "missing" as const },
    ];
    const w = explainStripe("design-system.zip", pStripe(2, 4, 5, { n2: 1, n6: 2 }), stripe(2, 4, 2, 5, shards), true);
    expect(w.headline).toBe("Stripe 2 of design-system.zip has 2 valid shards remaining; 4 are required to reconstruct.");
    expect(w.arithmetic).toBe("valid after = 5 − 3 = 2; 2 ≥ 4? no → stripe lost");
    expect(w.placement).toBe("Shard 3 lived on n2 and shards 1 and 4 lived on n6: proposed failures.");
    expect(w.recoverable).toBe(false);
  });
  it("omits shard indices when the placement snapshot is not the preview's", () => {
    expect(explainStripe("a", pStripe(0, 4, 6, { n1: 1 }), stripe(0, 4, 2, 6, []), false).placement).toBeNull();
  });
});

describe("with real captured responses", () => {
  const tw = twinSchema.parse(data("twin"));
  it("survivability statement counts come from fault_tolerance", () => {
    const s = survivability(tw);
    expect(s.total).toBe(tw.files.length);
    expect(s.surviveAnySingle + s.notSingle).toBe(s.total);
    expect(s.byTolerance.reduce((a, r) => a + r.files, 0)).toBe(s.total);
  });
  it("classifies every affected file of a real loss preview as unrecoverable", () => {
    const p = scenarioPreview.parse(data("preview_loss"));
    for (const f of p.files) {
      const t = tw.files.find((x) => x.file_id === f.file_id);
      const c = classifyPreviewFile(f, t);
      expect(c.outcome === "unrecoverable").toBe(!f.recoverable_after);
    }
    expect(typeof samePlacement(p, tw)).toBe("boolean");
  });
});

describe("tolerance display", () => {
  it("never prints the backend's -1 as a number of failures", () => {
    expect(formatTolerance(-1)).toBe("none: already unrecoverable");
    expect(formatTolerance(-1, true)).toBe("none");
    expect(formatTolerance(0)).toBe("any 0 node failures");
    expect(formatTolerance(1)).toBe("any 1 node failure");
    expect(formatTolerance(null)).toBe("— (no stripes)");
  });
});

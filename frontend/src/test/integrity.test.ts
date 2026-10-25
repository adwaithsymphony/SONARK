import { describe, expect, it } from "vitest";
import { clusterStatus, eventList, type ScrubSummary, type ShardStatus, type StripeReport } from "../api/schemas";
import { findings, scanHistory } from "../lib/integrity";
import { data } from "./fixtures";

const status = clusterStatus.parse(data("status"));
const stripe = (valid: number, holders: string[]): StripeReport => ({
  chunk_index: 0,
  k: 4,
  m: 2,
  n: 6,
  valid,
  shard_status_counts: {},
  margin: valid - 4,
  recoverable: valid >= 4,
  valid_shards_per_node: {},
  min_node_failures_to_lose: null,
  shards: holders.map((node_id, i) => ({ shard_index: i, node_id, status: "ok" as ShardStatus })),
});
/** stripe whose shard 3 shows the same problem as the finding (as a verified snapshot would) */
const showing = (st: StripeReport, kind: ShardStatus, node: string): StripeReport => ({
  ...st,
  shards: st.shards!.map((x) => (x.shard_index === 3 ? { ...x, status: kind, node_id: node } : x)),
});
const scrub = (kind: string, node: string, lost = false): ScrubSummary => ({
  files_checked: 1,
  shards_checked: 6,
  issues: 1,
  repaired: 0,
  unrepaired: lost ? 1 : 0,
  lost_chunks: lost ? [{ file_id: "f", chunk_index: 0 }] : [],
  healthy: false,
  details: [{ file_id: "f", chunk_index: 0, shard_index: 3, node_id: node, kind, resolution: "" }],
});
const all6 = ["n1", "n2", "n3", "n4", "n5", "n6"];

describe("what repair can accomplish (backend repair rules)", () => {
  it("corrupt shard on a live node is regenerated in place", () => {
    const [f] = findings(scrub("corrupt", "n4"), () => showing(stripe(5, all6), "corrupt", "n4"), status);
    expect(f!.repairable).toBe(true);
    expect(f!.outlook).toBe("Can be regenerated on n4 from 5 intact shards (needs any 4).");
    expect(f!.severity).toBe("redundancy_reduced");
  });
  it("a lost chunk cannot be repaired", () => {
    const [f] = findings(scrub("missing", "n4", true), () => showing(stripe(3, all6), "missing", "n4"), status);
    expect(f!.repairable).toBe(false);
    expect(f!.severity).toBe("data_loss");
    expect(f!.outlook).toContain("only 3 of 4");
  });
  it("down node with no spare holder is deferred, with a spare it moves", () => {
    const down = { ...status, nodes: status.nodes.map((n) => (n.node_id === "n6" ? { ...n, up: false } : n)) };
    expect(findings(scrub("node_down", "n6"), () => showing(stripe(5, ["n1", "n2", "n3", "n6", "n5", "n4"]), "node_down", "n6"), down)[0]!.outlook).toContain("deferred");
    const [moved] = findings(scrub("node_down", "n6"), () => showing(stripe(5, ["n1", "n2", "n3", "n6", "n4", "n6"]), "node_down", "n6"), down);
    expect(moved!.repairable).toBe(true);
    expect(moved!.outlook).toContain("(n5)");
  });
  it("a snapshot that no longer shows the problem is not used as evidence", () => {
    const [f] = findings(scrub("corrupt", "n4"), () => stripe(6, all6), status); // repaired since the scan
    expect(f!.repairable).toBeNull();
    expect(f!.outlook).toContain("newer than this scan");
  });
  it("repair-pass findings defer to the backend resolution", () => {
    const s = scrub("corrupt", "n4");
    s.details[0]!.resolution = "rebuilt on n4";
    expect(findings(s, () => stripe(6, all6), status)[0]!.outlook).toContain("backend resolution");
  });
  it("without the Twin snapshot it says so instead of guessing", () => {
    expect(findings(scrub("corrupt", "n4"), () => undefined, status)[0]!.repairable).toBeNull();
  });
});

describe("scan history", () => {
  it("parses real scrub events", () => {
    const h = scanHistory(eventList.parse(data("events")).events);
    expect(h.length).toBeGreaterThan(0);
    expect(h.every((s) => s.shards !== null && s.repair !== null)).toBe(true);
  });
});

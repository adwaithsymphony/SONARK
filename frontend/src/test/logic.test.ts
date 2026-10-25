import { describe, expect, it } from "vitest";
import { clusterStatus, fileDetail, scenarioPreview, scenarioReport } from "../api/schemas";
import { buildNodes, buildShards, shardsByNode, worstStatus } from "../components/stage/model";
import { ringLayout } from "../lib/layout";
import { deriveMode, naturalCompare, useUi } from "../state/ui";
import { blockers, countRecovered, refusedBeforeStopping } from "../views/Experiment";
import { ApiRequestError } from "../api/client";
import { data } from "./fixtures";

describe("deterministic layout", () => {
  it("depends only on the set of ids, in natural order", () => {
    const a = ringLayout(["n10", "n2", "n1"]);
    const b = ringLayout(["n1", "n10", "n2", "n2"]);
    expect(a).toEqual(b);
    expect(a.map((p) => p.id)).toEqual(["n1", "n2", "n10"]);
    expect(a[0]!.angle).toBe(0);
  });
  it("natural compare", () => {
    expect(["n10", "n9", "n1"].sort(naturalCompare)).toEqual(["n1", "n9", "n10"]);
  });
});

describe("stage model uses only backend data", () => {
  it("nodes come from /api/status", () => {
    const { nodes } = buildNodes(clusterStatus.parse(data("status_node_down")));
    expect(nodes.map((n) => n.id)).toEqual(["n1", "n2", "n3", "n4", "n5", "n6"]);
    expect(nodes.find((n) => n.id === "n6")!.state).toBe("stopped");
    expect(nodes.filter((n) => n.state === "up")).toHaveLength(5);
  });
  it("shards come from the file's verified stripes", () => {
    const d = fileDetail.parse(data("file_detail"));
    const shards = buildShards(d.protection);
    expect(shards).toHaveLength(d.chunk_count * (d.k + d.m));
    const byNode = shardsByNode(shards);
    expect([...byNode.values()].every((l) => worstStatus(l) === "ok")).toBe(true);
  });
  it("no placement data means no shards and no edges", () => {
    expect(buildShards(undefined)).toEqual([]);
  });
});

describe("modes", () => {
  it("LIVE / PREVIEW / EXPERIMENT", () => {
    expect(deriveMode({ experiment: { phase: "idle" }, hypothetical: [] })).toBe("LIVE");
    expect(deriveMode({ experiment: { phase: "idle" }, hypothetical: ["n2"] })).toBe("PREVIEW");
    expect(
      deriveMode({ experiment: { phase: "running", nodes: ["n2"], mode: "restart", scenarioId: "x", startedAt: 0 }, hypothetical: ["n2"] }),
    ).toBe("EXPERIMENT");
  });
  it("hypothetical selection is sorted and does not touch other state", () => {
    const before = useUi.getState().selectedNode;
    useUi.getState().toggleHypothetical("n5");
    useUi.getState().toggleHypothetical("n2");
    expect(useUi.getState().hypothetical).toEqual(["n2", "n5"]);
    useUi.getState().toggleHypothetical("n5");
    expect(useUi.getState().hypothetical).toEqual(["n2"]);
    expect(useUi.getState().selectedNode).toBe(before);
    useUi.getState().setHypothetical([]);
  });
});

describe("refused vs unknown experiment outcomes", () => {
  const err = (status: number, code: string, msg = "x") => new ApiRequestError(status, code, msg, {}, null);
  it("4xx refusals mean nothing was stopped", () => {
    expect(refusedBeforeStopping(err(428, "confirmation_required"))).toBe(true);
    expect(refusedBeforeStopping(err(409, "conflict", "n2 is already stopped"))).toBe(true);
    expect(refusedBeforeStopping(err(503, "busy"))).toBe(true);
  });
  it("a 409 raised after stopping, or a lost response, is not a refusal", () => {
    expect(refusedBeforeStopping(err(409, "conflict", "nodes still answering after stop: ['n2']"))).toBe(false);
    expect(refusedBeforeStopping(new Error("network"))).toBe(false);
  });
  it("mode follows: refused -> not EXPERIMENT, unknown -> EXPERIMENT", () => {
    const base = { nodes: ["n2"], error: null, finishedAt: 0 };
    expect(deriveMode({ experiment: { phase: "failed", ...base, modified: false }, hypothetical: [] })).toBe("LIVE");
    expect(deriveMode({ experiment: { phase: "failed", ...base, modified: null }, hypothetical: [] })).toBe("EXPERIMENT");
  });
});

describe("experiment helpers", () => {
  const p = scenarioPreview.parse(data("preview_survive"));
  const nodes = clusterStatus.parse(data("status")).nodes;
  it("no blockers for a managed, running, verified preview", () => {
    expect(blockers(p, true, false, nodes)).toEqual([]);
  });
  it("blocks without node control or with a stopped node", () => {
    expect(blockers(p, false, false, nodes).join(" ")).toContain("--manage");
    const stopped = nodes.map((n) => (n.node_id === "n2" ? { ...n, running: false } : n));
    expect(blockers(p, true, false, stopped).join(" ")).toContain("already stopped");
  });
  it("counts come from the report", () => {
    const loss = scenarioReport.parse(data("execute_loss"));
    expect(countRecovered(loss)).toEqual({ total: 3, predicted: 1, actual: 1, sha: 1 });
    expect(loss.prediction_matched).toBe(true);
  });
});

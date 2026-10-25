/**
 * Stage data model: everything the 3D and 2D topologies draw, derived only
 * from backend responses. No field here is invented; when the backend gave
 * no placement data, `shards` is empty and no edges are drawn.
 */
import { useMemo } from "react";
import type { ClusterStatus, FileAnalysis, ShardStatus } from "../../api/schemas";
import { ringLayout, ringRadius } from "../../lib/layout";
import { nodeState, type NodeState } from "../../lib/status";

export interface StageNode {
  id: string;
  state: NodeState;
  shards: number; // total shards metadata places on this node (/api/status)
  managed: boolean;
  x: number; // world units
  z: number;
  angle: number;
}

export interface StageShard {
  key: string;
  chunk: number;
  shard: number;
  node: string;
  status: ShardStatus;
}

export interface StageModel {
  nodes: StageNode[];
  radius: number;
  maxShards: number;
  fileName: string | null;
  shards: StageShard[]; // placement of the selected file, if known
  hostNodes: Set<string>;
  placementSource: "verified" | "unverified" | null;
}

export function buildNodes(status: ClusterStatus | undefined): { nodes: StageNode[]; radius: number; maxShards: number } {
  if (!status) return { nodes: [], radius: 3, maxShards: 1 };
  const byId = new Map(status.nodes.map((n) => [n.node_id, n]));
  const radius = ringRadius(status.nodes.length);
  const nodes = ringLayout([...byId.keys()]).map((p) => {
    const n = byId.get(p.id)!;
    return {
      id: p.id,
      state: nodeState(n),
      shards: n.shards,
      managed: n.managed,
      x: p.x * radius,
      z: p.y * radius,
      angle: p.angle,
    };
  });
  return { nodes, radius, maxShards: Math.max(1, ...nodes.map((n) => n.shards)) };
}

export function buildShards(analysis: FileAnalysis | undefined): StageShard[] {
  if (!analysis) return [];
  const out: StageShard[] = [];
  for (const st of analysis.stripes) {
    for (const s of st.shards ?? []) {
      out.push({
        key: `${st.chunk_index}:${s.shard_index}`,
        chunk: st.chunk_index,
        shard: s.shard_index,
        node: s.node_id,
        status: s.status,
      });
    }
  }
  return out;
}

export function useStageModel(
  status: ClusterStatus | undefined,
  analysis: FileAnalysis | undefined,
  verified: boolean | null,
): StageModel {
  const base = useMemo(() => buildNodes(status), [status]);
  const shards = useMemo(() => buildShards(analysis), [analysis]);
  return useMemo(
    () => ({
      ...base,
      fileName: analysis?.name ?? null,
      shards,
      hostNodes: new Set(shards.map((s) => s.node)),
      placementSource: shards.length === 0 ? null : verified ? "verified" : "unverified",
    }),
    [base, shards, analysis, verified],
  );
}

/** Group a file's shards by node, in stable (chunk, shard) order. */
export function shardsByNode(shards: StageShard[]): Map<string, StageShard[]> {
  const m = new Map<string, StageShard[]>();
  for (const s of shards) {
    const list = m.get(s.node) ?? [];
    list.push(s);
    m.set(s.node, list);
  }
  for (const list of m.values()) list.sort((a, b) => a.chunk - b.chunk || a.shard - b.shard);
  return m;
}

/** Worst observed shard status among a node's shards of the selected file. */
export function worstStatus(list: StageShard[]): ShardStatus {
  const order: ShardStatus[] = ["corrupt", "missing", "node_down", "unverified", "ok"];
  for (const s of order) if (list.some((x) => x.status === s)) return s;
  return "ok";
}

export function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

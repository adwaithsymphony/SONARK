import type { FileStatus, NodeStatus, ShardStatus } from "../api/schemas";
import { color } from "../theme/tokens";

export const fileStatusMeta: Record<FileStatus, { label: string; color: string; cls: string; rank: number; help: string }> = {
  lost: { label: "Lost", color: color.lost, cls: "text-lost", rank: 0, help: "Some stripe has fewer than k valid shards. Not recoverable now." },
  at_risk: { label: "At risk", color: color.atRisk, cls: "text-at-risk", rank: 1, help: "A single node failure would lose data (fault tolerance 0)." },
  degraded: { label: "Degraded", color: color.degraded, cls: "text-degraded", rank: 2, help: "Recoverable, but some shards are missing, corrupt or on a down node." },
  healthy: { label: "Healthy", color: color.healthy, cls: "text-healthy", rank: 3, help: "Every shard valid." },
};

export const shardStatusMeta: Record<ShardStatus, { label: string; color: string; cls: string; valid: boolean; glyph: string }> = {
  ok: { label: "OK (hash verified)", color: color.shardOk, cls: "bg-s-ok", valid: true, glyph: "✓" },
  unverified: { label: "Unverified (node up, not fetched)", color: color.shardUnverified, cls: "bg-s-unverified", valid: true, glyph: "·" },
  missing: { label: "Missing (404 on node)", color: color.shardMissing, cls: "bg-s-missing", valid: false, glyph: "∅" },
  corrupt: { label: "Corrupt (SHA-256 mismatch)", color: color.shardCorrupt, cls: "bg-s-corrupt", valid: false, glyph: "✕" },
  node_down: { label: "Node down (unreachable)", color: color.shardNodeDown, cls: "bg-s-down", valid: false, glyph: "↓" },
};

export type NodeState = "up" | "down" | "stopped";

/** Observed state only, straight from /api/status. */
export function nodeState(n: NodeStatus): NodeState {
  if (n.up) return "up";
  if (n.managed && n.running === false) return "stopped";
  return "down";
}

export const nodeStateMeta: Record<NodeState, { label: string; color: string; cls: string }> = {
  up: { label: "Up", color: color.live, cls: "text-live" },
  stopped: { label: "Stopped", color: color.down, cls: "text-down" },
  down: { label: "Unreachable", color: color.down, cls: "text-down" },
};

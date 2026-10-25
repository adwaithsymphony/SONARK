/**
 * Integrity findings, read from a backend scrub/repair result. "What repair can
 * accomplish" restates the backend's repair rules (sonark/store.py _scrub_chunk):
 *   - fewer than k intact shards in the stripe: unrecoverable;
 *   - missing/corrupt shard on a node that is up: rebuilt in place from the intact shards;
 *   - shard on a down node: rebuilt and moved to a healthy node that holds no
 *     shard of that stripe, or deferred when there is no such node.
 * Intact counts come from the verified Twin snapshot, which is named in the text.
 */
import type { ClusterStatus, ScrubSummary, SonarkEvent, StripeReport } from "../api/schemas";

export type FindingType = "missing" | "corrupt" | "unreachable" | string;
export type Severity = "data_loss" | "redundancy_reduced" | "unavailable";

export interface Finding {
  fileId: string;
  chunk: number;
  shard: number;
  node: string;
  type: FindingType;
  severity: Severity;
  resolution: string; // from the backend; "" for a read-only scrub
  outlook: string;
  repairable: boolean | null; // null = cannot tell without the Twin snapshot
}

export const findingTypeLabel = (kind: string): string =>
  kind === "corrupt" ? "checksum mismatch (corrupt)" : kind === "node_down" ? "unreachable (node down)" : kind;

export function findings(
  scrub: ScrubSummary,
  twinStripe: (fileId: string, chunk: number) => StripeReport | undefined,
  status: ClusterStatus | undefined,
): Finding[] {
  const lost = new Set(scrub.lost_chunks.map((c) => `${c.file_id}:${c.chunk_index}`));
  const up = new Set((status?.nodes ?? []).filter((n) => n.up).map((n) => n.node_id));
  return scrub.details.map((d) => {
    const st = twinStripe(d.file_id, d.chunk_index);
    const isLost = lost.has(`${d.file_id}:${d.chunk_index}`);
    const severity: Severity = isLost ? "data_loss" : d.kind === "node_down" ? "unavailable" : "redundancy_reduced";
    let outlook: string;
    let repairable: boolean | null;
    // The Twin snapshot is only evidence for this finding if it still shows the same problem.
    const twinShard = st?.shards?.find((x) => x.shard_index === d.shard_index);
    const consistent = !!twinShard && twinShard.status === d.kind && twinShard.node_id === d.node_id;
    if (d.resolution) {
      repairable = !/UNRECOVERABLE|FAILED|DEFERRED/.test(d.resolution);
      outlook = `Handled by this repair pass: see the backend resolution.`;
    } else if (isLost) {
      repairable = false;
      outlook = st
        ? `Cannot repair: only ${st.valid} of ${st.k} required shards remain (verified Twin).`
        : "Cannot repair: the backend reports fewer than k intact shards for this stripe.";
    } else if (!st) {
      repairable = null;
      outlook = "Load the Survival Twin to assess what repair can do for this stripe.";
    } else if (!consistent) {
      repairable = null;
      outlook = "The latest verified snapshot no longer shows this problem (it is newer than this scan). Scan again for a current assessment.";
    } else if (d.kind !== "node_down" && up.has(d.node_id)) {
      repairable = st.valid >= st.k;
      outlook = repairable
        ? `Can be regenerated on ${d.node_id} from ${st.valid} intact shards (needs any ${st.k}).`
        : `Cannot repair: only ${st.valid} of ${st.k} required shards remain.`;
    } else {
      const holders = new Set((st.shards ?? []).map((s) => s.node_id));
      const spares = [...up].filter((n) => !holders.has(n)).sort();
      if (st.valid < st.k) {
        repairable = false;
        outlook = `Cannot repair: only ${st.valid} of ${st.k} required shards remain.`;
      } else if (spares.length) {
        repairable = true;
        outlook = `Can be rebuilt from ${st.valid} intact shards and moved to a healthy node without a shard of this stripe (${spares.join(", ")}).`;
      } else {
        repairable = false;
        outlook = `Repair would be deferred: every healthy node already holds a shard of this stripe. Restart ${d.node_id} or add a node.`;
      }
    }
    return {
      fileId: d.file_id,
      chunk: d.chunk_index,
      shard: d.shard_index,
      node: d.node_id,
      type: d.kind,
      severity,
      resolution: d.resolution,
      outlook,
      repairable,
    };
  });
}

export interface ScanRecord {
  ts: string;
  repair: boolean | null;
  files: number | null;
  shards: number | null;
  issues: number | null;
  repaired: number | null;
  lost: number | null;
  raw: string;
}

/** Scan history from `scrub` events; the detail string is parsed only if it has the known shape. */
export function scanHistory(events: SonarkEvent[]): ScanRecord[] {
  const re = /repair=(True|False) files=(\d+) shards=(\d+) issues=(\d+) repaired=(\d+) lost=(\d+)/;
  return events
    .filter((e) => e.kind === "scrub")
    .map((e) => {
      const raw = typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail);
      const m = re.exec(raw);
      const n = (i: number) => (m ? Number(m[i]) : null);
      return { ts: e.ts, repair: m ? m[1] === "True" : null, files: n(2), shards: n(3), issues: n(4), repaired: n(5), lost: n(6), raw };
    });
}

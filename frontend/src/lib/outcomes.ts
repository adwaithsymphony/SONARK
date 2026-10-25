/**
 * Presentation of backend survivability data. Nothing here estimates risk:
 * every number comes from the Twin analysis or the preview response. The only
 * arithmetic is restating the backend's own rule, a stripe is recoverable iff
 * valid shards >= k, using the backend's counts. Each file and stripe carries
 * its own k; nothing assumes one coding for the whole cluster.
 */
import type { FileAnalysis, PreviewFile, PreviewStripe, ScenarioPreview, StripeReport, Twin } from "../api/schemas";

export type PreviewOutcome = "unaffected" | "reduced_redundancy" | "zero_margin" | "unrecoverable" | "already_unrecoverable";

export const outcomeMeta: Record<PreviewOutcome, { label: string; glyph: string; cls: string; help: string }> = {
  unaffected: { label: "Unaffected", glyph: "○", cls: "text-muted", help: "No valid shard of this file is on a proposed node." },
  reduced_redundancy: {
    label: "Recoverable · reduced redundancy",
    glyph: "●",
    cls: "text-degraded",
    help: "Every stripe keeps more than k valid shards, but fewer than before.",
  },
  zero_margin: {
    label: "Recoverable · zero margin",
    glyph: "▲",
    cls: "text-at-risk",
    help: "At least one stripe would keep exactly k valid shards: one more lost shard there loses the file.",
  },
  unrecoverable: { label: "Unrecoverable", glyph: "✕", cls: "text-lost", help: "At least one stripe would fall below k valid shards." },
  already_unrecoverable: {
    label: "Already unrecoverable",
    glyph: "✕",
    cls: "text-lost",
    help: "The backend reports this file as unrecoverable before any proposed failure.",
  },
};

export interface ClassifiedFile {
  outcome: PreviewOutcome;
  /** smallest (valid - k) over all stripes after the proposed failure; null if unknown */
  minMargin: number | null;
  /** chunk index of the stripe with the smallest margin */
  tightest: number | null;
  /** true when unaffected stripes' counts came from the Twin snapshot */
  complete: boolean;
}

/**
 * Classify a file the preview lists as affected. Affected stripes use the
 * preview's valid_after; the other stripes keep their current valid count,
 * read from the verified Twin (`twinFile`) when available.
 */
export function classifyPreviewFile(pf: PreviewFile, twinFile: FileAnalysis | undefined): ClassifiedFile {
  if (!pf.recoverable_before) return { outcome: "already_unrecoverable", minMargin: null, tightest: null, complete: true };
  const after = new Map<number, number>(pf.stripes.map((s) => [s.chunk_index, s.valid_after - s.k]));
  let complete = false;
  if (twinFile) {
    complete = true;
    for (const st of twinFile.stripes) if (!after.has(st.chunk_index)) after.set(st.chunk_index, st.valid - st.k);
  }
  let minMargin: number | null = null;
  let tightest: number | null = null;
  for (const [chunk, m] of after) {
    if (minMargin === null || m < minMargin) {
      minMargin = m;
      tightest = chunk;
    }
  }
  if (!pf.recoverable_after) return { outcome: "unrecoverable", minMargin, tightest, complete };
  return { outcome: minMargin === 0 ? "zero_margin" : "reduced_redundancy", minMargin, tightest, complete };
}

export interface StripeWhy {
  headline: string; // "Stripe 2 of a.bin has 3 valid shards remaining; 4 are required to reconstruct."
  placement: string | null; // which shard indices sat on which proposed node, or null if unknown
  arithmetic: string; // "valid after = 6 − 3 = 3; 3 ≥ 4? no → stripe lost"
  recoverable: boolean;
}

/**
 * Deterministic explanation of one previewed stripe. Shard indices are read
 * from the Twin's per-shard placement only when that snapshot is the one the
 * preview was computed from (same fingerprint) and the counts agree.
 */
export function explainStripe(
  fileName: string,
  p: PreviewStripe,
  twinStripe: StripeReport | undefined,
  samePlacement: boolean,
): StripeWhy {
  const lost = Object.values(p.valid_shards_lost).reduce((a, b) => a + b, 0);
  const ok = p.valid_after >= p.k;
  const headline = `Stripe ${p.chunk_index} of ${fileName} has ${p.valid_after} valid shard${p.valid_after === 1 ? "" : "s"} remaining; ${p.k} ${
    p.k === 1 ? "is" : "are"
  } required to reconstruct.`;
  const arithmetic = `valid after = ${p.valid_before} − ${lost} = ${p.valid_after}; ${p.valid_after} ≥ ${p.k}? ${ok ? "yes → recoverable" : "no → stripe lost"}${
    ok ? ` with ${p.valid_after - p.k} to spare` : ""
  }`;

  let placement: string | null = null;
  if (samePlacement && twinStripe?.shards) {
    const parts: string[] = [];
    let consistent = true;
    for (const [node, count] of Object.entries(p.valid_shards_lost)) {
      const idx = twinStripe.shards
        .filter((s) => s.node_id === node && (s.status === "ok" || s.status === "unverified"))
        .map((s) => s.shard_index)
        .sort((a, b) => a - b);
      if (idx.length !== count) consistent = false;
      parts.push(`${idx.length === 1 ? "shard" : "shards"} ${joinList(idx.map(String))} lived on ${node}`);
    }
    if (consistent && parts.length) placement = `${capitalize(joinList(parts))}: proposed failure${parts.length === 1 ? "" : "s"}.`;
  }
  return { headline, placement, arithmetic, recoverable: ok };
}

export function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Whether the preview and the Twin describe the same observed shard state. */
export function samePlacement(preview: ScenarioPreview | undefined, twin: Twin | undefined): boolean {
  return !!preview && !!twin && preview.snapshot.fingerprint === twin.snapshot.fingerprint;
}

export interface Survivability {
  total: number;
  surviveAnySingle: number; // files that survive any single node failure
  notSingle: number; // files a single node failure would lose, or already lost
  /** guaranteed tolerance (backend fault_tolerance) → number of files; "lost" and "empty" are separate rows */
  byTolerance: { key: string; label: string; files: number }[];
}

/** Plain-language survivability from the backend's per-file fault_tolerance. */
export function survivability(twin: Twin): Survivability {
  const rows = new Map<string, { label: string; files: number; order: number }>();
  let surviveAnySingle = 0;
  for (const f of twin.files) {
    let key: string;
    let label: string;
    let order: number;
    if (!f.recoverable) {
      key = "lost";
      label = "unrecoverable now";
      order = -2;
    } else if (f.fault_tolerance === null) {
      key = "empty";
      label = "empty file (no stripes, cannot be lost)";
      order = 1000;
    } else {
      key = `t${f.fault_tolerance}`;
      label = `survive any ${f.fault_tolerance} node failure${f.fault_tolerance === 1 ? "" : "s"}`;
      order = f.fault_tolerance;
    }
    if (f.recoverable && (f.fault_tolerance === null || f.fault_tolerance >= 1)) surviveAnySingle++;
    const r = rows.get(key) ?? { label, files: 0, order };
    r.files++;
    rows.set(key, r);
  }
  const byTolerance = [...rows.entries()]
    .sort((a, b) => b[1].order - a[1].order)
    .map(([key, r]) => ({ key, label: r.label, files: r.files }));
  return { total: twin.files.length, surviveAnySingle, notSingle: twin.files.length - surviveAnySingle, byTolerance };
}

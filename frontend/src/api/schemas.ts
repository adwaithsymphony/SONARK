/**
 * Zod schemas for the Sonark API, derived from sonark/api.py, twin.py,
 * scenario.py and metadata.py (not from the UI design document).
 * Field-by-field mapping lives in frontend/API_MAPPING.md.
 *
 * Objects use .passthrough() so a backend that adds fields keeps working;
 * a backend that drops or retypes a field fails validation loudly.
 */
import { z } from "zod";

const num = z.number();
const nullableNum = z.number().nullable();

export const envelope = <T extends z.ZodTypeAny>(data: T) => z.object({ data });

export const apiErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.unknown()).default({}),
  }),
});
export type ApiErrorBody = z.infer<typeof apiErrorBody>;

// ---- /api/health -----------------------------------------------------------
export const health = z
  .object({
    service: z.string(),
    version: z.string(),
    read_only: z.boolean(),
    node_control: z.boolean(),
  })
  .passthrough();
export type Health = z.infer<typeof health>;

// ---- /api/status -----------------------------------------------------------
export const nodeStatus = z
  .object({
    node_id: z.string(),
    url: z.string(),
    up: z.boolean(),
    shards: num,
    managed: z.boolean(),
    running: z.boolean().nullable(), // null when the server runs without --manage
    pid: nullableNum,
  })
  .passthrough();
export type NodeStatus = z.infer<typeof nodeStatus>;

export const clusterStatus = z
  .object({
    k: num,
    m: num,
    files: num,
    bytes: num,
    nodes: z.array(nodeStatus),
    nodes_up: num,
  })
  .passthrough();
export type ClusterStatus = z.infer<typeof clusterStatus>;

// ---- files -----------------------------------------------------------------
export const fileStatus = z.enum(["healthy", "degraded", "at_risk", "lost"]);
export type FileStatus = z.infer<typeof fileStatus>;

export const fileSummary = z
  .object({
    file_id: z.string(),
    name: z.string(),
    size: num,
    sha256: z.string().nullable(),
    k: num,
    m: num,
    chunk_size: num,
    chunk_count: num,
    created_at: z.string(),
  })
  .passthrough();
export type FileSummary = z.infer<typeof fileSummary>;

export const fileListItem = fileSummary
  .extend({
    status: fileStatus.nullable(),
    fault_tolerance: nullableNum,
    protection_verified: z.literal(false),
  })
  .passthrough();
export type FileListItem = z.infer<typeof fileListItem>;

export const fileList = z.object({ files: z.array(fileListItem) });

export const shardStatus = z.enum(["ok", "unverified", "missing", "corrupt", "node_down"]);
export type ShardStatus = z.infer<typeof shardStatus>;

export const shard = z.object({
  shard_index: num,
  node_id: z.string(),
  status: shardStatus,
});
export type Shard = z.infer<typeof shard>;

export const stripeReport = z
  .object({
    chunk_index: num,
    k: num,
    m: num,
    n: num,
    valid: num,
    shard_status_counts: z.record(num),
    margin: num,
    recoverable: z.boolean(),
    valid_shards_per_node: z.record(num),
    min_node_failures_to_lose: nullableNum,
    shards: z.array(shard).optional(), // present only with include_shards
  })
  .passthrough();
export type StripeReport = z.infer<typeof stripeReport>;

export const lossSet = z.object({
  nodes: z.array(z.string()),
  size: num,
  stripes_lost: z.array(num),
});
export type LossSet = z.infer<typeof lossSet>;

export const fileAnalysis = z
  .object({
    file_id: z.string(),
    name: z.string(),
    size: num,
    sha256: z.string(),
    stripe_count: num,
    coding: z.array(z.string()),
    status: fileStatus,
    recoverable: z.boolean(),
    fault_tolerance: nullableNum,
    design_tolerance: nullableNum,
    placement_concentrated: z.boolean(),
    smallest_loss_set_size: nullableNum,
    minimal_loss_sets_total: num,
    minimal_loss_sets: z.array(lossSet),
    minimal_loss_sets_truncated: z.boolean(),
    enumeration_complete: z.boolean(),
    explanation: z.string(),
    stripes: z.array(stripeReport),
  })
  .passthrough();
export type FileAnalysis = z.infer<typeof fileAnalysis>;

export const fileDetail = fileSummary
  .extend({ snapshot_verified: z.boolean(), protection: fileAnalysis })
  .passthrough();
export type FileDetail = z.infer<typeof fileDetail>;

// ---- /api/twin ---------------------------------------------------------------
export const snapshotInfo = z.object({
  taken_at: z.string(),
  verified: z.boolean(),
  fingerprint: z.string(),
});

export const twin = z
  .object({
    snapshot: snapshotInfo,
    nodes: z.array(z.object({ node_id: z.string(), up: z.boolean() })),
    summary: z.object({
      files: num,
      status_counts: z.record(num),
      recoverable_files: num,
      cluster_fault_tolerance: nullableNum,
      smallest_loss_set_size: nullableNum,
    }),
    cluster_minimal_loss_sets: z.array(
      z.object({ nodes: z.array(z.string()), size: num, files_lost: z.array(z.string()) }),
    ),
    cluster_minimal_loss_sets_total: num,
    cluster_minimal_loss_sets_truncated: z.boolean(),
    enumeration_complete: z.boolean(),
    files: z.array(fileAnalysis),
    timing_ms: z.object({ observe: num, analyze: num }).optional(),
  })
  .passthrough();
export type Twin = z.infer<typeof twin>;

// ---- /api/scenarios/preview -----------------------------------------------------
export const previewStripe = z
  .object({
    chunk_index: num,
    k: num,
    m: num,
    valid_before: num,
    valid_shards_lost: z.record(num),
    valid_after: num,
    recoverable_after: z.boolean(),
    explanation: z.string(),
  })
  .passthrough();
export type PreviewStripe = z.infer<typeof previewStripe>;

export const previewFile = z
  .object({
    file_id: z.string(),
    name: z.string(),
    sha256: z.string(),
    status_before: fileStatus,
    status_after: fileStatus,
    recoverable_before: z.boolean(),
    recoverable_after: z.boolean(),
    fault_tolerance_after: nullableNum,
    stripes_affected: num,
    stripes_lost: z.array(num),
    stripes: z.array(previewStripe),
    explanation: z.string(),
  })
  .passthrough();
export type PreviewFile = z.infer<typeof previewFile>;

export const previewSummary = z.object({
  files_total: num,
  files_affected: num,
  files_unaffected: num,
  files_lost_after: num,
  files_newly_lost: num,
  data_loss_predicted: z.boolean(),
});

export const scenarioPreview = z
  .object({
    scenario_id: z.string().regex(/^scn-[0-9a-f]{12}$/),
    nodes: z.array(z.string()),
    nodes_already_down: z.array(z.string()),
    snapshot: snapshotInfo,
    summary: previewSummary,
    predictions: z.record(z.boolean()),
    files: z.array(previewFile),
    explanation: z.string(),
    executable: z.boolean(),
    note: z.string().optional(),
  })
  .passthrough();
export type ScenarioPreview = z.infer<typeof scenarioPreview>;

// ---- scenario reports (/execute, /scenarios/{id}) -------------------------------
export const scrubSummary = z
  .object({
    files_checked: num,
    shards_checked: num,
    issues: num,
    repaired: num,
    unrepaired: num,
    lost_chunks: z.array(z.object({ file_id: z.string(), chunk_index: num })),
    healthy: z.boolean(),
    details: z.array(
      z.object({
        file_id: z.string(),
        chunk_index: num,
        shard_index: num,
        node_id: z.string(),
        kind: z.string(),
        resolution: z.string(),
      }),
    ),
  })
  .passthrough();
export type ScrubSummary = z.infer<typeof scrubSummary>;

export const repairResult = scrubSummary.extend({ after: scrubSummary }).passthrough();
export type RepairResult = z.infer<typeof repairResult>;

export const outageResult = z
  .object({
    name: z.string(),
    sha256_expected: z.string(),
    predicted_recoverable: z.boolean(),
    actual_recoverable: z.boolean(),
    prediction_matched: z.boolean(),
    recovered: z.boolean(),
    error: z.string().nullable(),
    bytes_read: num,
    sha256_actual: z.string().nullable(),
    sha256_match: z.boolean(),
    reconstructed_chunks: num,
    shard_issues: z.record(num),
    elapsed_ms: num,
  })
  .passthrough();
export type OutageResult = z.infer<typeof outageResult>;

export const timelineStep = z.object({ ts: z.string(), action: z.string() }).passthrough();
export type TimelineStep = z.infer<typeof timelineStep>;

export const scenarioReport = z
  .object({
    run_id: z.string(),
    scenario_id: z.string(),
    nodes: z.array(z.string()),
    mode: z.enum(["restart", "replace"]),
    restore_mode: z.enum(["restart", "replace"]),
    started_at: z.string(),
    finished_at: z.string(),
    initial_state: z.object({
      nodes: z.record(z.boolean()),
      files: z.record(z.object({ name: z.string(), sha256: z.string(), size: num })),
    }),
    prediction: z.object({
      summary: previewSummary,
      predictions: z.record(z.boolean()),
      explanation: z.string(),
      files: z.array(previewFile),
    }),
    outage_results: z.record(outageResult),
    prediction_matched: z.boolean(),
    mismatches: z.array(z.string()),
    restore_errors: z.array(z.string()),
    repair: scrubSummary,
    verification: scrubSummary,
    final_integrity: z.record(
      z.object({ recovered: z.boolean(), sha256_match: z.boolean(), error: z.string().nullable() }),
    ),
    all_files_intact_after: z.boolean(),
    timeline: z.array(timelineStep),
    summary: z.string(),
  })
  .passthrough();
export type ScenarioReport = z.infer<typeof scenarioReport>;

export const scenarioListItem = z.object({
  run_id: z.string(),
  scenario_id: z.string(),
  ts: z.string(),
  nodes: z.array(z.string()),
  mode: z.string(),
  prediction_matched: z.boolean(),
});
export type ScenarioListItem = z.infer<typeof scenarioListItem>;
export const scenarioList = z.object({ scenarios: z.array(scenarioListItem) });

// ---- misc ------------------------------------------------------------------
export const gcResult = z.object({ removed: z.record(num) });
export const nodeControlResult = z.object({ node_id: z.string(), running: z.boolean() });
export const deleteResult = z.object({ deleted: z.string() });

export const event = z.object({
  ts: z.string(),
  kind: z.string(),
  file_id: z.string().nullable(),
  chunk_index: nullableNum,
  shard_index: nullableNum,
  node_id: z.string().nullable(),
  detail: z.unknown(), // string, parsed JSON object, or null
});
export type SonarkEvent = z.infer<typeof event>;
export const eventList = z.object({ events: z.array(event) });

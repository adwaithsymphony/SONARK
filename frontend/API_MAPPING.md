# SONARK frontend: API mapping

This file is derived from the backend source (`sonark/api.py`, `twin.py`, `scenario.py`,
`metadata.py`), not from the UI design document. Every schema lives in
`src/api/schemas.ts`. Each one is tested against real responses captured from a running
backend (`scripts/capture_fixtures.py` → `src/test/fixtures/*.json` → `src/test/schemas.test.ts`).

All HTTP goes through `src/api/client.ts`:
- JSON responses must be wrapped as `{data}`.
- Errors arrive as `{error:{code,message,details}}`.

The client raises one of three typed errors:
- `ApiUnreachableError`: network failure, CORS refusal, or server down.
- `ApiRequestError`: any non-2xx response. It carries `status`, `code`, `details` and the raw body.
- `SchemaError`: a 2xx response with an unexpected shape. It carries the Zod issues and the raw body.

The UI shows all three through `ErrorPanel`, which also shows the raw response.

## Endpoints → screens and actions

| Backend route | Client function | Where it is used | Notes |
|---|---|---|---|
| `GET /api/health` | `api.health` | Top bar reachability pill, disconnected banner, experiment blockers | Polled every 5 s, no retry. Its failure drives the "Disconnected · last OK" state. |
| `GET /api/status` | `api.status` | 3D/2D stage nodes, cluster summary, node inspector, Twin node checklist | Polled every 5 s. This is the only source of node ids, `up`, `shards`, `managed`, `running`, `pid`. |
| `GET /api/files` | `api.files` | Storage Explorer, dock Files/Findings, search, protection breakdown | Polled every 10 s. `protection_verified` is always `false`, and the UI says so. |
| `PUT /api/files?name=` | `api.upload` (XHR) | Explorer upload box | Raw bytes. Progress shows bytes *sent*. "Stored (201)" is shown only after the backend answers. |
| `GET /api/files/{ref}?verify=true` | `api.fileDetail` | File inspector, shard markers and placement lines on the stage | Verified: reads every shard of that file. Gives per-stripe, per-shard placement and state. |
| `GET /api/files/{ref}/content` | `api.download` | File inspector "Download & verify" | The browser hashes the bytes (WebCrypto) and compares with the stored SHA-256. Reads the `X-Sonark-*` headers. |
| `DELETE /api/files/{ref}?confirm={file_id}` | `api.deleteFile` | File inspector "Delete" | You must type the file name. The UI sends the file_id as `confirm`. |
| `GET /api/twin?verify=true&shards=true&max_sets=50` | `api.twin` | Survival Twin summary, minimal failure combinations, Stripe Matrix, node → files list, cluster summary | Polled every 30 s only while the Twin view is open. Shows `snapshot.taken_at`, `fingerprint`, `timing_ms`, and the truncation and enumeration-cap flags. |
| `POST /api/scenarios/preview` `{nodes, verify:true}` | `api.preview` | Twin "Preview (hypothetical)" panel, Stripe Matrix "If failed" column | Debounced 350 ms. Obsolete requests are aborted. Keyed on node states plus the Twin fingerprint, so a state change forces a fresh preview. |
| `POST /api/scenarios/execute` `{nodes, confirm: scenario_id, mode}` | `api.execute` | Twin "Controlled experiment" dialog | Needs typed node names. Sends the scenario_id of the preview on screen. Polling pauses while it runs. 428/409 are shown with the backend message. |
| `GET /api/scenarios?limit=50` | `api.scenarios` | Scenario Lab history list | Polled every 15 s. |
| `GET /api/scenarios/{run_id}` | `api.scenario` | Proof of Survival view | Cached forever, since stored reports never change. "Export JSON" downloads this report, labelled as an unsigned frontend export. |
| `POST /api/scrub` `{}` | `api.scrub` | Integrity view, dock Findings | Read-only. |
| `POST /api/repair` `{confirm:true}` | `api.repair` | Integrity view | Needs a confirmation dialog. Shows the repair pass and the backend's `after` verification scrub. |
| `POST /api/gc` `{confirm:true}` | `api.gc` | Integrity view | Needs a confirmation dialog. |
| `POST /api/nodes/{id}/stop` `{confirm:id}` | `api.nodeStop` | Node inspector | You must type the node id. Enabled only for `managed && running`, with node control on and not read-only. |
| `POST /api/nodes/{id}/start` `{}` | `api.nodeStart` | Node inspector | Shown for managed nodes that are not running. |
| `GET /api/events?limit=200` | `api.events` | Event History view, dock Events, Proof "Event log during this run" | Polled every 5 s while visible. Links lead to node, file and scenario run (`detail.run_id`). |

After any mutation the client refetches status, files, twin, file detail, preview,
scenarios and events (`useInvalidateCluster`). It never updates cluster state
optimistically.

## Response schemas (summary)

| Schema | Key fields |
|---|---|
| `health` | `service, version, read_only, node_control` |
| `clusterStatus` | `k, m, files, bytes, nodes_up, nodes[{node_id, url, up, shards, managed, running (null without --manage), pid}]` |
| `fileListItem` | file summary + `status` (healthy, degraded, at_risk, lost, or null), `fault_tolerance`, `protection_verified:false` |
| `fileDetail` | file summary + `snapshot_verified`, `protection` (= `fileAnalysis`) |
| `fileAnalysis` | `status, recoverable, fault_tolerance, design_tolerance, placement_concentrated, smallest_loss_set_size, minimal_loss_sets[{nodes,size,stripes_lost}], *_total, *_truncated, enumeration_complete, explanation, stripes[]` |
| `stripeReport` | `chunk_index, k, m, n, valid, margin, recoverable, shard_status_counts, valid_shards_per_node, min_node_failures_to_lose, shards?[{shard_index,node_id,status}]` |
| `twin` | `snapshot{taken_at,verified,fingerprint}, nodes, summary{files,status_counts,recoverable_files,cluster_fault_tolerance,smallest_loss_set_size}, cluster_minimal_loss_sets[{nodes,size,files_lost}], *_total, *_truncated, enumeration_complete, files[], timing_ms` |
| `scenarioPreview` | `scenario_id (scn-[12 hex]), nodes, nodes_already_down, snapshot, summary{files_total,files_affected,files_unaffected,files_lost_after,files_newly_lost,data_loss_predicted}, predictions{file_id:bool}, files[{status_before/after, recoverable_before/after, fault_tolerance_after, stripes_affected, stripes_lost, stripes[{valid_before, valid_shards_lost, valid_after, recoverable_after, explanation}], explanation}], explanation, executable, note?` |
| `scenarioReport` | `run_id, scenario_id, nodes, mode, restore_mode, started_at, finished_at, initial_state, prediction, outage_results{file_id:{predicted_recoverable, actual_recoverable, prediction_matched, recovered, error, bytes_read, sha256_expected, sha256_actual, sha256_match, reconstructed_chunks, shard_issues, elapsed_ms}}, prediction_matched, mismatches, restore_errors, repair, verification, final_integrity, all_files_intact_after, timeline[{ts, action, ...}], summary` |
| `scrubSummary` | `files_checked, shards_checked, issues, repaired, unrepaired, lost_chunks[], healthy, details[≤200]` (repair adds `after`) |
| `event` | `ts, kind, file_id, chunk_index, shard_index, node_id, detail (string, object or null)` |

## Request scheduling (client side)

`src/api/scheduler.ts` controls when requests start:
- **At most 2 lock-bound requests in flight.** The server runs them one at a time anyway.
- **User-initiated requests go first.** File detail, preview, execute, scenario report,
  mutations, downloads and uploads start before queued background polls.
- **`GET /api/health` bypasses the queue**, because the server answers it without the lock.
- **Polling backs off** to 3x the endpoint's last measured latency, capped at 60 s, so
  polls cannot pile up while a node is down.
- **Polling stops entirely** while an experiment runs.

## Evidence views (derived only from stored reports)

| View | Source fields | Shown as "not reported" |
|---|---|---|
| Recovery timeline (9 stages) | `timeline[]` actions (`node_stopped`, `verified_nodes_down`, `retrieval_attempted`, `replace_downgraded`, `node_restored`, `node_restore_failed`, `repair_ran`, `verification_scrub`, `final_readback`); `outage_results`, `repair`, `verification`, `final_integrity` | retrieval start time, list of surviving shards, per-stripe progress |
| Scenario state ledger | `prediction`, `scenario_id`, `started_at`/`finished_at`, `verified_nodes_down`, `outage_results[].error`/`sha256_match`, `repair`, `verification` | — |
| Per-file verdict | `error`, `sha256_actual`, `sha256_match`, `reconstructed_chunks` give READ · VERIFIED, RECONSTRUCTED · VERIFIED, RECONSTRUCTED · INTEGRITY FAILED, or NOT RECONSTRUCTED | — |
| Proof header | run and scenario ids, timestamps; backend version from `/api/health`, labelled as the server answering now | operator, cluster ID |
| JSON export | the stored report wrapped with the export time; SHA-256 of the exported file computed in the browser (a checksum, not a signature) | signature |
| Print / PDF | the browser prints the proof only (`@media print`) | — |
| Integrity findings | `/api/scrub` or `/api/repair` `details[]` and `lost_chunks`. "What repair can accomplish" restates the `store._scrub_chunk` rules using the verified Twin stripe, only when that snapshot still shows the same problem | scan scope by file or node (unsupported); detection time is when the page received the result |
| Shard inspector | shards from file detail or the Twin stripe; the shard id follows the backend naming scheme | per-shard checksum (not exposed by the API) |
| Node inspector | `/api/status`; history from events that mention the node | capacity used, last heartbeat |
| Event inspector and export | `/api/events` rows (the latest 200); JSON or CSV export of the filtered rows | correlation id for non-scenario events |

## Design requirements vs backend support

**Supported directly by the backend**
- Node states, shard counts and managed/running flags.
- Per-shard placement and verified status.
- Survivability: tolerance, minimal loss sets, explanations.
- Hypothetical preview with per-stripe outcomes.
- Confirmed execution, with prediction vs reality, SHA-256 values, repair and verification.
- Scenario history, events, scrub, repair, GC, upload, download, delete, node stop and start.

**Client-side presentation logic only**
- Deterministic ring layout from sorted node ids.
- LIVE/PREVIEW/EXPERIMENT mode.
- Search, sort and filter.
- Marking which valid shards sit on a hypothetically failed node, in the stripe matrix. This uses the backend's own failure model; the outcome numbers still come from the preview response.
- Browser SHA-256 of downloaded bytes.
- Elapsed-time counter during an experiment.
- Grouping of the events recorded during a run.
- JSON export.

**Not supported by the backend, and therefore not shown or faked**
- Live event stream (SSE/WebSocket): the UI polls instead.
- Progress events or job status during a scenario: the UI shows "running" with real elapsed time, and the backend's timeline only after the run returns.
- PDF or signed certificate endpoint: only an unsigned JSON export of the real report is offered.
- Network topology between nodes: no node-to-node edges are drawn.
- Per-node capacity, disk usage, latency or throughput metrics.
- Shard-level corruption in the fast `/api/files` list: the UI labels that list "not verified".
- The upload size limit (`--max-upload-mib`) is not exposed: a 413 is shown when it is hit.
- `Content-Disposition` is not CORS-exposed: downloads use the known file name.

# Sonark — Storage Core Specification

Sonark stores files as Reed–Solomon erasure-coded shards across independent
storage nodes. It detects damage with SHA-256, rebuilds data after node failures,
and repairs missing or corrupt shards. Pure Python 3.11+, standard library only.

## 1. Architecture

```
            ┌──────────── coordinator (sonark.store.Sonark) ────────────┐
 file ──►   │ chunker ─► RS encoder ─► placement ─► parallel HTTP PUTs │
            │ metadata (SQLite)   scrub / repair   health sweep        │
            └───────┬────────┬────────┬────────┬────────┬────────┬─────┘
                    ▼        ▼        ▼        ▼        ▼        ▼
                  node n1  node n2  node n3  node n4  node n5  node n6
                  (separate processes, own data directory, HTTP API)
```

| Module | Role |
|---|---|
| `gf256.py` | GF(2⁸) arithmetic, poly 0x11D; log/exp tables; 256 byte-translation tables; Gauss–Jordan inverse |
| `rs.py` | Systematic RS(k, m) erasure codec |
| `node.py` | Storage node server. Stores opaque shards; knows nothing about files |
| `client.py` | HTTP client for one node; `NodeUnavailable` vs `NodeError` |
| `metadata.py` | SQLite schema and queries; the only record of placement and hashes |
| `store.py` | Coordinator: put / get / scrub / repair / gc / delete / status |
| `cli.py`, `demo.py` | Command line and the end-to-end failure demo |
| `twin.py` | **Survival Twin**: snapshot of real shard state, loss-set analysis, scenario preview (§11) |
| `supervisor.py` | Starts and stops local node processes; the only way scenarios can fail nodes (§13) |
| `scenario.py` | Controlled failure: predict, stop, retrieve, verify SHA-256, compare, restore, repair (§13) |
| `api.py` | Local JSON API, standard library only (§12) |
| `twin_demo.py` | Deterministic Survival Twin fixture: exhaustive sweep plus real scenarios |

## 2. Erasure coding

- A file is split into chunks of `chunk_size` bytes (default 4 MiB; the last one is shorter).
- Each chunk is zero-padded to `k · ceil(len/k)` and cut into `k` data shards.
- `m` parity shards come from the encoding matrix `[I_k ; C]`, where `C` is a
  Cauchy matrix `C[i][j] = 1 / ((k+i) XOR j)`. Every square submatrix of a Cauchy
  matrix is invertible, so any `k` of the `n = k+m` shards rebuild the chunk (MDS).
- Decoding: take the first `k` intact shards (data shards preferred), invert the
  matching `k×k` rows, multiply. If all data shards are intact, no decoding happens.
- Speed: multiplying a buffer by a constant is `bytes.translate`; addition is XOR
  of Python big integers. Both run in C.
- Limits: `k ≥ 1`, `m ≥ 0`, `k + m ≤ 256`. Tolerates up to `m` lost or corrupt shards per chunk.

## 3. Integrity (SHA-256 at three levels)

| Level | Stored in | Checked when |
|---|---|---|
| Shard | `shards.sha256` | node on upload (`X-Content-SHA256` header); coordinator on every read and scrub |
| Chunk | `chunks.sha256` | after every chunk is assembled or rebuilt, and before repair writes anything |
| File  | `files.sha256`  | at the end of every full read |

A shard that fails its hash is treated as erased. A rebuilt shard must match its
original recorded hash before it is written back. Encoding is deterministic, so a
correct rebuild always matches.

## 4. Metadata model (SQLite, `metadata.db`)

```
files  (file_id PK, name, size, sha256, k, m, chunk_size, chunk_count,
        state 'writing'|'complete', created_at)
chunks (file_id, chunk_index) PK, size, shard_size, sha256
shards (file_id, chunk_index, shard_index) PK, node_id, sha256
events (id, ts, kind, file_id, chunk_index, shard_index, node_id, detail)
scenarios (run_id PK, scenario_id, ts, nodes, mode, matched, report JSON)
```

- `k`, `m` and `chunk_size` are stored per file, so changing the cluster config never breaks old files.
- Shard id on nodes: `<file_id>-<chunk:06d>-<shard:03d>`.
- A file is visible only when `state = 'complete'`. A failed write deletes its shards and rows.
- `events` is an append-only log of put, scrub, repair, data_loss, delete and gc.

## 5. Node protocol (HTTP/1.1)

| Request | Result |
|---|---|
| `GET /health` | 200 `{node_id, status}` |
| `GET /stats` | 200 `{node_id, shard_count, bytes_used}` |
| `GET /shards` | 200 `{shards: [...]}` |
| `GET /shards/<id>` | 200 bytes, or 404 |
| `PUT /shards/<id>` | 201; 400 on hash mismatch or bad id; 413 if over 256 MiB |
| `DELETE /shards/<id>` | 204, or 404 |

Shard ids must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`, which blocks path
traversal. Writes go to `tmp/` with fsync, then `os.replace` into
`shards/<id[:2]>/<id>`, so a crash never leaves a half-written shard in place.

## 6. Placement

- A write needs at least `n` healthy nodes, otherwise `PlacementError` and nothing is stored.
- Chunk `c` uses the healthy nodes rotated by `c`, so the `n` shards of one chunk
  land on `n` distinct nodes and load spreads across the cluster.
- A failed shard PUT moves on to the next unused healthy node.

## 7. Read path

1. Run one parallel health sweep. Nodes found down are skipped for the rest of
   the operation, so a dead node's connect timeout (about 2 s on Windows) is paid once.
2. For each chunk, fetch the `k` data shards in parallel and verify their hashes.
3. If any fail, fetch the parity shards, then decode.
4. Verify the chunk hash, then the file hash at the end.
5. `get_file` writes to `<out>.sonark-partial` and renames only after the whole
   file has verified. On failure the partial file is deleted.
6. Fewer than `k` intact shards raises `DataLossError`. Sonark never returns unverified bytes.

## 8. Scrub and repair

`scrub(repair=False)` fetches **every** shard and classifies it as ok,
`missing` (404), `corrupt` (hash mismatch) or `node_down`.

With `repair=True`, for each damaged chunk that still has at least `k` intact shards:

1. Rebuild all `n` shards and check the chunk hash.
2. For each bad shard, check the rebuilt bytes against its recorded hash.
3. Choose a target:
   - the original node, if it is up (missing or corrupt shard);
   - otherwise the least-loaded healthy node that holds no shard of this chunk.
     The shard is written there and `shards.node_id` is updated.
   - If no such node exists, the shard is marked `DEFERRED`.
4. Chunks with fewer than `k` intact shards are reported as `lost_chunks`. Their
   shards are marked `UNRECOVERABLE` and nothing is written.

Repair is idempotent: running it again on a healthy cluster writes nothing.
`sonark repaird --interval N` runs scrub plus repair in a loop. `gc` deletes
shards a live node holds that metadata no longer places there, such as stale
copies on a node that came back after its shards were moved.

## 9. Failure model

| Scenario | Outcome |
|---|---|
| ≤ m nodes down or shards bad per chunk | reads succeed; repair restores full redundancy |
| node down, spare node available | shards move to the spare; old copies are removed by `gc` if the node returns |
| node down, no spare (`nodes = k+m`) | repair is deferred; restarting the node or replacing it with an empty one, then repairing, restores redundancy |
| > m bad shards in a chunk | `DataLossError` on read; scrub reports a lost chunk; nothing is fabricated |
| corruption in transit | node rejects the PUT (hash header) |
| fewer than n nodes up at write time | `PlacementError`; no partial file is visible |

## 10. Known limitations

- There is one coordinator, and its SQLite file is a single point of failure. It is not replicated or backed up.
- There is no authentication or TLS on the node API. Bind nodes to trusted networks only.
- Shards are buffered in memory per chunk, so memory use is about `chunk_size · (1 + n/k)`.
  API downloads buffer the whole file, which is capped by the upload limit (64 MiB by default).
- Cluster membership is static, set in `cluster.json`. There is no rebalancing when nodes are added.
- `ReadReport` lists only the shards it touched. Parity shards are not fetched when the data shards are intact, so use `scrub` for a full health picture.
- Windows takes about 2 s to report a refused connection to a loopback port (it retries the
  SYN). Health probes to loopback nodes therefore use a 0.5 s *connect* limit; the response
  still gets the full timeout, so a slow but alive node is not reported down
  (`NodeClient.health`, `tests/test_health.py`). With a node down, each health sweep costs
  about 0.5 s, and each read, scrub, Twin snapshot and status request runs one sweep.
- The API serializes storage operations behind one lock. `GET /api/health` is exempt because
  it touches neither storage nor metadata. A running scenario blocks other requests,
  including `GET /api/status`, until it finishes.
- Survival Twin treats node failures as whole-node and simultaneous. It does not model
  partial disk loss, time to failure or repair races.

## 11. Survival Twin

**Snapshot** (`twin.observe`). For every stripe (chunk) of every complete file, the
snapshot records each shard's node (taken from metadata, so uneven placement is
captured as it is) and its status:

| status | meaning | counts as valid |
|---|---|---|
| `ok` | fetched and SHA-256 matched (verified snapshot) | yes |
| `unverified` | on a node that answered `/health`; not fetched (`verify=false`) | yes |
| `missing` | the node answered 404 | no |
| `corrupt` | the node returned bytes whose SHA-256 does not match metadata | no |
| `node_down` | the node is unreachable | no |

Coding parameters `(k, m)` are read per file. Files with different parameters can share a cluster.

**Survival rule.** A stripe with parameters `(k, m)` is recoverable iff it has at
least `k` valid shards. If the set of nodes `F` fails, the stripe loses every valid
shard held on `F`, and it survives iff `valid − Σ_{n∈F} w(n) ≥ k`. Here `w(n)` is the
number of valid shards of that stripe on node `n`, which may be 0, 1 or more. A file
survives `F` iff all of its stripes do.

**Definitions.**
- *Loss set* of a file: a node set whose joint failure makes the file unrecoverable.
- *Minimal loss set*: a loss set with no proper subset that is also a loss set (inclusion-minimal).
- *Smallest loss set*: a minimal loss set of minimum size.
- *Fault tolerance* = smallest size − 1. The file survives **any** combination of that many
  node failures, and some combination of one more node destroys it. An already-lost file has
  smallest size 0, and its only minimal loss set is ∅. An empty file has no stripes and no loss sets.
- *Cluster minimal loss sets*: the inclusion-minimal sets among all files' loss sets,
  meaning the smallest node sets that destroy at least one file.

**File status.**
- `lost`: some stripe has fewer than k valid shards.
- `at_risk`: some single node failure would lose data (fault tolerance 0).
- `degraded`: some stripe has invalid shards.
- `healthy`: otherwise.

`placement_concentrated` is true when a fully healthy file tolerates fewer failures
than its `m`, which happens when one node holds several shards of one stripe.

**Algorithm.** For each stripe, let `need = valid − k + 1`. `F` is a loss set iff
`Σw(F) ≥ need`. Weights are positive, so `F` is minimal iff removing any single
member drops the sum below `need`, and every minimal set has at most `need` members.
The algorithm enumerates combinations of the nodes holding valid shards, of size
1..need (`C(h, ≤need)`; for 4+2 that is at most 41 checks). The smallest size is
computed exactly by taking the heaviest nodes first. File-level minimal sets are the
inclusion-minimal members of the union of the stripe sets, and stripes with an
identical `(weights, need)` profile are computed once.

**Limits, stated explicitly.**
- Enumeration stops at 200,000 candidate checks per stripe profile. If that happens,
  `enumeration_complete = false`, the listed sets may be incomplete, and the smallest
  size and fault tolerance stay exact.
- Lists are truncated to `max_sets` (default 50), with `*_total` giving the true count and `*_truncated` flags set.

**Validation.**
- `tests/test_twin.py` compares the analyzer with brute force over every node subset,
  on 300 random uneven placements with mixed statuses and coding parameters.
- `tests/test_survival.py` and `twin-demo` compare predictions with **real Reed–Solomon
  reads** for every subset of nodes (2⁷ × 3 files and 2⁶ × 4 files).

## 12. Scenario preview and execution

**Preview** (`twin.preview`, `POST /api/scenarios/preview`) is pure computation on a
snapshot and changes nothing. It returns:
- `scenario_id`: `scn-` plus 12 hex characters of SHA-256 over the sorted node set and the snapshot fingerprint;
- per-file `status_before` and `status_after`, `recoverable_before` and `recoverable_after`, and `fault_tolerance_after`;
- per affected stripe, `valid_before`, `valid_shards_lost` (by node), `valid_after`, and an explanation;
- a `predictions` map (`file_id → recoverable`) covering every file;
- `nodes_already_down`.

**Execution** (`scenario.run_scenario`, `POST /api/scenarios/execute`):
1. Every target node must be managed by this server's supervisor and running.
2. A fresh **verified** snapshot is taken, and `confirm` must equal its `scenario_id`. A
   stale confirmation is refused with 428 and the current id, because any change in shard
   state changes the id.
3. `mode="replace"` is refused (409) if any file is predicted to be lost.
4. Initial state and file hashes are recorded, and a `scenario_start` event is logged.
5. The node processes are killed, and the server checks that they no longer answer.
6. Every file is read through the normal read path. The bytes received are hashed with
   SHA-256 and compared with the original. This gives the outcome per file:
   `actual_recoverable`, `sha256_actual`, `error`, `reconstructed_chunks`, `elapsed_ms`.
7. Each prediction is compared with the actual outcome (`prediction_matched`, `mismatches`).
8. The nodes are restarted. This always happens, in a `finally` block.
   - `restart` keeps their data.
   - `replace` wipes their data directories, but only if every file actually
     survived. Otherwise it falls back to `restart` and records the fallback in the timeline.
9. `scrub(repair=True)` runs, followed by a verification scrub, and then every file is read back again.
10. The full report is stored in the `scenarios` table, and a `scenario_end` event is logged.

Recovery results are never fabricated. A lost file reports `actual_recoverable: false` with the decoder's error.

## 13. Node control

- `NodeSupervisor` starts nodes as child processes (`python -m sonark node`). Each node's
  data lives in `<cluster dir>/nodes/<id>`, and the server writes `<cluster dir>/run/<id>.pid`.
- Only loopback URLs with explicit ports can be managed. Node ids must be safe directory names.
- A node that was already serving when the supervisor started is reported as unmanaged
  and is never stopped.
- `sonark stop-local` kills orphaned node processes left by an unclean exit. It uses the
  pid files and only acts if that node still answers `/health` with its own id.

## 14. HTTP API (`sonark serve`)

Base URL `http://127.0.0.1:8800/api`. A success returns `{"data": ...}`. An error returns
`{"error": {"code", "message", "details"}}`.

| Method & path | Purpose | Notes |
|---|---|---|
| `GET /health` | service info | `{service, version, read_only, node_control}`; does not wait for the storage lock |
| `GET /status` | cluster and nodes | `{k, m, files, bytes, nodes_up, nodes:[{node_id,url,up,shards,managed,running,pid}]}` |
| `GET /files` | file list with protection (unverified) | `{files:[{file_id,name,size,sha256,k,m,chunk_size,chunk_count,created_at,status,fault_tolerance,protection_verified:false}]}` |
| `PUT /files?name=N` | upload raw bytes | `Content-Type: application/octet-stream`, `Content-Length` required; 201 returns the file record |
| `GET /files/{id-or-name}?verify=true` | details plus per-stripe, per-shard protection | `{..file, snapshot_verified, protection:{status, fault_tolerance, minimal_loss_sets, stripes:[...]}}` |
| `GET /files/{ref}/content` | download | bytes; headers `X-Sonark-SHA256`, `X-Sonark-Degraded`, `X-Sonark-Reconstructed-Chunks`; 503 if unrecoverable |
| `DELETE /files/{ref}?confirm={file_id}` | delete | 428 without the matching confirm |
| `GET /twin?verify=true&max_sets=50&shards=false` | full Survival Twin analysis | `{snapshot, nodes, summary, cluster_minimal_loss_sets[_total/_truncated], files:[...], timing_ms}` |
| `POST /scenarios/preview` `{"nodes":[..], "verify":true}` | non-destructive prediction | adds `executable` |
| `POST /scenarios/execute` `{"nodes":[..], "confirm":"scn-…", "mode":"restart"\|"replace"}` | controlled failure | 428 with `details.expected_confirm` if unconfirmed or stale; 409 if a node is unmanaged or stopped, or replace is unsafe |
| `GET /scenarios?limit=50` | past runs | `{scenarios:[{run_id,scenario_id,ts,nodes,mode,prediction_matched}]}` |
| `GET /scenarios/{run_id}` | full stored report | see §12 |
| `POST /scrub` `{}` | read-only integrity check | `{files_checked, shards_checked, issues, repaired, unrepaired, lost_chunks, healthy, details}` |
| `POST /repair` `{"confirm":true}` | repair, then verify | same shape plus `after` |
| `POST /gc` `{"confirm":true}` | delete orphan shards | `{removed:{node:count}}` |
| `POST /nodes/{id}/stop` `{"confirm":"{id}"}` | stop a managed node | 428 without the confirm |
| `POST /nodes/{id}/start` `{}` | restart a managed node | |
| `GET /events?limit=50` | event log, newest first | `{events:[{ts,kind,file_id,chunk_index,shard_index,node_id,detail}]}` (`detail` parsed when it is JSON) |

**Status codes:**

| Code | Meaning |
|---|---|
| 400 | validation error |
| 403 | foreign `Host` header, read-only mode, or CORS refused |
| 404 | not found |
| 405 | wrong method (`details.allow`) |
| 409 | conflict |
| 411 | length required |
| 413 | body too large |
| 415 | JSON required |
| 428 | confirmation required |
| 503 | data unavailable, too few nodes, or busy |

**Safety:**
- The API binds to loopback only. A non-loopback bind requires `--allow-remote` and makes the API read-only.
- The `Host` header must be a loopback host.
- JSON endpoints require `application/json`, which forces a CORS preflight for any browser
  page. Preflights are allowed only for origins given with `--cors-origin`.
- File names must be 1–255 characters, with no slashes, backslashes or control characters.
  Names are only metadata and never become paths.
- Shard ids and node ids are regex-checked before touching the filesystem.

Example (responses abridged from a real run):

```sh
curl -X PUT "http://127.0.0.1:8800/api/files?name=in.bin" \
     -H "Content-Type: application/octet-stream" --data-binary @in.bin
curl -X POST http://127.0.0.1:8800/api/scenarios/preview \
     -H "Content-Type: application/json" -d '{"nodes":["n2","n5"]}'
# {"data":{"scenario_id":"scn-0134c4dcc429","executable":true,"summary":{...},
#   "predictions":{"<file_id>":true},"files":[...],
#   "explanation":"Failing n2, n5 would make 0 recoverable file(s) unrecoverable; ..."}}
curl -X POST http://127.0.0.1:8800/api/scenarios/execute \
     -H "Content-Type: application/json" -d '{"nodes":["n2","n5"],"confirm":"scn-0134c4dcc429"}'
# {"data":{"run_id":"run-dd76798fc434","prediction_matched":true,"outage_results":{...},
#   "repair":{...},"verification":{"healthy":true,...},
#   "summary":"Failed n2, n5. Predicted 1/1 files recoverable; actually recovered 1/1 ..."}}
```

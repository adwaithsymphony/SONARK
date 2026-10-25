# Handoff — Sonark (after Cycle 1: Survival Twin)

**Date:** 2026-10-24. **Design reference:** `SONARK_SPEC.md`. Section 11 covers the Twin
math, section 12 scenarios, section 14 the API contract.
Python 3.11+ with the standard library only; tested on Windows 11 with Python 3.13.

## What exists

| Area | Status | Where |
|---|---|---|
| RS(k,m) erasure coding, GF(256) | from cycle 0, unchanged | `rs.py`, `gf256.py` |
| Node processes, HTTP shard API, SHA-256 on upload | from cycle 0, unchanged | `node.py`, `client.py` |
| Coordinator: put/get/scrub/repair/gc, SQLite metadata | from cycle 0; small additive changes (below) | `store.py`, `metadata.py` |
| **Survival Twin analyzer** (snapshot, loss sets, tolerance, preview) | new | `twin.py` |
| **Node supervisor** (real process stop/start/replace, pid files) | new | `supervisor.py` |
| **Controlled scenarios** (predict, kill, read, verify SHA-256, compare, restore, repair, record) | new | `scenario.py` |
| **Local JSON API** | new | `api.py` |
| **Deterministic Twin fixture** | new | `twin_demo.py` |
| CLI: `init-local`, `serve`, `twin`, `preview`, `stop-local`, `twin-demo` | new commands | `cli.py` |

Changes to existing modules (all additive):
- `metadata.py`
  - new `scenarios` table (`CREATE IF NOT EXISTS`, so existing DBs keep working);
  - `save_scenario`, `list_scenarios` and `get_scenario`;
  - optional `check_same_thread=False` and a `threadsafe` flag.
- `store.py`: `Sonark(..., threadsafe_metadata=False)`.
- `tests/test_cluster.py`: the `Cluster(..., threadsafe=False)` helper parameter.

## Run it

```sh
# tests (isolated temp dirs and random free ports; never touches a real cluster)
python -m unittest discover -s tests -t . -v

# demos (each builds and deletes its own temp cluster)
python -m sonark demo          # storage core: 6 node processes, failures, bit rot, repair
python -m sonark twin-demo     # Survival Twin: analysis, 64-subset sweep, 4 real scenarios
python -m sonark twin-demo --json-out twin_results.json

# a persistent local cluster + API
python -m sonark init-local --dir sonark-cluster --nodes 6 --k 4 --m 2 --base-port 9300
python -m sonark --cluster sonark-cluster/cluster.json serve --manage --port 8800
#   add --cors-origin http://localhost:5173 for a dev UI on another port
#   stop with Ctrl+C (nodes are stopped too)

# CLI against the same cluster, in another terminal (nodes must be running)
python -m sonark --cluster sonark-cluster/cluster.json twin
python -m sonark --cluster sonark-cluster/cluster.json preview n2 n5
```

**Reset procedure:**
1. Stop `serve` with Ctrl+C.
2. If it was killed hard, run `python -m sonark --cluster sonark-cluster/cluster.json stop-local`.
3. Delete the `sonark-cluster/` directory.
4. Run `init-local` again.

Demos and tests never use `sonark-cluster/`.

## Test results (actual)

Final run on 2026-10-24 (Windows 11, Python 3.13):

| Command | Result |
|---|---|
| `python -m compileall -q sonark tests` and `python -m pyflakes sonark tests` | clean |
| `python -m unittest discover -s tests -t . -v` | **80 tests, all OK** in 3 min 48 s |
| `python -m sonark demo` | all checks passed (10 s) |
| `python -m sonark twin-demo` | ALL CHECKS PASSED (66 s) |

Tests per file:

| File | Tests | Covers |
|---|---|---|
| `test_rs` | 13 | Reed–Solomon codec |
| `test_cluster` | 19 | storage core |
| `test_twin` | 18 | analyzer vs brute force: 300 random uneven placements × every node subset |
| `test_survival` | 5 | real damage classification; every subset of 7 nodes × 3 files, compared with real decode |
| `test_scenario` | 9 | real process kills: confirmation, stale confirmation, survivable, unrecoverable, partial loss, replace + repair, replace refused, unmanaged nodes, API execute flow |
| `test_api` | 16 | API contract, validation, safety |

Measured in `twin-demo` (6 nodes; files at 4+2, 2+1, 3+3, and 4+2 with uneven placement):
- **Sweep:** Survival Twin matched real decode **256/256**. A naive "survives any ≤ m
  failures" rule matched 221/256.
- **Real scenarios:** 4/4 predictions matched. The replace scenario rebuilt 9 shards.
  Every file was intact after each scenario.
- **Analysis cost:** a verified snapshot of 45 shards took 44.8 ms, and the analysis 0.7 ms.

## What is demonstrated vs only implemented

**Demonstrated** by running code in tests or demos:
- predictions agree with real Reed–Solomon decodes for every node subset;
- real process kills, with SHA-256 verification of the recovered files;
- loss reported honestly when a file can't be recovered;
- replace mode with rebuild of the wiped nodes;
- confirmation and stale-confirmation refusal;
- API validation and error codes;
- Host-header and CORS checks;
- cleanup of orphan node processes.

**Implemented but not exercised:**
- `repaird` (a loop around the tested `scrub(repair=True)`);
- `--allow-remote` read-only mode over a real non-loopback socket. It is tested at the
  dispatcher level only, to avoid a firewall prompt.
- the 200,000-check enumeration cap on a real cluster. It is tested on a pure 10+6 stripe.

The exhaustive sweeps simulate the outage at the client (the failed nodes refuse
connections instantly), so all 2^N subsets run quickly. The shards really are fetched
from live nodes and really decoded. Scenarios kill real OS processes.

## Known limitations / open work

- **Speed:** Windows takes about 2 s to refuse a loopback connection. Since cycle 3 the health
  probe stops at a 0.5 s connect limit for loopback nodes (the read timeout is unchanged), so
  a sweep with a node down costs about 0.5 s. Each read still runs its own sweep (`iter_chunks`).
- **Blocking:** the API holds a single lock, so a scenario blocks status polling while it
  runs. A UI should show a pending state. A background job plus a `GET /api/jobs/{id}`
  endpoint would remove the block.
- **Downloads** are fully buffered (capped by `--max-upload-mib`, 64 by default).
- **Single coordinator:** the metadata DB is a single point of failure. There is no
  authentication or TLS (the API is local only by design).
- **Supervisor reach:** only loopback nodes started by `serve --manage` can be failed.
  Nodes started by hand show as `managed: false`.
- **Failure model:** the Twin models whole-node failures only. Shards that are corrupt
  but not yet scrubbed count as valid in `verify=false` snapshots (`/api/files` uses that
  fast mode). `/api/twin` and the scenarios verify by default.

## Next cycle (UI) — backend contract summary

- Poll `GET /api/status` (nodes up, managed, running, shards) and `GET /api/files`
  (status, fault_tolerance).
- Twin view: `GET /api/twin` gives `summary`, `cluster_minimal_loss_sets[]` (with
  `files_lost`) and `files[]`. Each file has `status`, `fault_tolerance`,
  `design_tolerance`, `placement_concentrated`, `minimal_loss_sets[]` with
  `stripes_lost` per set, an `explanation`, and `stripes[]` with
  `valid_shards_per_node` and status counts.
- **Predict:** `POST /api/scenarios/preview {"nodes":[...]}` returns `scenario_id`,
  `predictions`, `files[].stripes[].explanation` and `executable`.
- **Break and prove:**
  - `POST /api/scenarios/execute {"nodes":[...], "confirm": scenario_id, "mode":"restart"|"replace"}`
    returns `outage_results` (per file: `predicted_recoverable`, `actual_recoverable`,
    `sha256_expected`, `sha256_actual`, `reconstructed_chunks`, `error`),
    `prediction_matched`, `repair`, `verification`, `timeline[]` and `summary`.
  - A 428 response carries `details.expected_confirm`.
- History: `GET /api/scenarios`, `GET /api/scenarios/{run_id}` and `GET /api/events`.

## Cycle 2: frontend (`frontend/`), 2026-10-25

The frontend is a React + TypeScript (strict) + Vite + Tailwind app with a Three.js
stage (R3F/drei), TanStack Query, Zustand and Zod. The backend is unchanged in this cycle.
- Start: see `frontend/README.md`.
- Endpoint and schema mapping: see `frontend/API_MAPPING.md`.

```sh
python -m sonark --cluster sonark-cluster/cluster.json serve --manage --port 8800 --cors-origin http://localhost:5173
cd frontend && npm install && npm run dev      # http://localhost:5173
```

Results (2026-10-25, Windows 11, Node 24, Edge headless):

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm test` | 55 passed; 4 live tests skipped by default |
| `npm run build` | OK; Three.js is a lazy chunk |
| live tests (`SONARK_LIVE=1`, real `serve --manage` on a throwaway cluster) | 4/4 passed; a real n2 scenario took 9.4 s, prediction matched |
| `scripts/e2e-browser.mjs` (real browser through the UI) | all four flows passed, 0 console errors (below) |

The browser flows (`twin`, `files`, `integrity`, `disconnect`):
- **twin:** preview → typed confirmation → real scenario (9.8 s, matched) → proof → back to LIVE.
- **files:** upload → browser SHA-256 matched the stored hash.
- **integrity:** a flipped bit found by scrub, rebuilt by repair, verified healthy.
- **disconnect:** API stopped mid-session → banner and STALE labels shown.

Known frontend limitations are listed at the end of `frontend/API_MAPPING.md`: no stream,
no progress during a scenario, unsigned JSON export only, and `/api/files` unverified.

## Cycle 3: responsiveness with a node down, and evidence views (2026-10-25)

**Measured problem** (real browser, n6 stopped):
- The page fired 6 requests at once.
- Every storage request ran a health sweep costing 2.03 s (the Windows refused-connect
  time) while holding the single API lock.
- So `/api/health` waited 8.4 s, `/api/events` waited 14.9 s, and the selected file's
  verified detail appeared after 14.6 s.

**Backend changes** (minimal; regression tests in `tests/test_health.py`):
- `client.py` `NodeClient.health`: the TCP connect step has a 0.5 s limit for loopback
  nodes. The response read keeps the full timeout, so a slow but alive node is still
  healthy (tested with a server that answers after 1 s).
- `api.py`: `GET /api/health` no longer waits for the storage lock; it returns constants
  only. A test holds the lock and checks that health answers while status returns 503 busy.

**Frontend changes** (`frontend/src/api/scheduler.ts`):
- At most 2 lock-bound requests in flight.
- User actions start before background polls.
- Queued requests can be aborted.
- Polling backs off to 3x the measured latency.
- The top bar shows "slow" based on measured status latency.

**After** (same setup):
- The verified file detail was visible after 2.6 s.
- Health takes about 0 s; polls take about 0.5 s; requests no longer pile up.
- A real n4 scenario took 6.9 s through the UI (it was 9.8–15.6 s).

## Final hardening (2026-10-25)

### API lock limitation (unresolved, by design for now)

`SonarkAPI` serializes every storage and metadata operation behind one `RLock`. The only
exception is `GET /api/health`, which touches neither storage nor metadata. This is what
keeps the single SQLite connection and the node set consistent, and it has these costs:

- **A scenario blocks everything for its whole run.** That covers stop, reads, restore,
  repair, verification and readback: measured at 4–7 s on the demo cluster, longer with
  more or larger files. Status, file list, Twin, events and other requests wait. A request
  that waits longer than `lock_timeout` (60 s) gets `503 busy`. The UI pauses polling
  during a run and says the API is busy.
- **One sweep per storage request while a node is down.** Every storage request (status,
  file list, verified detail, Twin, preview, read) runs a health sweep, which costs about
  0.5 s per request on Windows (the floor for a refused loopback connect). Scenarios pay
  it once per file read.
- **The lock is not first-come-first-served.** One browser tab is well behaved because its
  client-side scheduler sends at most 2 storage requests and gives user actions priority.
  Several tabs or clients can still contend and see longer waits.
- **Remote (non-loopback) nodes** keep the full 2 s connect timeout in health probes.

This cycle deliberately makes no concurrency redesign. A safe fix needs at least these:
- a connection per thread, or a separate read-only connection, so reads can skip the lock;
- one health sweep per scenario instead of one per file;
- a background job for scenarios with a `GET /api/jobs/{id}` status endpoint.

Each changes how the store and the scenario runner interact and needs its own regression
suite.

### Hardening results

- **Blank 3D stage after switching to Survival Twin:** not reproducible. There were 0 blank
  stages in 104 view switches across five conditions:
  - nav clicks, healthy cluster (24);
  - nav clicks, node stopped (24);
  - node stopped plus 1.5 s emulated latency (16);
  - hash navigation (24);
  - full reloads (16).

  Every switch had drawn nodes by 400 ms. No code was changed for it; the probe stays as
  `node scripts/e2e-browser.mjs --flow blank`.
- **Proof PDF:** rendered and inspected page by page. Fixed:
  - stage 5 split across a page break;
  - text clipped at the right edge (event JSON);
  - collapsed timeline details missing from the print;
  - chevrons printing;
  - two background tones;
  - an off-centre page;
  - the "0/0 decoded" wording.

  The proof now prints at about 3 pages, with no text past the margins.
- **Clean-cluster demo:** fully performed through the real UI. See "Launch the demo on
  Windows" in `frontend/README.md`.

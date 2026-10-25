# SONARK Spatial Workstation (frontend)

React + TypeScript (strict) + Vite + Tailwind, with a Three.js stage (React Three Fiber
and drei). It uses TanStack Query for server state, Zustand for UI state, Zod for
response validation, and Lucide icons. It talks only to the real Sonark API; there is
no mock mode.

## Run

Terminal 1, the backend (from the repository root):

```sh
python -m sonark init-local --dir sonark-cluster --nodes 6 --k 4 --m 2 --base-port 9300
python -m sonark --cluster sonark-cluster/cluster.json serve --manage --port 8800 --cors-origin http://localhost:5173
```

Terminal 2, the frontend:

```sh
cd frontend
npm install
npm run dev          # http://localhost:5173
```

- **API base URL:** set `VITE_API_BASE_URL` (default `http://127.0.0.1:8800`), either in
  `frontend/.env.local` or in the environment, e.g.
  `VITE_API_BASE_URL=http://127.0.0.1:8810 npm run dev`.
- **CORS:** the API only answers browsers from origins listed with `--cors-origin`.
  - The dev server runs at `http://localhost:5173`.
  - `npm run preview` runs at `http://localhost:4173`; add that origin too if you use it.
  - If you open the page as `http://127.0.0.1:5173`, that is a different origin and must be added as well.
- **Node control:** `--manage` is required for scenarios and for node stop/start.
  Without it the UI stays usable but disables those actions and says why.

## Launch the demo on Windows (PowerShell)

Prerequisites: Python 3.11+ and Node 20+ (tested with Python 3.13 and Node 24).

```powershell
# Terminal 1: backend (from the repository root, e.g. D:\ANOMALY\Sonark)
python -m sonark init-local --dir sonark-cluster --nodes 6 --k 4 --m 2 --base-port 9300
python -m sonark --cluster sonark-cluster/cluster.json serve --manage --port 8800 --cors-origin http://localhost:5173
#   leave it running; Ctrl+C stops the API and the 6 node processes

# Terminal 2: frontend
cd frontend
npm install        # first time only
npm run dev        # open http://localhost:5173 in Chrome or Edge (http://localhost, not 127.0.0.1)
```

Demo path in the UI:
1. Storage Explorer: upload a file, open it, then use Download & verify.
2. Survival Twin: tick a node, read the preview, then Prepare experiment, type the node
   name and stop it.
3. Open Proof of Survival, then Export JSON or Print / PDF.
4. Integrity & Repair: Start scan, then Repair.

Reset:
1. Press Ctrl+C in terminal 1.
2. If the API was killed hard, run
   `python -m sonark --cluster sonark-cluster/cluster.json stop-local`.
3. Delete `sonark-cluster/`, then run `init-local` again.

If port 8800 is taken, start the API with `--port 8810` and the frontend with
`$env:VITE_API_BASE_URL="http://127.0.0.1:8810"; npm run dev`.

## Checks

```sh
npm run typecheck    # tsc, strict
npm test             # vitest: schemas vs captured real responses, client, logic, workflows
npm run build        # production build into dist/
```

Optional checks against a real backend. Use a throwaway cluster: they run real
scenarios and repairs.

```sh
python frontend/scripts/capture_fixtures.py                 # re-capture fixtures (temp cluster, auto-deleted)
SONARK_LIVE=1 VITE_API_BASE_URL=http://127.0.0.1:8810 npx vitest run src/test/live.test.ts
node scripts/e2e-browser.mjs --url http://localhost:5173 --flow twin,files,integrity --upload <abs path> --out <dir>
```

## Layout

- **Nav rail.** Views: Cluster, Storage Explorer, Survival Twin, Scenario Lab & Proof,
  Integrity & Repair, Events. Shortcuts Alt+1…6; `/` focuses search.
- **Top bar.** Search (files, ids, SHA-256 prefix, nodes), API reachability, and the
  LIVE / PREVIEW / EXPERIMENT mode.
- **Workspace.**
  - Spatial stage: 3D, with a 2D fallback when WebGL is missing or the renderer fails.
  - Or a precise 2D surface: tables, stripe matrix, proof.
- **Inspector** (collapsible): cluster summary, node, file, or the Survival Twin workflow.
- **Dock** (collapsible, drag the top edge to resize): Files, Stripe matrix, Findings, Events.
  The Survival Twin opens the stripe matrix here.
- **Deep links:** `#/<view>?file=<file_id>&nodes=n1,n2&run=<run_id>&stage=2d&surface=matrix`
  (`surface=matrix` opens the stripe matrix in the dock). These set UI state only.
- **Visual system:** spec palette as CSS variables in `src/index.css` and tokens in
  `src/theme/tokens.ts`. Fonts: Geist Sans (UI), IBM Plex Mono (technical data, tabular
  numerals) and Instrument Serif (editorial lines only). All timestamps are UTC.

See `API_MAPPING.md` for every endpoint, schema and limitation.

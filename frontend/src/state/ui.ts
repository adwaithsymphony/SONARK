/** Interface state only. Server state lives in TanStack Query, never here. */
import { create } from "zustand";
import type { ScenarioReport, SonarkEvent } from "../api/schemas";

/** A shard picked in the matrix or on the stage (identity only; state comes from the API). */
export interface ShardRef {
  fileId: string;
  chunk: number;
  shard: number;
}

export type View = "cluster" | "files" | "twin" | "lab" | "integrity" | "events";
export const VIEWS: View[] = ["cluster", "files", "twin", "lab", "integrity", "events"];
export type DockTab = "files" | "matrix" | "findings" | "events";
export type StageKind = "3d" | "2d";

export type Experiment =
  | { phase: "idle" }
  | { phase: "running"; nodes: string[]; mode: "restart" | "replace"; scenarioId: string; startedAt: number }
  | { phase: "done"; report: ScenarioReport; finishedAt: number }
  // modified: false = the backend refused before stopping anything (4xx);
  // null = no report came back, so whether nodes were stopped is unknown.
  | { phase: "failed"; nodes: string[]; error: unknown; finishedAt: number; modified: false | null };

export type Mode = "LIVE" | "PREVIEW" | "EXPERIMENT";

interface UiState {
  view: View;
  selectedNode: string | null;
  selectedFile: string | null; // file_id
  selectedStripe: number | null; // chunk_index within selectedFile
  selectedRun: string | null;
  selectedShard: ShardRef | null;
  /** the event row the user opened; events carry no id, so the row itself is kept */
  selectedEvent: SonarkEvent | null;
  shortcutsOpen: boolean;
  /** what the inspector shows: the most recently selected kind of object */
  focus: "node" | "file" | "shard" | "event" | null;
  eventFilter: string; // free-text filter of the Events view (set by "Show related events")
  hypothetical: string[]; // node ids, sorted; never applied to live state
  stage: StageKind;
  layers: { labels: boolean; shards: boolean; placement: boolean };
  cameraToken: number; // bump to reset camera
  focusToken: number; // bump to focus selection
  inspectorOpen: boolean;
  dockOpen: boolean;
  dockTab: DockTab;
  dockHeight: number; // px, user-resizable
  kiosk: boolean;
  introSeen: boolean; // editorial intro line shows on first load only
  experiment: Experiment;

  setView: (v: View) => void;
  selectNode: (id: string | null) => void;
  selectFile: (id: string | null) => void;
  selectStripe: (i: number | null) => void;
  selectRun: (id: string | null) => void;
  selectShard: (s: ShardRef | null) => void;
  selectEvent: (e: SonarkEvent | null) => void;
  setShortcutsOpen: (o: boolean) => void;
  setEventFilter: (q: string) => void;
  clearSelection: () => void;
  toggleHypothetical: (id: string) => void;
  setHypothetical: (ids: string[]) => void;
  setStage: (s: StageKind) => void;
  openMatrix: () => void;
  setDockHeight: (h: number) => void;
  dismissIntro: () => void;
  toggleLayer: (l: keyof UiState["layers"]) => void;
  resetCamera: () => void;
  focusSelection: () => void;
  setInspectorOpen: (o: boolean) => void;
  setDock: (open: boolean, tab?: DockTab) => void;
  setKiosk: (k: boolean) => void;
  setExperiment: (e: Experiment) => void;
}

const sortUnique = (ids: string[]) => [...new Set(ids)].sort(naturalCompare);

export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** Deep link: #/<view>?file=<file_id>&nodes=n1,n2&run=<run_id>&stage=2d (UI state only). */
export function parseHash(hash: string): {
  view: View;
  file: string | null;
  nodes: string[];
  run: string | null;
  stage: StageKind | null;
  surface: "matrix" | null;
} {
  const raw = hash.replace(/^#\/?/, "");
  const [path = "", query = ""] = raw.split("?");
  const q = new URLSearchParams(query);
  const nodes = (q.get("nodes") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const stage = q.get("stage");
  return {
    view: (VIEWS as string[]).includes(path) ? (path as View) : "cluster",
    file: q.get("file"),
    nodes,
    run: q.get("run"),
    stage: stage === "2d" || stage === "3d" ? stage : null,
    surface: q.get("surface") === "matrix" ? "matrix" : null,
  };
}

const initialLink = parseHash(typeof window === "undefined" ? "" : window.location.hash);
// Spec 4.1: >=1280 full frame; 768-1279 the inspector is a drawer and the dock starts collapsed.
const wide = typeof window === "undefined" || window.innerWidth >= 1280;

export const useUi = create<UiState>((set) => ({
  view: initialLink.view,
  selectedNode: null,
  selectedFile: initialLink.file,
  selectedStripe: null,
  selectedRun: initialLink.run,
  selectedShard: null,
  selectedEvent: null,
  shortcutsOpen: false,
  focus: initialLink.file ? "file" : null,
  eventFilter: "",
  hypothetical: sortUnique(initialLink.nodes),
  stage: initialLink.stage ?? "3d",
  layers: { labels: true, shards: true, placement: true },
  cameraToken: 0,
  focusToken: 0,
  inspectorOpen: wide,
  dockOpen: wide || initialLink.surface === "matrix",
  dockTab: initialLink.surface === "matrix" ? "matrix" : "files",
  dockHeight: 224,
  kiosk: false,
  introSeen: false,
  experiment: { phase: "idle" },

  setView: (view) => {
    if (typeof window !== "undefined" && !window.location.hash.startsWith(`#/${view}`)) {
      window.history.replaceState(null, "", `#/${view}`);
    }
    set((s) => ({ view, introSeen: s.introSeen || view !== s.view }));
  },
  selectNode: (selectedNode) => set({ selectedNode, selectedShard: null, selectedEvent: null, focus: selectedNode ? "node" : null }),
  selectFile: (selectedFile) =>
    set({ selectedFile, selectedStripe: null, selectedShard: null, selectedEvent: null, focus: selectedFile ? "file" : null }),
  selectStripe: (selectedStripe) => set({ selectedStripe }),
  selectRun: (selectedRun) => set({ selectedRun }),
  selectShard: (selectedShard) =>
    set(
      selectedShard
        ? { selectedShard, selectedFile: selectedShard.fileId, selectedStripe: selectedShard.chunk, selectedEvent: null, focus: "shard" }
        : { selectedShard: null, focus: null },
    ),
  selectEvent: (selectedEvent) => set({ selectedEvent, selectedShard: null, focus: selectedEvent ? "event" : null }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  setEventFilter: (eventFilter) => set({ eventFilter }),
  clearSelection: () => set({ selectedNode: null, selectedFile: null, selectedStripe: null, selectedShard: null, selectedEvent: null, focus: null }),
  toggleHypothetical: (id) =>
    set((s) => ({
      hypothetical: s.hypothetical.includes(id)
        ? s.hypothetical.filter((n) => n !== id)
        : sortUnique([...s.hypothetical, id]),
    })),
  setHypothetical: (ids) => set({ hypothetical: sortUnique(ids) }),
  setStage: (stage) => set({ stage }),
  openMatrix: () => set((s) => ({ dockOpen: true, dockTab: "matrix", dockHeight: Math.max(s.dockHeight, 300) })),
  setDockHeight: (h) => set({ dockHeight: Math.round(Math.min(Math.max(h, 120), 640)) }),
  dismissIntro: () => set({ introSeen: true }),
  toggleLayer: (l) => set((s) => ({ layers: { ...s.layers, [l]: !s.layers[l] } })),
  resetCamera: () => set((s) => ({ cameraToken: s.cameraToken + 1 })),
  focusSelection: () => set((s) => ({ focusToken: s.focusToken + 1 })),
  setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),
  setDock: (dockOpen, tab) => set((s) => ({ dockOpen, dockTab: tab ?? s.dockTab })),
  setKiosk: (kiosk) => set({ kiosk }),
  setExperiment: (experiment) => set({ experiment }),
}));

/**
 * LIVE unless a hypothesis is selected (PREVIEW) or a real experiment ran or is
 * running (EXPERIMENT). A run the backend refused before stopping anything is
 * not an experiment: the cluster was not modified.
 */
export function deriveMode(s: Pick<UiState, "experiment" | "hypothetical">): Mode {
  const e = s.experiment;
  if (e.phase === "running" || e.phase === "done" || (e.phase === "failed" && e.modified !== false)) return "EXPERIMENT";
  if (s.hypothetical.length > 0) return "PREVIEW";
  return "LIVE";
}

export const useMode = () => useUi((s) => deriveMode(s));
export const useExperimentRunning = () => useUi((s) => s.experiment.phase === "running");

/** Exact mode copy (spec 4.2). */
export const MODE_COPY: Record<Mode, string> = {
  LIVE: "LIVE — ACTUAL BACKEND STATE",
  PREVIEW: "HYPOTHETICAL — CLUSTER NOT MODIFIED",
  EXPERIMENT: "ACTUAL — CLUSTER MODIFIED",
};

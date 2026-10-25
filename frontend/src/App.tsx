import { useEffect } from "react";
import ClusterStage from "./components/stage/ClusterStage";
import Dock from "./components/frame/Dock";
import { DisconnectedBanner, G_KEYS, NAV_ITEMS, NavRail, ShortcutSheet, TopBar } from "./components/frame/Frame";
import Inspector from "./components/frame/Inspector";
import StatusStrip from "./components/frame/StatusStrip";
import { useRecordLastSeen } from "./state/observed";
import { parseHash, useUi, type View } from "./state/ui";
import EventsView from "./views/EventsView";
import FilesView from "./views/FilesView";
import IntegrityView from "./views/IntegrityView";
import LabView from "./views/LabView";

function Workspace({ view }: { view: View }) {
  switch (view) {
    case "cluster":
      return (
        <div className="flex h-full min-h-0 flex-col gap-2">
          <StatusStrip />
          <div className="min-h-0 flex-1">
            <ClusterStage />
          </div>
        </div>
      );
    case "files":
      return <FilesView />;
    case "twin":
      return (
        <div className="flex h-full min-h-0 flex-col gap-2">
          <p className="text-2xs text-muted">
            Select nodes on the stage or in the Twin panel to propose failures. Nothing is stopped. The stripe matrix is in the dock below.
          </p>
          <div className="min-h-0 flex-1">
            <ClusterStage />
          </div>
        </div>
      );
    case "lab":
      return <LabView />;
    case "integrity":
      return <div className="h-full overflow-auto"><IntegrityView /></div>;
    case "events":
      return <EventsView />;
  }
}

export default function App() {
  const ui = useUi();
  useRecordLastSeen();

  // Spec 6.D: in the Survival Twin the stripe matrix lives in the dock.
  useEffect(() => {
    const s = useUi.getState();
    if (ui.view === "twin" && s.dockTab === "files") s.setDock(s.dockOpen, "matrix");
  }, [ui.view]);

  useEffect(() => {
    const onHash = () => {
      const link = parseHash(window.location.hash);
      const st = useUi.getState();
      st.setView(link.view);
      if (link.file) st.selectFile(link.file);
      if (link.run) st.selectRun(link.run);
      if (link.nodes.length && st.experiment.phase !== "running") st.setHypothetical(link.nodes);
      if (link.stage) st.setStage(link.stage);
      if (link.surface === "matrix") st.openMatrix();
    };
    let gPending = false;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      if (e.altKey && /^[1-6]$/.test(e.key)) {
        const item = NAV_ITEMS[Number(e.key) - 1];
        if (item) {
          e.preventDefault();
          useUi.getState().setView(item.view);
        }
      } else if (!typing && e.key === "/") {
        e.preventDefault();
        document.querySelector<HTMLInputElement>("[data-global-search]")?.focus();
      } else if (!typing && e.key === "Escape") {
        const s = useUi.getState();
        if (s.shortcutsOpen) s.setShortcutsOpen(false);
        else if (s.kiosk) s.setKiosk(false);
        else s.clearSelection();
      } else if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const s = useUi.getState();
        const target = gPending ? G_KEYS[e.key] : undefined;
        gPending = false;
        if (target) {
          e.preventDefault();
          s.setView(target);
        } else if (e.key === "g") {
          gPending = true;
        } else if (e.key === "?") {
          e.preventDefault();
          s.setShortcutsOpen(!s.shortcutsOpen);
        } else if ((e.key === "f" || e.key === "F") && s.selectedNode) {
          s.focusSelection();
        }
      }
    };
    window.addEventListener("hashchange", onHash);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  if (ui.kiosk) {
    return (
      <div className="flex h-full flex-col bg-bg">
        <TopBar />
        <DisconnectedBanner />
        <div className="min-h-0 flex-1 p-2">
          <ClusterStage />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:px-2 focus:py-1">
        Skip to workspace
      </a>
      <NavRail />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <DisconnectedBanner />
        <div className="relative flex min-h-0 flex-1">
          <main id="main" className="min-h-0 min-w-0 flex-1 p-3">
            <Workspace view={ui.view} />
          </main>
          <Inspector />
        </div>
        <Dock />
      </div>
      <ShortcutSheet />
    </div>
  );
}

import { ChevronDown, ChevronUp } from "lucide-react";
import { useEvents, useFiles } from "../../api/queries";
import { formatBytes, formatTime, formatTolerance } from "../../lib/format";
import { fileStatusMeta } from "../../lib/status";
import { useFindings } from "../../state/findings";
import { useUi, type DockTab } from "../../state/ui";
import { Empty, ErrorPanel, FileStatusBadge, Freshness, Loading, cx } from "../common/ui";
import { EventRows } from "../../views/EventsView";
import StripeMatrix from "../../views/StripeMatrix";

const TABS: { id: DockTab; label: string }[] = [
  { id: "files", label: "Files" },
  { id: "matrix", label: "Stripe matrix" },
  { id: "findings", label: "Findings" },
  { id: "events", label: "Events" },
];

export default function Dock() {
  const ui = useUi();
  const files = useFiles();
  const findings = useFindings((s) => s.last);
  const events = useEvents(ui.dockOpen && ui.dockTab === "events");
  const problemFiles = (files.data?.files ?? []).filter((f) => f.status && f.status !== "healthy");
  const findingCount = problemFiles.length + (findings && !findings.result.healthy ? findings.result.issues : 0);

  // Drag the top edge to resize (spec 4.1: resizable dock, collapsible to a 32 px strip).
  const startDrag = (e: React.PointerEvent) => {
    const y0 = e.clientY;
    const h0 = ui.dockHeight;
    const move = (ev: PointerEvent) => useUi.getState().setDockHeight(h0 + (y0 - ev.clientY));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <section
      aria-label="Dock"
      className="relative flex shrink-0 flex-col border-t border-line bg-surface"
      style={{ height: ui.dockOpen ? `min(${ui.dockHeight}px, 60vh)` : 32 }}
    >
      {ui.dockOpen && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize dock"
          tabIndex={0}
          onPointerDown={startDrag}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") ui.setDockHeight(ui.dockHeight + 24);
            if (e.key === "ArrowDown") ui.setDockHeight(ui.dockHeight - 24);
          }}
          className="absolute -top-1 left-0 right-0 z-10 h-2 cursor-row-resize hover:bg-line-strong"
        />
      )}
      <div className="flex h-8 shrink-0 items-center gap-1 px-2" role="tablist" aria-label="Dock tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={ui.dockOpen && ui.dockTab === t.id}
            onClick={() => ui.setDock(!(ui.dockOpen && ui.dockTab === t.id), t.id)}
            className={cx(
              "rounded px-2 py-0.5 text-2xs font-semibold uppercase tracking-[0.1em]",
              ui.dockOpen && ui.dockTab === t.id ? "bg-raised text-ink" : "text-faint hover:text-ink",
            )}
          >
            {t.label}
            {t.id === "files" && files.data && <span className="ml-1 font-mono text-faint">{files.data.files.length}</span>}
            {t.id === "findings" && findingCount > 0 && <span className="ml-1 font-mono text-degraded">{findingCount}</span>}
          </button>
        ))}
        <button className="icon-btn ml-auto" onClick={() => ui.setDock(!ui.dockOpen)} aria-label={ui.dockOpen ? "Collapse dock" : "Expand dock"}>
          {ui.dockOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
        </button>
      </div>
      {ui.dockOpen && (
        <div className={cx("min-h-0 flex-1 border-t border-line", ui.dockTab === "matrix" ? "overflow-hidden" : "overflow-auto")} role="tabpanel">
          {ui.dockTab === "matrix" && <StripeMatrix />}
          {ui.dockTab === "files" &&
            (files.data ? (
              files.data.files.length === 0 && !files.isError ? (
                <div className="px-3"><Empty>No files stored.</Empty></div>
              ) : (
                <ul>
                  {files.isError && (
                    <li className="px-3 py-1">
                      <Freshness updatedAt={files.dataUpdatedAt} isError />
                    </li>
                  )}
                  {files.data.files.map((f) => (
                    <li key={f.file_id}>
                      <button
                        onClick={() => {
                          ui.selectFile(ui.selectedFile === f.file_id ? null : f.file_id);
                          ui.setInspectorOpen(true);
                        }}
                        className={cx("grid w-full grid-cols-[1fr_5rem_4rem_6rem_3rem] items-center gap-2 px-3 py-1 text-left text-xs hover:bg-raised", ui.selectedFile === f.file_id && "bg-raised")}
                        aria-pressed={ui.selectedFile === f.file_id}
                      >
                        <span className="truncate">{f.name}</span>
                        <span className="text-right font-mono text-2xs text-muted">{formatBytes(f.size)}</span>
                        <span className="font-mono text-2xs text-muted">{f.k}+{f.m}</span>
                        <FileStatusBadge status={f.status} />
                        <span className="text-right font-mono text-2xs text-faint" title="fault tolerance (fast check)">t{formatTolerance(f.fault_tolerance, true)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )
            ) : files.isError ? (
              <div className="p-2"><ErrorPanel compact error={files.error} /></div>
            ) : (
              <div className="px-3"><Loading /></div>
            ))}
          {ui.dockTab === "findings" && (
            <div className="space-y-2 p-2 text-xs">
              <div>
                <div className="label mb-1">Files not healthy (fast check)</div>
                {problemFiles.length === 0 ? (
                  <Empty>None reported by <code>/api/files</code>.</Empty>
                ) : (
                  <ul>
                    {problemFiles
                      .sort((a, b) => fileStatusMeta[a.status!].rank - fileStatusMeta[b.status!].rank)
                      .map((f) => (
                        <li key={f.file_id}>
                          <button className="flex w-full items-center gap-2 rounded px-1 hover:bg-raised" onClick={() => ui.selectFile(f.file_id)}>
                            <FileStatusBadge status={f.status} /> {f.name}
                          </button>
                        </li>
                      ))}
                  </ul>
                )}
              </div>
              <div>
                <div className="label mb-1">Last scrub / repair from this page</div>
                {findings ? (
                  <button className="text-left hover:underline" onClick={() => ui.setView("integrity")}>
                    {findings.kind} at {formatTime(findings.at)}: {findings.result.issues} issue(s), {findings.result.repaired} repaired,{" "}
                    {findings.result.lost_chunks.length} lost chunk(s) · {findings.result.healthy ? "healthy" : "not healthy"}
                    {findings.kind === "repair" && ` · after: ${findings.result.after.healthy ? "healthy" : "NOT healthy"}`}
                  </button>
                ) : (
                  <Empty>No scrub run yet. Shard corruption is only found by a scrub or a verified read.</Empty>
                )}
              </div>
            </div>
          )}
          {ui.dockTab === "events" &&
            (events.data ? (
              <>
                <div className="flex justify-end px-3 pt-1"><Freshness updatedAt={events.dataUpdatedAt} isError={events.isError} /></div>
                <EventRows events={events.data.events.slice(0, 50)} compact />
              </>
            ) : events.isError ? (
              <div className="p-2"><ErrorPanel compact error={events.error} /></div>
            ) : (
              <div className="px-3"><Loading /></div>
            ))}
        </div>
      )}
    </section>
  );
}

import { useMemo, useState } from "react";
import { useEvents } from "../api/queries";
import type { SonarkEvent } from "../api/schemas";
import { formatDateTime } from "../lib/format";
import { useUi } from "../state/ui";
import { Empty, ErrorPanel, Freshness, Loading, cx } from "../components/common/ui";
import { exportEvents } from "../components/frame/DetailInspectors";

export function eventRunId(e: SonarkEvent): string | null {
  const d = e.detail as { run_id?: unknown } | null;
  return d && typeof d === "object" && typeof d.run_id === "string" ? d.run_id : null;
}

export function detailText(e: SonarkEvent): string {
  if (e.detail === null || e.detail === undefined) return "";
  return typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail);
}

export function EventRows({ events, compact }: { events: SonarkEvent[]; compact?: boolean }) {
  const ui = useUi();
  return (
    <table className="w-full border-separate border-spacing-0 text-xs">
      <thead>
        <tr>
          <th className="table-head px-3 py-1.5">Time</th>
          <th className="table-head px-2 py-1.5">Kind</th>
          <th className="table-head px-2 py-1.5">Node</th>
          <th className="table-head px-2 py-1.5">File</th>
          {!compact && <th className="table-head px-2 py-1.5">Chunk/shard</th>}
          <th className="table-head px-2 py-1.5">Detail</th>
        </tr>
      </thead>
      <tbody className="font-mono text-2xs">
        {events.map((e, i) => {
          const run = eventRunId(e);
          return (
            <tr
              key={`${e.ts}-${i}`}
              className={cx("cursor-pointer hover:bg-raised/50", ui.selectedEvent === e && "bg-raised")}
              tabIndex={0}
              aria-selected={ui.selectedEvent === e}
              onClick={(ev) => {
                if ((ev.target as HTMLElement).closest("button")) return; // entity links handle themselves
                ui.selectEvent(e);
                ui.setInspectorOpen(true);
              }}
              onKeyDown={(ev) => {
                if (ev.key === "Enter") {
                  ui.selectEvent(e);
                  ui.setInspectorOpen(true);
                }
              }}
            >
              <td className="whitespace-nowrap border-b border-line px-3 py-1 text-faint">{formatDateTime(e.ts)}</td>
              <td className="border-b border-line px-2 py-1 text-ink">{e.kind}</td>
              <td className="border-b border-line px-2 py-1">
                {e.node_id ? (
                  <button className="text-live hover:underline" onClick={() => { ui.selectFile(null); ui.selectNode(e.node_id); ui.setInspectorOpen(true); }}>
                    {e.node_id}
                  </button>
                ) : (
                  <span className="text-faint">—</span>
                )}
              </td>
              <td className="border-b border-line px-2 py-1">
                {e.file_id ? (
                  <button className="text-live hover:underline" onClick={() => { ui.selectFile(e.file_id); ui.setInspectorOpen(true); }}>
                    {e.file_id.slice(0, 8)}
                  </button>
                ) : (
                  <span className="text-faint">—</span>
                )}
              </td>
              {!compact && (
                <td className="border-b border-line px-2 py-1 text-muted">
                  {e.chunk_index ?? "—"}/{e.shard_index ?? "—"}
                </td>
              )}
              <td className="max-w-[28rem] truncate border-b border-line px-2 py-1 text-muted" title={detailText(e)}>
                {run && (
                  <button className="mr-2 text-experiment hover:underline" onClick={() => { ui.selectRun(run); ui.setView("lab"); }}>
                    {run}
                  </button>
                )}
                {detailText(e)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default function EventsView() {
  const events = useEvents(true);
  const [kind, setKind] = useState("all");
  const q = useUi((s) => s.eventFilter);
  const setQ = useUi((s) => s.setEventFilter);
  const kinds = useMemo(() => [...new Set((events.data?.events ?? []).map((e) => e.kind))].sort(), [events.data]);
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (events.data?.events ?? []).filter(
      (e) =>
        (kind === "all" || e.kind === kind) &&
        (!t || [e.node_id, e.file_id, detailText(e)].some((v) => v?.toLowerCase().includes(t))),
    );
  }, [events.data, kind, q]);

  return (
    <div className="flex h-full min-h-0 flex-col rounded-md border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <h2 className="label">Event history</h2>
        <select className="input py-0.5 text-xs" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Filter by event kind">
          <option value="all">All kinds</option>
          {kinds.map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
        <input className="input w-56 py-0.5 text-xs" placeholder="Filter by node, file or detail" aria-label="Filter events" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="text-2xs text-faint">
          {rows.length} of {events.data?.events.length ?? 0} (latest 200, polled every 5 s)
        </span>
        <span className="ml-auto flex items-center gap-1">
          <button className="btn-ghost py-0.5" disabled={!rows.length} onClick={() => exportEvents(rows, "json")} title="Export the filtered rows loaded on this page">
            Export JSON
          </button>
          <button className="btn-ghost py-0.5" disabled={!rows.length} onClick={() => exportEvents(rows, "csv")} title="Export the filtered rows loaded on this page">
            Export CSV
          </button>
          <Freshness updatedAt={events.dataUpdatedAt} isError={events.isError} isFetching={events.isFetching} />
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {events.isLoading ? (
          <div className="p-3"><Loading /></div>
        ) : !events.data ? (
          <div className="p-3"><ErrorPanel error={events.error} onRetry={() => void events.refetch()} /></div>
        ) : rows.length === 0 ? (
          <div className="p-3"><Empty>No events match.</Empty></div>
        ) : (
          <EventRows events={rows} />
        )}
      </div>
    </div>
  );
}

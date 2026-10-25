import { Activity, Boxes, FileStack, FlaskConical, HardDrive, PanelRight, Search, ShieldCheck, Waves } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { apiTargetDescription, usesProxy } from "../../api/client";
import { useFiles, useHealth, useStatus } from "../../api/queries";
import { usePerf } from "../../api/scheduler";
import { formatTime } from "../../lib/format";
import { MODE_COPY, useMode, useUi, type Mode, type View } from "../../state/ui";
import { cx } from "../common/ui";

const NAV: { view: View; label: string; icon: ReactNode; key: string; g: string }[] = [
  { view: "cluster", label: "Cluster overview", icon: <Boxes className="h-[18px] w-[18px]" />, key: "1", g: "o" },
  { view: "files", label: "Storage Explorer", icon: <FileStack className="h-[18px] w-[18px]" />, key: "2", g: "e" },
  { view: "twin", label: "Survival Twin", icon: <Waves className="h-[18px] w-[18px]" />, key: "3", g: "s" },
  { view: "lab", label: "Lab · Recovery · Proof", icon: <FlaskConical className="h-[18px] w-[18px]" />, key: "4", g: "l" },
  { view: "integrity", label: "Integrity & Repair", icon: <ShieldCheck className="h-[18px] w-[18px]" />, key: "5", g: "i" },
  { view: "events", label: "Event History", icon: <Activity className="h-[18px] w-[18px]" />, key: "6", g: "v" },
];

/** g-prefixed navigation (spec 9). t = topology (the cluster stage), r = recovery (scenario lab). */
export const G_KEYS: Record<string, View> = { o: "cluster", t: "cluster", e: "files", s: "twin", l: "lab", r: "lab", i: "integrity", v: "events" };

export const NAV_ITEMS = NAV;

export function NavRail() {
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const [pinned, setPinned] = useState(false);
  // 56 px rail; expands to labels (max 200 px) on hover or focus, or stays open when pinned (spec 4.1).
  const reveal = pinned ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100";
  return (
    <nav aria-label="Primary" className={cx("relative z-50 shrink-0", pinned ? "w-[200px]" : "w-14")}>
      <div
        className={cx(
          "group absolute inset-y-0 left-0 flex flex-col gap-1 overflow-hidden border-r border-line bg-surface py-2 transition-[width] duration-150",
          pinned ? "w-[200px]" : "w-14 hover:w-[200px] hover:shadow-2xl focus-within:w-[200px] focus-within:shadow-2xl",
        )}
      >
        <div className="mb-2 flex h-8 items-center gap-3 px-4" title="SONARK · PREDICT. BREAK. PROVE.">
          <svg viewBox="0 0 32 32" className="h-6 w-6 shrink-0" aria-hidden>
            <circle cx="16" cy="16" r="12" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-live" />
            <circle cx="16" cy="16" r="3.5" className="fill-live" />
          </svg>
          <span className={cx("whitespace-nowrap font-mono text-[10px] text-muted", reveal)}>PREDICT. BREAK. PROVE.</span>
        </div>
        {NAV.map((n) => (
          <button
            key={n.view}
            onClick={() => setView(n.view)}
            aria-current={view === n.view ? "page" : undefined}
            aria-label={n.label}
            title={`${n.label}  (g ${n.g} · Alt+${n.key})`}
            className={cx(
              "relative mx-2 flex h-10 shrink-0 items-center gap-3 rounded px-[11px] transition-colors",
              view === n.view ? "bg-raised text-live" : "text-muted hover:bg-raised/60 hover:text-ink",
            )}
          >
            {view === n.view && <span className="absolute -left-2 h-5 w-0.5 rounded bg-live" aria-hidden />}
            <span className="shrink-0">{n.icon}</span>
            <span className={cx("whitespace-nowrap text-sm", reveal)}>{n.label}</span>
          </button>
        ))}
        <button className={cx("mx-2 mt-auto flex h-8 items-center rounded px-[11px] text-2xs text-faint hover:text-ink", reveal)} onClick={() => setPinned(!pinned)} aria-pressed={pinned}>
          {pinned ? "Unpin labels" : "Pin labels"}
        </button>
      </div>
    </nav>
  );
}

/** Non-modal shortcut sheet (modals are reserved for disruptive confirmations). */
export function ShortcutSheet() {
  const open = useUi((s) => s.shortcutsOpen);
  const set = useUi((s) => s.setShortcutsOpen);
  if (!open) return null;
  const rows: [string, string][] = [
    ["/", "Search files, IDs, hashes, nodes"],
    ["g o / g t", "Cluster overview / topology"],
    ["g e", "Storage Explorer"],
    ["g s", "Survival Twin"],
    ["g l / g r", "Scenario Lab, recovery timeline and proof"],
    ["g i", "Integrity & Repair"],
    ["g v", "Event History"],
    ["Alt+1-6", "Same views by position"],
    ["F", "Focus the camera on the selected node"],
    ["Esc", "Close this sheet, leave kiosk, or clear the selection"],
    ["?", "Toggle this sheet"],
  ];
  return (
    <div role="dialog" aria-modal="false" aria-label="Keyboard shortcuts" className="fixed bottom-12 right-4 z-50 w-80 rounded-md border border-line-strong bg-surface p-3 shadow-2xl">
      <div className="mb-2 flex items-center">
        <span className="label">Keyboard shortcuts</span>
        <button className="btn-ghost ml-auto py-0.5" onClick={() => set(false)}>
          Close
        </button>
      </div>
      <dl className="space-y-1 text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[6.5rem_1fr] gap-2">
            <dt>
              <kbd className="rounded-sm border border-line-strong px-1 font-mono text-2xs">{k}</kbd>
            </dt>
            <dd className="text-muted">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function TopBar() {
  const mode = useMode();
  const exp = useUi((s) => s.experiment);
  const health = useHealth();
  const hypo = useUi((s) => s.hypothetical);
  const setHypothetical = useUi((s) => s.setHypothetical);
  const setExperiment = useUi((s) => s.setExperiment);
  // Measured time of the last /api/status response; >1.5 s usually means a node is down.
  const statusMs = usePerf((s) => s.latency["GET /api/status"]);
  const slowMs = statusMs && statusMs > 1500 ? statusMs : null;

  let conn: ReactNode;
  if (exp.phase === "running") {
    conn = <Pill tone="experiment" label="API busy · experiment running" title="Polling is paused while the API runs the scenario" />;
  } else if (health.isError) {
    conn = (
      <Pill
        tone="lost"
        label={`Unreachable${health.dataUpdatedAt ? ` · last OK ${formatTime(health.dataUpdatedAt)}` : ""}`}
        title={`${apiTargetDescription()} did not answer`}
      />
    );
  } else if (health.data) {
    conn = (
      <Pill
        tone={slowMs ? "experiment" : "live"}
        label={`Reachable · ${slowMs ? `slow: status ${(slowMs / 1000).toFixed(1)} s` : "polling"} · ${formatTime(health.dataUpdatedAt)}${health.data.read_only ? " · read-only" : ""}${health.data.node_control ? "" : " · no node control"}`}
        title={`API ${health.data.version} at ${apiTargetDescription()}. No event stream exists, so the UI polls; the time is the last successful poll.`}
      />
    );
  } else {
    conn = <Pill tone="muted" label="Connecting…" title={apiTargetDescription()} />;
  }

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-3">
      <div className="flex items-baseline gap-2" title="SONARK · PREDICT. BREAK. PROVE.">
        <span className="font-mono text-sm font-semibold tracking-[0.25em] text-ink">SONARK</span>
      </div>
      <GlobalSearch />
      <div className="ml-auto flex min-w-0 items-center gap-2">
        {conn}
        <UtcClock />
        <ModeIndicator mode={mode} />
        {mode === "PREVIEW" && (
          <button className="btn-ghost whitespace-nowrap" onClick={() => setHypothetical([])} title={`Clear hypothetical failure of ${hypo.join(", ")}`}>
            Back to LIVE
          </button>
        )}
        {mode === "EXPERIMENT" && exp.phase !== "running" && (
          <button className="btn-ghost whitespace-nowrap" onClick={() => setExperiment({ phase: "idle" })}>
            Back to LIVE
          </button>
        )}
        <InspectorToggle />
      </div>
    </header>
  );
}

function Pill({ tone, label, title }: { tone: "live" | "lost" | "experiment" | "muted"; label: string; title?: string }) {
  const short = label.split(" · ")[0];
  const cls = {
    live: "border-live/40 text-live",
    lost: "border-lost/60 text-lost",
    experiment: "border-experiment/60 text-experiment",
    muted: "border-line text-muted",
  }[tone];
  return (
    <span role="status" title={title} className={cx("chip min-w-0 max-w-[45vw] gap-1.5 truncate py-0.5", cls)}>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden />
      <span className="truncate md:hidden">{short}</span>
      <span className="hidden truncate md:inline">{label}</span>
    </span>
  );
}

export function ModeIndicator({ mode }: { mode: Mode }) {
  const copy = useModeCopy(mode);
  const cls =
    mode === "PREVIEW"
      ? "border-dashed border-preview text-preview bg-preview/10"
      : mode === "EXPERIMENT"
        ? "border-experiment text-experiment bg-experiment/10"
        : "border-live/60 text-live";
  return (
    <span className={cx("rounded-sm border px-2 py-0.5 font-mono text-2xs font-semibold tracking-[0.18em]", cls)} title={copy} aria-label={`Mode: ${mode}. ${copy}`}>
      {mode}
    </span>
  );
}

/** Exact mode copy; a run with no report cannot claim either way. */
export function useModeCopy(mode: Mode): string {
  const exp = useUi((s) => s.experiment);
  if (exp.phase === "failed" && exp.modified === null) return "ACTUAL — OUTCOME UNKNOWN, NODES MAY HAVE BEEN STOPPED";
  return MODE_COPY[mode];
}

/** Wall clock in UTC, matching every timestamp in the UI. */
function UtcClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="hidden whitespace-nowrap font-mono text-2xs text-muted xl:inline" aria-label="Current time, UTC">
      {now.toISOString().slice(11, 19)} UTC
    </span>
  );
}

function InspectorToggle() {
  const open = useUi((s) => s.inspectorOpen);
  const set = useUi((s) => s.setInspectorOpen);
  return (
    <button
      className={cx("icon-btn", open && "bg-raised text-ink")}
      aria-pressed={open}
      aria-label={open ? "Close inspector" : "Open inspector"}
      title={open ? "Close inspector" : "Open inspector"}
      onClick={() => set(!open)}
    >
      <PanelRight className="h-4 w-4" />
    </button>
  );
}

function GlobalSearch() {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const files = useFiles();
  const status = useStatus();
  const ui = useUi();
  const input = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return [];
    const out: { kind: "file" | "node"; id: string; label: string; sub: string }[] = [];
    for (const n of status.data?.nodes ?? [])
      if (n.node_id.toLowerCase().includes(term)) out.push({ kind: "node", id: n.node_id, label: n.node_id, sub: n.up ? "node · up" : "node · down" });
    for (const f of files.data?.files ?? [])
      if (f.name.toLowerCase().includes(term) || f.file_id.startsWith(term) || (f.sha256 ?? "").startsWith(term))
        out.push({ kind: "file", id: f.file_id, label: f.name, sub: `file · ${f.file_id.slice(0, 8)}` });
    return out.slice(0, 12);
  }, [q, files.data, status.data]);

  const choose = (r: (typeof results)[number]) => {
    if (r.kind === "node") {
      ui.selectNode(r.id);
      if (ui.view !== "twin") ui.setView("cluster");
    } else {
      ui.selectFile(r.id);
      if (ui.view !== "twin" && ui.view !== "files") ui.setView("cluster");
    }
    ui.setInspectorOpen(true);
    setQ("");
    setOpen(false);
    input.current?.blur();
  };

  return (
    <div className="relative ml-4 w-full max-w-sm" role="combobox" aria-expanded={open && results.length > 0} aria-haspopup="listbox">
      <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" aria-hidden />
      <input
        ref={input}
        className="input w-full py-1 pl-7 text-xs"
        placeholder="Search files, file IDs, SHA-256 prefix, nodes   ( / )"
        aria-label="Search files and nodes"
        aria-controls="search-results"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, results.length - 1));
          else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
          else if (e.key === "Enter" && results[active]) choose(results[active]);
          else if (e.key === "Escape") {
            setQ("");
            input.current?.blur();
          }
        }}
        data-global-search
      />
      {open && q && (
        <ul id="search-results" role="listbox" className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded border border-line-strong bg-surface shadow-xl">
          {results.length === 0 && <li className="px-3 py-2 text-xs text-faint">No matching files or nodes</li>}
          {results.map((r, i) => (
            <li
              key={`${r.kind}:${r.id}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(r);
              }}
              className={cx("flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs", i === active && "bg-raised")}
            >
              {r.kind === "node" ? <HardDrive className="h-3.5 w-3.5 text-muted" /> : <FileStack className="h-3.5 w-3.5 text-muted" />}
              <span className="truncate text-ink">{r.label}</span>
              <span className="ml-auto shrink-0 font-mono text-2xs text-faint">{r.sub}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Persistent notice when the API stopped answering; cached data is labelled stale. */
export function DisconnectedBanner() {
  const health = useHealth();
  const running = useUi((s) => s.experiment.phase === "running");
  if (!health.isError || running) return null;
  return (
    <div role="alert" className="flex items-center gap-2 border-b border-lost/40 bg-lost/10 px-4 py-1.5 text-xs text-lost">
      <span className="font-semibold">API unreachable at {apiTargetDescription()}.</span>
      <span className="text-muted">
        {health.dataUpdatedAt
          ? `Everything shown is cached from ${formatTime(health.dataUpdatedAt)} or earlier and may be out of date.`
          : "No data has been received yet."}{" "}
        {usesProxy() ? (
          <>
            Start the backend: <code className="font-mono">python -m sonark --cluster sonark-cluster/cluster.json serve --manage --port 8800</code>
          </>
        ) : (
          <>
            Start the backend with <code className="font-mono">serve --manage --cors-origin {window.location.origin}</code>.
          </>
        )}
      </span>
    </div>
  );
}

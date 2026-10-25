import { ArrowDown, ArrowUp, Upload } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { api } from "../api/endpoints";
import { useFiles, useInvalidateCluster } from "../api/queries";
import type { FileListItem, FileStatus, FileSummary } from "../api/schemas";
import { formatBytes, formatDateTime, formatTolerance } from "../lib/format";
import { fileStatusMeta } from "../lib/status";
import { useUi } from "../state/ui";
import { Empty, ErrorPanel, FileStatusBadge, Freshness, Loading, Panel, cx } from "../components/common/ui";

type SortKey = "name" | "size" | "status" | "fault_tolerance" | "created_at" | "coding";
const NAME_RE = /^[^\x00-\x1f\x7f/\\]{1,255}$/; // same rule as sonark/api.py NAME_RE

export default function FilesView() {
  const files = useFiles();
  const ui = useUi();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<FileStatus | "all">("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "created_at", dir: -1 });

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    let out = (files.data?.files ?? []).filter(
      (f) =>
        (status === "all" || f.status === status) &&
        (!term || f.name.toLowerCase().includes(term) || f.file_id.startsWith(term) || (f.sha256 ?? "").startsWith(term)),
    );
    const val = (f: FileListItem): string | number => {
      switch (sort.key) {
        case "status":
          return f.status ? fileStatusMeta[f.status].rank : 9;
        case "fault_tolerance":
          return f.fault_tolerance ?? -1;
        case "coding":
          return f.k * 100 + f.m;
        default:
          return f[sort.key];
      }
    };
    out = [...out].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
    return out;
  }, [files.data, q, status, sort]);

  const head = (key: SortKey, label: string, cls = "") => (
    <th className={cx("table-head px-3 py-2", cls)} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button
        className="inline-flex items-center gap-1 uppercase hover:text-ink"
        onClick={() => setSort((s) => ({ key, dir: s.key === key ? ((-s.dir) as 1 | -1) : 1 }))}
      >
        {label}
        {sort.key === key && (sort.dir === 1 ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
      </button>
    </th>
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <UploadBox />
      <div className="flex min-h-0 flex-1 flex-col rounded-md border border-line bg-surface">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
          <h2 className="label">Storage Explorer</h2>
          <input className="input w-56 py-0.5 text-xs" placeholder="Filter by name, ID or SHA-256 prefix" aria-label="Filter files" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="input py-0.5 text-xs" aria-label="Filter by protection state" value={status} onChange={(e) => setStatus(e.target.value as FileStatus | "all")}>
            <option value="all">All states</option>
            {(["lost", "at_risk", "degraded", "healthy"] as const).map((s) => (
              <option key={s} value={s}>
                {fileStatusMeta[s].label}
              </option>
            ))}
          </select>
          <span className="text-2xs text-faint">
            {rows.length} of {files.data?.files.length ?? 0}
          </span>
          <span className="ml-auto">
            <Freshness updatedAt={files.dataUpdatedAt} isError={files.isError} isFetching={files.isFetching} />
          </span>
        </div>
        {files.isLoading ? (
          <div className="p-3"><Loading label="Loading file inventory" /></div>
        ) : !files.data ? (
          <div className="p-3"><ErrorPanel error={files.error} onRetry={() => void files.refetch()} /></div>
        ) : files.data.files.length === 0 ? (
          <div className="p-3"><Empty>No files stored yet. Upload one above.</Empty></div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full border-separate border-spacing-0 text-sm">
              <thead>
                <tr>
                  {head("name", "Name")}
                  <th className="table-head px-3 py-2">File ID</th>
                  {head("size", "Size", "text-right")}
                  {head("coding", "Coding")}
                  {head("status", "Protection")}
                  {head("fault_tolerance", "Tolerance", "text-right")}
                  <th className="table-head px-3 py-2">Integrity</th>
                  {head("created_at", "Created")}
                </tr>
              </thead>
              <tbody>
                {rows.map((f) => (
                  <tr
                    key={f.file_id}
                    tabIndex={0}
                    aria-selected={ui.selectedFile === f.file_id}
                    className={cx("row-hover", ui.selectedFile === f.file_id && "bg-raised")}
                    onClick={() => {
                      ui.selectFile(f.file_id);
                      ui.setInspectorOpen(true);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        ui.selectFile(f.file_id);
                        ui.setInspectorOpen(true);
                      }
                    }}
                  >
                    <td className="max-w-[16rem] truncate border-b border-line px-3 py-1.5">{f.name}</td>
                    <td className="border-b border-line px-3 py-1.5 font-mono text-2xs text-muted">{f.file_id.slice(0, 12)}</td>
                    <td className="border-b border-line px-3 py-1.5 text-right font-mono text-xs">{formatBytes(f.size)}</td>
                    <td className="border-b border-line px-3 py-1.5 font-mono text-xs">{f.k}+{f.m} × {f.chunk_count}</td>
                    <td className="border-b border-line px-3 py-1.5"><FileStatusBadge status={f.status} /></td>
                    <td className="border-b border-line px-3 py-1.5 text-right font-mono text-xs">{formatTolerance(f.fault_tolerance, true)}</td>
                    <td className="border-b border-line px-3 py-1.5 text-2xs text-faint" title="/api/files checks node health only. Open the file to verify shard hashes.">
                      not verified in list
                    </td>
                    <td className="border-b border-line px-3 py-1.5 text-2xs text-muted">{formatDateTime(f.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

type UploadState =
  | { phase: "idle" }
  | { phase: "sending"; name: string; sent: number; total: number }
  | { phase: "done"; file: FileSummary }
  | { phase: "error"; name: string; error: unknown };

function UploadBox() {
  const [st, setSt] = useState<UploadState>({ phase: "idle" });
  const [drag, setDrag] = useState(false);
  const [nameErr, setNameErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const invalidate = useInvalidateCluster();
  const ui = useUi();

  const start = (file: File) => {
    if (!NAME_RE.test(file.name)) {
      setNameErr("File names must be 1–255 characters with no slashes or control characters.");
      return;
    }
    setNameErr(null);
    abort.current = new AbortController();
    setSt({ phase: "sending", name: file.name, sent: 0, total: file.size });
    api
      .upload(file.name, file, (sent, total) => setSt({ phase: "sending", name: file.name, sent, total }), abort.current.signal)
      .then(
        (f) => {
          setSt({ phase: "done", file: f });
          void invalidate();
        },
        (error) => setSt({ phase: "error", name: file.name, error }),
      );
  };

  return (
    <Panel title="Upload" bodyClass="p-2">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          const f = e.dataTransfer.files[0];
          if (f && st.phase !== "sending") start(f);
        }}
        className={cx("flex flex-wrap items-center gap-3 rounded border border-dashed px-3 py-2 text-sm", drag ? "border-live bg-live/5" : "border-line")}
      >
        <button className="btn-primary" onClick={() => input.current?.click()} disabled={st.phase === "sending"}>
          <Upload className="h-3.5 w-3.5" /> Choose file
        </button>
        <span className="text-muted">or drop a file here. Bytes go to <code className="font-mono text-2xs">PUT /api/files</code>.</span>
        <input
          ref={input}
          type="file"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) start(f);
            e.target.value = "";
          }}
        />
        {st.phase === "sending" && (
          <div className="flex min-w-[16rem] flex-1 items-center gap-2" role="status">
            <div className="h-1.5 flex-1 overflow-hidden rounded bg-bg">
              <div className="h-full bg-live transition-[width]" style={{ width: `${st.total ? (100 * st.sent) / st.total : 0}%` }} />
            </div>
            <span className="font-mono text-2xs text-muted">
              {formatBytes(st.sent)} / {formatBytes(st.total)} sent
            </span>
            <button className="btn-ghost py-0.5" onClick={() => abort.current?.abort()}>
              Cancel
            </button>
          </div>
        )}
        {st.phase === "sending" && st.sent >= st.total && <span className="text-2xs text-faint">All bytes sent; waiting for the server to encode and store them…</span>}
        {st.phase === "done" && (
          <span className="text-sm">
            <span className="text-healthy">Stored (201)</span> {st.file.name}: {st.file.k}+{st.file.m}, {st.file.chunk_count} stripe(s).{" "}
            <span className="text-faint">Protection not verified yet.</span>{" "}
            <button className="text-live underline-offset-2 hover:underline" onClick={() => ui.selectFile(st.file.file_id)}>
              Open and verify
            </button>
          </span>
        )}
      </div>
      {nameErr && <p className="mt-1 text-2xs text-lost">{nameErr}</p>}
      {st.phase === "error" && (
        <div className="mt-2">
          <ErrorPanel compact error={st.error} />
        </div>
      )}
    </Panel>
  );
}

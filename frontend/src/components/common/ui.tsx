import { AlertTriangle, Check, Copy, Loader2, WifiOff } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ApiRequestError, ApiUnreachableError, SchemaError, describeError } from "../../api/client";
import type { FileStatus, ShardStatus } from "../../api/schemas";
import { formatTime } from "../../lib/format";
import { fileStatusMeta, shardStatusMeta } from "../../lib/status";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function Panel({
  title,
  actions,
  children,
  className,
  bodyClass,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClass?: string;
}) {
  return (
    <section className={cx("rounded-md border border-line bg-surface", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
          <h2 className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted">{title}</h2>
          <div className="flex items-center gap-1">{actions}</div>
        </header>
      )}
      <div className={cx("p-3", bodyClass)}>{children}</div>
    </section>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 py-4 text-sm text-muted">
      <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
      {label}…
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-4 text-sm text-faint">{children}</div>;
}

/** Shows any API error with its code, plus the raw body for debugging. */
export function ErrorPanel({ error, onRetry, compact }: { error: unknown; onRetry?: () => void; compact?: boolean }) {
  const { title, message } = describeError(error);
  const raw =
    error instanceof SchemaError || error instanceof ApiRequestError ? (error as { raw: unknown }).raw : undefined;
  const Icon = error instanceof ApiUnreachableError ? WifiOff : AlertTriangle;
  return (
    <div role="alert" className={cx("rounded border border-lost/40 bg-lost/5 text-sm", compact ? "p-2" : "p-3")}>
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-lost" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-ink">{title}</div>
          <div className="break-words text-muted">{message}</div>
          {error instanceof SchemaError && (
            <ul className="mt-1 list-disc pl-4 font-mono text-2xs text-muted">
              {error.issues.slice(0, 8).map((i, n) => (
                <li key={n}>
                  {i.path.join(".") || "(root)"}: {i.message}
                </li>
              ))}
            </ul>
          )}
          {raw !== undefined && (
            <details className="mt-2">
              <summary className="cursor-pointer text-2xs text-faint">Raw response</summary>
              <pre className="mt-1 max-h-48 overflow-auto rounded bg-bg p-2 font-mono text-2xs text-muted">
                {JSON.stringify(raw, null, 2)}
              </pre>
            </details>
          )}
        </div>
        {onRetry && (
          <button className="btn-ghost text-2xs" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    </div>
  );
}

/** Marks data as stale when the last refetch failed but cached data is shown. */
export function Freshness({
  updatedAt,
  isError,
  isFetching,
}: {
  updatedAt: number;
  isError: boolean;
  isFetching?: boolean;
}) {
  if (!updatedAt) return null;
  if (isError)
    return (
      <span className="chip border-degraded/50 text-degraded" title="The last refresh failed; this is cached data">
        STALE · {formatTime(updatedAt)}
      </span>
    );
  return (
    <span className="font-mono text-2xs text-faint" title="Time of the last successful response">
      {isFetching ? "refreshing…" : formatTime(updatedAt)}
    </span>
  );
}

export function FileStatusBadge({ status }: { status: FileStatus | null | undefined }) {
  if (!status) return <span className="chip text-faint">unknown</span>;
  const m = fileStatusMeta[status];
  return (
    <span className="chip" style={{ borderColor: `${m.color}66`, color: m.color }} title={m.help}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: m.color }} aria-hidden />
      {m.label}
    </span>
  );
}

export function ShardChip({ status, hypothetical }: { status: ShardStatus; hypothetical?: boolean }) {
  const m = shardStatusMeta[status];
  return (
    <span
      className={cx("chip", hypothetical && "border-dashed")}
      style={{ borderColor: hypothetical ? undefined : `${m.color}66`, color: hypothetical ? undefined : m.color }}
    >
      {m.glyph} {status}
    </span>
  );
}

export function Hash({ value, label }: { value: string | null | undefined; label?: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="font-mono text-2xs text-faint">— not available</span>;
  return (
    <span className="group inline-flex max-w-full items-start gap-1">
      <code className="break-all font-mono text-2xs leading-4 text-ink" aria-label={label}>
        {value}
      </code>
      <button
        className="shrink-0 rounded p-0.5 text-faint hover:text-ink"
        aria-label={`Copy ${label ?? "hash"}`}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </button>
    </span>
  );
}

export function KV({ k, children, mono }: { k: ReactNode; children: ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-3 py-0.5 text-sm">
      <dt className="text-muted">{k}</dt>
      <dd className={cx("min-w-0 break-words text-ink", mono && "font-mono text-xs")}>{children}</dd>
    </div>
  );
}

/** Tri-state outcome cell: true / false / not available, with a reason. */
export function Outcome({ value, yes = "Yes", no = "No", why }: { value: boolean | null | undefined; yes?: string; no?: string; why?: string }) {
  if (value === null || value === undefined)
    return (
      <span className="text-faint" title={why}>
        — {why && <span className="text-2xs">({why})</span>}
      </span>
    );
  return value ? <span className="text-healthy">✓ {yes}</span> : <span className="text-lost">✕ {no}</span>;
}

/**
 * Modal confirmation for disruptive actions. When `phrase` is set the user
 * must type it exactly before the action is enabled.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  phrase,
  confirmLabel,
  danger = true,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  phrase?: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const inputId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setTyped("");
      if (typeof d.showModal === "function") d.showModal();
      else d.setAttribute("open", "");
    } else if (!open && d.open) {
      if (typeof d.close === "function") d.close();
      else d.removeAttribute("open");
    }
  }, [open]);
  const ok = !phrase || typed.trim() === phrase;
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
      className="w-[min(36rem,calc(100vw-2rem))] rounded-lg border border-line-strong bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/60"
      aria-labelledby={`${inputId}-title`}
    >
      {open && (
        <form
          method="dialog"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok && !busy) onConfirm();
          }}
        >
          <div className="border-b border-line px-4 py-3">
            <h2 id={`${inputId}-title`} className="text-base font-semibold">
              {title}
            </h2>
          </div>
          <div className="max-h-[60vh] space-y-3 overflow-auto px-4 py-3 text-sm">
            {children}
            {phrase && (
              <div>
                <label htmlFor={inputId} className="block text-muted">
                  Type <code className="rounded bg-bg px-1 font-mono text-ink">{phrase}</code> to confirm
                </label>
                <input
                  id={inputId}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  className="input mt-1 w-full font-mono"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  disabled={busy}
                />
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
            <button type="button" className="btn-ghost" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className={danger ? "btn-danger" : "btn-primary"} disabled={!ok || busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />}
              {confirmLabel}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded border border-line bg-bg p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cx(
            "rounded-sm px-2 py-0.5 text-2xs font-medium",
            value === o.value ? "bg-raised text-ink" : "text-muted hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

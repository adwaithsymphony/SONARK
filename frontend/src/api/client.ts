/**
 * The only module that talks HTTP to the Sonark API.
 * Every JSON response is validated with Zod; failures surface as typed errors
 * that keep the raw body for debugging.
 */
import type { z } from "zod";
import { latencyKey, scheduler, usePerf, type Priority } from "./scheduler";
import { apiErrorBody } from "./schemas";

const DEFAULT_BASE = "http://127.0.0.1:8800";

export function apiBase(): string {
  const raw = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim();
  return (raw && raw.length > 0 ? raw : DEFAULT_BASE).replace(/\/+$/, "");
}

/** The server could not be reached at all (refused, DNS, CORS-blocked, offline). */
export class ApiUnreachableError extends Error {
  override readonly name = "ApiUnreachableError";
  constructor(
    readonly url: string,
    readonly reason?: unknown,
  ) {
    super(
      `Cannot reach the Sonark API at ${url}. Is \`sonark serve\` running, and was it started with --cors-origin for this page's origin?`,
    );
  }
}

/** The server answered with a non-2xx status and (usually) an error envelope. */
export class ApiRequestError extends Error {
  override readonly name = "ApiRequestError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown>,
    readonly raw: unknown,
  ) {
    super(message);
  }
  get expectedConfirm(): string | undefined {
    const v = this.details["expected_confirm"];
    return typeof v === "string" ? v : undefined;
  }
}

/** The server answered 2xx but the body did not match the expected schema. */
export class SchemaError extends Error {
  override readonly name = "SchemaError";
  constructor(
    readonly endpoint: string,
    readonly issues: z.ZodIssue[],
    readonly raw: unknown,
  ) {
    super(`Unexpected response shape from ${endpoint} (${issues.length} issue(s)).`);
  }
}

export type AnyApiError = ApiUnreachableError | ApiRequestError | SchemaError;

export function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

interface RequestOpts {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  json?: unknown;
  signal?: AbortSignal | undefined;
  /** see scheduler.ts; defaults to "background" */
  priority?: Priority;
}

async function send(path: string, opts: RequestOpts): Promise<Response> {
  const url = apiBase() + path;
  const method = opts.method ?? "GET";
  const init: RequestInit = { method, signal: opts.signal ?? null };
  if (opts.json !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.json);
  }
  return scheduler.run(
    opts.priority ?? "background",
    async () => {
      const t0 = performance.now();
      try {
        const resp = await fetch(url, init);
        usePerf.getState().record(latencyKey(method, path), performance.now() - t0);
        return resp;
      } catch (e) {
        if (isAbort(e)) throw e;
        throw new ApiUnreachableError(apiBase(), e);
      }
    },
    opts.signal,
  );
}

async function readBody(resp: Response): Promise<unknown> {
  const text = await resp.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function errorFromBody(status: number, body: unknown): ApiRequestError {
  const parsed = apiErrorBody.safeParse(body);
  if (parsed.success) {
    const { code, message, details } = parsed.data.error;
    return new ApiRequestError(status, code, message, details, body);
  }
  return new ApiRequestError(status, "http_error", `HTTP ${status}`, {}, body);
}

/** Request a JSON endpoint and validate `{data: ...}` against `schema`. */
export async function requestJson<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  opts: RequestOpts = {},
): Promise<z.infer<S>> {
  const resp = await send(path, opts);
  const body = await readBody(resp);
  if (!resp.ok) throw errorFromBody(resp.status, body);
  const data = (body as { data?: unknown } | null)?.data;
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new SchemaError(`${opts.method ?? "GET"} ${path}`, parsed.error.issues, body);
  return parsed.data;
}

/** Download raw bytes (not JSON-enveloped) plus the integrity headers. */
export interface Download {
  bytes: ArrayBuffer;
  filename: string;
  sha256Header: string | null;
  degraded: boolean | null;
  reconstructedChunks: number | null;
}

export async function requestBytes(path: string, signal?: AbortSignal): Promise<Download> {
  const resp = await send(path, { signal, priority: "user" });
  if (!resp.ok) throw errorFromBody(resp.status, await readBody(resp));
  const disp = resp.headers.get("Content-Disposition") ?? "";
  const filename = /filename="([^"]+)"/.exec(disp)?.[1] ?? "download.bin";
  const degraded = resp.headers.get("X-Sonark-Degraded");
  const recon = resp.headers.get("X-Sonark-Reconstructed-Chunks");
  return {
    bytes: await resp.arrayBuffer(),
    filename,
    sha256Header: resp.headers.get("X-Sonark-SHA256"),
    degraded: degraded === null ? null : degraded === "true",
    reconstructedChunks: recon === null ? null : Number(recon),
  };
}

/**
 * Upload raw bytes with PUT. Uses XMLHttpRequest because fetch cannot report
 * upload progress. Progress is bytes *sent*; it says nothing about storage.
 */
export function uploadBytes<S extends z.ZodTypeAny>(
  name: string,
  file: Blob,
  schema: S,
  onProgress?: (sent: number, total: number) => void,
  signal?: AbortSignal,
): Promise<z.infer<S>> {
  const url = `${apiBase()}/api/files?name=${encodeURIComponent(name)}`;
  return scheduler.run("user", () => xhrUpload(url, file, schema, onProgress, signal), signal);
}

function xhrUpload<S extends z.ZodTypeAny>(
  url: string,
  file: Blob,
  schema: S,
  onProgress?: (sent: number, total: number) => void,
  signal?: AbortSignal,
): Promise<z.infer<S>> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => onProgress?.(e.loaded, e.lengthComputable ? e.total : file.size);
    xhr.onerror = () => reject(new ApiUnreachableError(apiBase()));
    xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
    xhr.onload = () => {
      let body: unknown = xhr.responseText;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* keep text */
      }
      if (xhr.status < 200 || xhr.status >= 300) return reject(errorFromBody(xhr.status, body));
      const parsed = schema.safeParse((body as { data?: unknown } | null)?.data);
      if (!parsed.success) return reject(new SchemaError("PUT /api/files", parsed.error.issues, body));
      resolve(parsed.data);
    };
    signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(file);
  });
}

/** Human description for any error thrown by this module. */
export function describeError(e: unknown): { title: string; message: string } {
  if (e instanceof ApiUnreachableError) return { title: "API unreachable", message: e.message };
  if (e instanceof SchemaError) return { title: "Unexpected response", message: e.message };
  if (e instanceof ApiRequestError) {
    const titles: Record<number, string> = {
      400: "Rejected by validation",
      403: "Forbidden",
      404: "Not found",
      409: "Conflict",
      411: "Length required",
      413: "Too large",
      415: "Wrong content type",
      428: "Confirmation required",
      503: e.code === "busy" ? "Server busy" : "Unavailable",
    };
    return { title: `${titles[e.status] ?? "Request failed"} (${e.status} ${e.code})`, message: e.message };
  }
  if (e instanceof Error) return { title: "Error", message: e.message };
  return { title: "Error", message: String(e) };
}

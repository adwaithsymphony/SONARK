/** One typed function per backend route. See API_MAPPING.md. */
import { requestBytes, requestJson, uploadBytes } from "./client";
import * as s from "./schemas";

const enc = encodeURIComponent;
type Sig = AbortSignal | undefined;

export const api = {
  health: (signal?: Sig) => requestJson("/api/health", s.health, { signal, priority: "free" }),
  status: (signal?: Sig) => requestJson("/api/status", s.clusterStatus, { signal }),
  files: (signal?: Sig) => requestJson("/api/files", s.fileList, { signal }),
  fileDetail: (ref: string, verify: boolean, signal?: Sig) =>
    requestJson(`/api/files/${enc(ref)}?verify=${verify}`, s.fileDetail, { signal, priority: "user" }),
  download: (ref: string, signal?: Sig) => requestBytes(`/api/files/${enc(ref)}/content`, signal),
  upload: (name: string, file: Blob, onProgress?: (sent: number, total: number) => void, signal?: Sig) =>
    uploadBytes(name, file, s.fileSummary, onProgress, signal),
  deleteFile: (ref: string, confirmFileId: string) =>
    requestJson(`/api/files/${enc(ref)}?confirm=${enc(confirmFileId)}`, s.deleteResult, {
      method: "DELETE",
      priority: "user",
    }),
  twin: (opts: { verify: boolean; shards: boolean; maxSets?: number }, signal?: Sig) =>
    requestJson(
      `/api/twin?verify=${opts.verify}&shards=${opts.shards}&max_sets=${opts.maxSets ?? 50}`,
      s.twin,
      { signal },
    ),
  preview: (nodes: string[], signal?: Sig) =>
    requestJson("/api/scenarios/preview", s.scenarioPreview, {
      method: "POST",
      json: { nodes, verify: true },
      signal,
      priority: "user",
    }),
  execute: (nodes: string[], confirm: string, mode: "restart" | "replace") =>
    requestJson("/api/scenarios/execute", s.scenarioReport, {
      method: "POST",
      json: { nodes, confirm, mode },
      priority: "user",
    }),
  scenarios: (limit = 50, signal?: Sig) =>
    requestJson(`/api/scenarios?limit=${limit}`, s.scenarioList, { signal }),
  scenario: (runId: string, signal?: Sig) =>
    requestJson(`/api/scenarios/${enc(runId)}`, s.scenarioReport, { signal, priority: "user" }),
  scrub: () => requestJson("/api/scrub", s.scrubSummary, { method: "POST", json: {}, priority: "user" }),
  repair: () => requestJson("/api/repair", s.repairResult, { method: "POST", json: { confirm: true }, priority: "user" }),
  gc: () => requestJson("/api/gc", s.gcResult, { method: "POST", json: { confirm: true }, priority: "user" }),
  nodeStop: (node: string) =>
    requestJson(`/api/nodes/${enc(node)}/stop`, s.nodeControlResult, {
      method: "POST",
      json: { confirm: node },
      priority: "user",
    }),
  nodeStart: (node: string) =>
    requestJson(`/api/nodes/${enc(node)}/start`, s.nodeControlResult, { method: "POST", json: {}, priority: "user" }),
  events: (limit = 200, signal?: Sig) => requestJson(`/api/events?limit=${limit}`, s.eventList, { signal }),
};

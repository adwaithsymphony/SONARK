import { api } from "../api/endpoints";

export interface DownloadCheck {
  filename: string;
  bytes: number;
  sha256Browser: string | null; // computed here from the received bytes
  sha256Header: string | null; // X-Sonark-SHA256 (the stored file hash)
  sha256Expected: string | null; // from file metadata
  match: boolean | null;
  degraded: boolean | null;
  reconstructedChunks: number | null;
}

export async function sha256Hex(buf: ArrayBuffer): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null; // needs a secure context (localhost counts)
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Download real bytes, hash them in the browser, then hand them to the user. */
export async function downloadAndVerify(ref: string, expected: string | null, save = true, name?: string): Promise<DownloadCheck> {
  const d = await api.download(ref);
  // Content-Disposition is not CORS-exposed by the API, so prefer the known name.
  if (name && d.filename === "download.bin") d.filename = name;
  const actual = await sha256Hex(d.bytes);
  const reference = expected ?? d.sha256Header;
  if (save) {
    const url = URL.createObjectURL(new Blob([d.bytes], { type: "application/octet-stream" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = d.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  return {
    filename: d.filename,
    bytes: d.bytes.byteLength,
    sha256Browser: actual,
    sha256Header: d.sha256Header,
    sha256Expected: expected,
    match: actual && reference ? actual === reference : null,
    degraded: d.degraded,
    reconstructedChunks: d.reconstructedChunks,
  };
}

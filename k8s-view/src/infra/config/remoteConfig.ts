import { createHash } from "node:crypto";

/** Config files larger than this cannot be K8s View config. */
export const MAX_REMOTE_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 15_000;

export type FetchLike = (url: URL, init: RequestInit) => Promise<Response>;

/** Gist page (`https://gist.github.com/<user>/<id>`) → first file's raw content. */
export function normalizeRemoteUrl(url: string): string {
  const u = new URL(url);
  if (u.hostname === "gist.github.com" && /^\/[^/]+\/[0-9a-f]+\/?$/i.test(u.pathname)) {
    u.pathname = `${u.pathname.replace(/\/$/, "")}/raw`;
  }
  return u.toString();
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Fetch config files: HTTPS only (including redirects), reject URLs with usernames/passwords, enforce size and time limits.
 * Follow redirects manually to avoid ever sending an HTTP request.
 */
export async function downloadRemoteConfig(url: string, fetchImpl: FetchLike = fetch): Promise<string> {
  let current = new URL(normalizeRemoteUrl(url));
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== "https:") throw new Error(`only https URLs are allowed (got ${current.protocol}//)`);
    if (current.username || current.password) throw new Error("URLs with credentials are not allowed");
    const res = await fetchImpl(current, {
      redirect: "manual",
      signal,
      headers: { accept: "application/json, text/plain;q=0.9" },
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`HTTP ${res.status} without Location`);
      current = new URL(location, current);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return readLimited(res);
  }
  throw new Error("too many redirects");
}

async function readLimited(res: Response): Promise<string> {
  const length = Number(res.headers.get("content-length") ?? "0");
  if (length > MAX_REMOTE_BYTES) throw new Error(`file is larger than ${MAX_REMOTE_BYTES} bytes`);
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REMOTE_BYTES) {
      await reader.cancel();
      throw new Error(`file is larger than ${MAX_REMOTE_BYTES} bytes`);
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

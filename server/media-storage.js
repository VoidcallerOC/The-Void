import { createReadStream, promises as fs } from "node:fs";
import { extname, resolve, sep } from "node:path";

const CONTENT_TYPES = Object.freeze({ ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".flac": "audio/flac", ".mp4": "video/mp4", ".webm": "video/webm" });

function safeStorageKey(value) {
  const key = String(value || "").trim().replace(/^\/+/, "");
  if (!key || key.includes("\0") || key.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Protected media storage key is invalid.");
  return key;
}

function fileRange(rangeHeader, size) {
  if (!rangeHeader) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(rangeHeader).trim());
  if (!match) throw Object.assign(new Error("Requested media range is invalid."), { status: 416, code: "INVALID_MEDIA_RANGE" });
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) throw Object.assign(new Error("Requested media range is unsatisfiable."), { status: 416, code: "INVALID_MEDIA_RANGE" });
  return { start, end: Math.min(end, size - 1), partial: true };
}

function allowedSignedUrl(url, allowedHosts) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error("Object storage signer returned an invalid URL."); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !allowedHosts.includes(parsed.host.toLowerCase())) throw new Error("Object storage signer returned an unapproved URL.");
  return parsed.toString();
}

export class PrivateMediaStorage {
  constructor({ config, fetchImpl = fetch } = {}) {
    if (!config?.driver) throw new TypeError("PrivateMediaStorage requires media configuration.");
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async open({ storageKey, range = null, contentType = null }) {
    const key = safeStorageKey(storageKey);
    if (this.config.driver === "filesystem") {
      const root = resolve(this.config.privateRoot);
      const path = resolve(root, key);
      if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error("Protected media storage key escapes the private media root.");
      let stat;
      try { stat = await fs.stat(path); } catch { throw Object.assign(new Error("Protected media object was not found."), { status: 404, code: "MEDIA_OBJECT_NOT_FOUND" }); }
      if (!stat.isFile() || stat.size > this.config.maxBytes) throw Object.assign(new Error("Protected media object is unavailable."), { status: 404, code: "MEDIA_OBJECT_NOT_FOUND" });
      const selected = fileRange(range, stat.size);
      return { type: "stream", stream: createReadStream(path, { start: selected.start, end: selected.end }), contentType: contentType || CONTENT_TYPES[extname(path).toLowerCase()] || "application/octet-stream", contentLength: selected.end - selected.start + 1, totalLength: stat.size, start: selected.start, end: selected.end, partial: selected.partial };
    }
    const response = await this.fetchImpl(this.config.signerEndpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.config.signerToken}` }, body: JSON.stringify({ storageKey: key, expiresInSeconds: this.config.signedUrlTtlSeconds }) });
    if (!response.ok) throw new Error(`Object storage signer HTTP ${response.status}`);
    const payload = await response.json();
    return { type: "redirect", url: allowedSignedUrl(payload?.url, this.config.objectUrlHosts) };
  }
}

export function createPrivateMediaStorage(options) { return new PrivateMediaStorage(options); }

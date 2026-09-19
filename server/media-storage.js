import { createReadStream, promises as fs } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const CONTENT_TYPES = Object.freeze({ ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".flac": "audio/flac", ".mp4": "video/mp4", ".webm": "video/webm" });

function safeStorageKey(value) {
  const key = String(value || "").trim().replace(/^\/+/, "");
  if (!key || key.includes("\0") || key.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Invalid media key");
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

function allowedPrefix(key, prefixes) {
  return prefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}/`));
}

export class PrivateMediaStorage {
  constructor({ config, signer = null } = {}) {
    if (!config?.driver) throw new TypeError("PrivateMediaStorage requires media configuration.");
    this.config = config;
    this.signer = signer || (config.driver === "object" ? this.createR2Signer(config) : config.driver === "pinata" ? this.createPinataSigner(config) : null);
  }

  createR2Signer(config) {
    const client = new S3Client({ region: "auto", endpoint: config.r2.endpoint, credentials: { accessKeyId: config.r2.accessKeyId, secretAccessKey: config.r2.secretAccessKey } });
    return async (key) => getSignedUrl(client, new GetObjectCommand({ Bucket: config.r2.bucket, Key: key }), { expiresIn: config.signedUrlTtlSeconds });
  }

  createPinataSigner(config) {
    return async (cid) => {
      if (!/^(?:baf[a-z0-9]+|Qm[1-9A-HJ-NP-Za-km-z]+)$/.test(cid)) throw new Error("Pinata protected media reference must be a CID.");
      const date = Math.floor(Date.now() / 1000);
      const response = await fetch(config.pinata.endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.pinata.jwt}` }, body: JSON.stringify({ url: `${config.pinata.gateway}/files/${cid}`, expires: config.signedUrlTtlSeconds, date, method: "GET" }) });
      if (!response.ok) throw new Error(`Pinata private download-link HTTP ${response.status}`);
      const payload = await response.json();
      if (typeof payload?.data !== "string") throw new Error("Pinata private download-link response was invalid.");
      return payload.data;
    };
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
    if (this.config.driver === "object" && !allowedPrefix(key, this.config.protectedPrefixes)) throw new Error("Protected media storage key is outside the configured media prefixes.");
    let signedUrl;
    try { signedUrl = await this.signer(key); } catch (error) { throw new Error(`Object storage signing failed: ${error.message}`, { cause: error }); }
    return { type: "redirect", url: allowedSignedUrl(signedUrl, this.config.objectUrlHosts) };
  }
}

export function createPrivateMediaStorage(options) { return new PrivateMediaStorage(options); }

export function parseByteRange(header, size) {
  try {
    const selected = fileRange(header, size);
    return { start: selected.start, end: selected.end };
  } catch {
    return null;
  }
}

export function createPrivateMediaStore(options = {}) {
  if (options.root && !options.config) {
    const root = resolve(options.root);
    return {
      resolve(key) {
        const safe = safeStorageKey(key);
        const path = resolve(root, safe);
        if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error("Invalid media key");
        return path;
      }
    };
  }
  return createPrivateMediaStorage(options);
}

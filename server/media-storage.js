import { createReadStream, promises as fs } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
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

  async put({ body, filename = "upload.bin", contentType = "application/octet-stream" }) {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body || []);
    if (!bytes.length) throw Object.assign(new Error("Protected media upload was empty."), { status: 400, code: "MEDIA_UPLOAD_EMPTY" });
    if (bytes.length > this.config.maxBytes) throw Object.assign(new Error("Protected media upload is too large."), { status: 413, code: "MEDIA_UPLOAD_TOO_LARGE" });
    if (this.config.driver === "filesystem") {
      const extension = extname(String(filename || "")).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 8);
      const storageKey = `uploads/${randomUUID()}${CONTENT_TYPES[extension] ? extension : ""}`;
      const root = resolve(this.config.privateRoot);
      const path = resolve(root, storageKey);
      if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error("Protected media storage key escapes the private media root.");
      await fs.mkdir(resolve(path, ".."), { recursive: true });
      await fs.writeFile(path, bytes);
      return { storageKey };
    }
    if (this.config.driver === "pinata") {
      const form = new FormData();
      form.append("network", "private");
      form.append("file", new Blob([bytes], { type: contentType || "application/octet-stream" }), String(filename || "upload.bin"));
      const response = await fetch("https://uploads.pinata.cloud/v3/files", { method: "POST", headers: { authorization: `Bearer ${this.config.pinata.jwt}` }, body: form });
      if (!response.ok) throw Object.assign(new Error("Protected media upload failed."), { status: 502, code: "MEDIA_UPLOAD_FAILED" });
      const payload = await response.json();
      const cid = payload?.data?.cid || payload?.cid;
      if (!cid || typeof cid !== "string") throw Object.assign(new Error("Protected media upload did not return a storage key."), { status: 502, code: "MEDIA_UPLOAD_FAILED" });
      return { storageKey: cid };
    }
    throw Object.assign(new Error("Protected media upload is not available for this storage driver."), { status: 501, code: "MEDIA_UPLOAD_UNSUPPORTED" });
  }

  // Direct browser uploads (Pinata only). The API signs a short-lived private
  // upload link whose keyvalues it chooses, so a file found later under those
  // keyvalues was uploaded through a link this server issued for that artist.
  async createSignedUpload({ filename, keyvalues, maxBytes, mimeTypes, expiresSeconds = 900, fetchImpl = fetch }) {
    if (this.config.driver !== "pinata") throw Object.assign(new Error("Direct media upload is not available for this storage driver."), { status: 501, code: "MEDIA_DIRECT_UPLOAD_UNSUPPORTED" });
    const payload = { date: Math.floor(Date.now() / 1000), expires: expiresSeconds, network: "private", max_file_size: maxBytes, allow_mime_types: mimeTypes, keyvalues };
    if (filename) payload.filename = String(filename).slice(0, 256);
    const response = await fetchImpl("https://uploads.pinata.cloud/v3/files/sign", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.config.pinata.jwt}` }, body: JSON.stringify(payload) });
    if (response.status === 401 || response.status === 403) throw Object.assign(new Error("The Pinata key is not allowed to create signed upload links. Give it Files write permission."), { status: 502, code: "MEDIA_UPLOAD_UNAUTHORIZED" });
    if (!response.ok) throw Object.assign(new Error(`Pinata signed upload link failed (HTTP ${response.status}).`), { status: 502, code: "MEDIA_UPLOAD_FAILED" });
    const body = await response.json();
    if (typeof body?.data !== "string" || !body.data.startsWith("https://")) throw Object.assign(new Error("Pinata signed upload link response was invalid."), { status: 502, code: "MEDIA_UPLOAD_FAILED" });
    return body.data;
  }

  // Looks up the exact private object a direct upload created, by the
  // identifier Pinata returned to the uploading browser: the file id (multipart
  // response `data.id`) or the CID (tus `Upload-CID` header). Mirrors the
  // Pinata SDK (v2.5.6): GET /v3/files/private/{id}, GET /v3/files/private?cid=.
  // Returns { file, upstream } where upstream is a redacted record of the call.
  async getPrivateUpload({ fileId = null, cid = null, fetchImpl = fetch }) {
    if (this.config.driver !== "pinata") throw Object.assign(new Error("Direct media upload is not available for this storage driver."), { status: 501, code: "MEDIA_DIRECT_UPLOAD_UNSUPPORTED" });
    const endpoint = fileId ? `https://api.pinata.cloud/v3/files/private/${encodeURIComponent(fileId)}` : `https://api.pinata.cloud/v3/files/private?${new URLSearchParams({ cid, limit: "10" })}`;
    const shown = fileId ? "GET /v3/files/private/{id}" : "GET /v3/files/private?cid=";
    let response;
    try {
      response = await fetchImpl(endpoint, { headers: { authorization: `Bearer ${this.config.pinata.jwt}` } });
    } catch (error) {
      throw Object.assign(new Error(`Pinata private file lookup could not be reached: ${error.message}`), { status: 502, code: "MEDIA_UPLOAD_LOOKUP_FAILED", upstream: { endpoint: shown, status: null } });
    }
    const text = await response.text().catch(() => "");
    let body = null;
    try { body = JSON.parse(text); } catch { /* non-JSON error body */ }
    const files = fileId ? (body?.data && typeof body.data === "object" && !Array.isArray(body.data) ? [body.data] : []) : (Array.isArray(body?.data?.files) ? body.data.files : []);
    const upstream = { endpoint: shown, status: response.status, count: files.length, files: files.map(redactPinataFile), error: response.ok ? undefined : redactText(text) };
    if (response.status === 404) return { file: null, upstream };
    if (!response.ok) throw Object.assign(new Error(`Pinata private file lookup failed (HTTP ${response.status}).`), { status: 502, code: "MEDIA_UPLOAD_LOOKUP_FAILED", upstream });
    // A cid query can in principle match the same bytes uploaded twice; keep
    // the one carrying this upload's id, if any (the caller re-checks it).
    const raw = files.find((entry) => !fileId || entry.id === fileId) || null;
    return { file: raw ? normalizePinataFile(raw) : null, upstream };
  }

  // SHA-256 of the stored private object, streamed through a short-lived
  // private download link. Proves the bytes in storage are the declared ones.
  async sha256OfPrivateObject({ cid, fetchImpl = fetch }) {
    const url = await this.signer(cid);
    // Ask for the stored bytes exactly: a compressed or partial response would
    // hash to something other than the uploaded file.
    const response = await fetchImpl(url, { headers: { "accept-encoding": "identity" } });
    const download = { status: response.status, contentLength: response.headers?.get?.("content-length") ?? null, contentEncoding: response.headers?.get?.("content-encoding") ?? null, contentType: response.headers?.get?.("content-type") ?? null };
    if (response.status !== 200 || !response.body) throw Object.assign(new Error(`Private object download failed (HTTP ${response.status}).`), { status: 502, code: "MEDIA_HASH_UNVERIFIED", upstream: { endpoint: "GET private download link", ...download } });
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of response.body) { hash.update(chunk); bytes += chunk.length; }
    return { sha256: hash.digest("hex"), bytes, download };
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

const shortId = (value) => (typeof value === "string" && value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value ?? null);
function normalizePinataFile(file) {
  return { id: typeof file.id === "string" ? file.id : null, cid: typeof file.cid === "string" ? file.cid : null, name: typeof file.name === "string" ? file.name : null, size: Number(file.size), mimeType: file.mime_type || null, keyvalues: file.keyvalues && typeof file.keyvalues === "object" ? file.keyvalues : {}, network: file.network || "private", createdAt: file.created_at || null };
}
/** Pinata file record with identifiers shortened, for logs and error details. */
export function redactPinataFile(file = {}) {
  return { keys: Object.keys(file || {}).sort(), id: shortId(file?.id), cid: shortId(file?.cid), name: file?.name ?? null, size: file?.size ?? null, mime_type: file?.mime_type ?? null, network: file?.network ?? null, keyvalues: file?.keyvalues ?? null };
}
function redactText(text) {
  return String(text || "").replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[jwt]").replace(/\b(baf[a-z0-9]{10,}|Qm[1-9A-HJ-NP-Za-km-z]{20,})\b/g, (cid) => shortId(cid)).slice(0, 300);
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

function apiBase() {
  return import.meta.env.VITE_API_ORIGIN ? import.meta.env.VITE_API_ORIGIN.replace(/\/$/, "") : "";
}

export async function studioFetch(path, { method = "GET", payload, headers, fetchImpl = fetch } = {}) {
  const endpoint = `${apiBase()}/api${path}`;
  const options = { method, headers: { "content-type": "application/json", ...headers } };
  if (method !== "GET") options.body = JSON.stringify(payload);
  const response = await fetchImpl(endpoint, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error?.message || (response.status === 404 ? `Artist Studio API route not found: ${method} ${path} (${response.status}).` : response.status === 413 ? "The file is too large for the upload route. Try a smaller file." : `Artist Studio request failed (${response.status}).`));
    error.code = body.error?.code || `HTTP_${response.status}`;
    error.status = response.status;
    error.details = body.error?.details || null;
    error.endpoint = `/api${path}`;
    throw error;
  }
  return body.data;
}

export const MAX_ARTWORK_BYTES = 3 * 1024 * 1024;
export const ARTWORK_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";

function fileToBase64(file) {
  return file.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return btoa(binary);
  });
}

// Uploads public release/track artwork and returns its ipfs:// URI. The server
// re-checks type and size from the file's bytes; these checks fail fast.
export async function uploadStudioArtwork({ artistId, file, headers, fetchImpl = fetch }) {
  if (!artistId) throw new Error("Create the release before uploading artwork.");
  if (!file) throw new Error("Choose an image file to upload.");
  if (!ARTWORK_ACCEPT.split(",").includes(file.type)) throw new Error("Artwork must be a PNG, JPEG, GIF or WebP image.");
  if (file.size > MAX_ARTWORK_BYTES) throw new Error("Artwork must be 3 MB or smaller.");
  const data = await fileToBase64(file);
  return studioFetch(`/studio/artists/${encodeURIComponent(artistId)}/artwork`, { method: "POST", payload: { data, filename: file.name }, headers, fetchImpl });
}

export const AUDIO_ACCEPT = "audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/wave,audio/vnd.wave,audio/flac,audio/x-flac,audio/aac,audio/mp4,audio/x-m4a,audio/ogg,audio/aiff,audio/x-aiff,.wav,.flac,.aif,.aiff,.mp3,.m4a,.ogg";
export const MAX_PREVIEW_AUDIO_BYTES = 5 * 1000 * 1000;
export const MAX_PREVIEW_SECONDS = 35;
// Full tracks go straight from the browser to private storage, so a lossless
// WAV master is not limited by the API's request-body size.
export const MAX_FULL_TRACK_BYTES = 500 * 1024 * 1024;
// Used only when the API has no direct-upload storage (local development).
export const MAX_FULL_TRACK_FALLBACK_BYTES = 15 * 1000 * 1000;
// Above this, Pinata takes the file in resumable chunks instead of one request.
export const CHUNKED_UPLOAD_THRESHOLD = 90 * 1024 * 1024;
const CHUNK_BYTES = 50 * 1024 * 1024;

const AUDIO_TYPE_BY_EXTENSION = Object.freeze({ wav: "audio/wav", wave: "audio/wav", flac: "audio/flac", aif: "audio/aiff", aiff: "audio/aiff", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg" });
const AUDIO_TYPES = new Set(AUDIO_ACCEPT.split(",").filter((type) => type.startsWith("audio/")));

// Some systems hand the browser a WAV with an empty or generic type; fall back
// to the extension so the upload is labelled as audio.
export function audioContentType(file) {
  if (AUDIO_TYPES.has(file?.type)) return file.type;
  const extension = String(file?.name || "").toLowerCase().split(".").pop();
  return AUDIO_TYPE_BY_EXTENSION[extension] || null;
}

function assertAudioFile(file) {
  if (!file) throw new Error("Choose an audio file to upload.");
  if (!audioContentType(file)) throw new Error("Audio must be WAV, AIFF, FLAC, MP3, AAC/M4A or OGG.");
}

export function formatMegabytes(bytes) {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

// Reads an audio file's duration in the browser. Returns null if unknown.
export function audioDurationSeconds(file) {
  if (typeof Audio === "undefined" || typeof URL?.createObjectURL !== "function") return Promise.resolve(null);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const element = new Audio();
    const done = (value) => { URL.revokeObjectURL(url); resolve(value); };
    element.preload = "metadata";
    element.onloadedmetadata = () => done(Number.isFinite(element.duration) ? element.duration : null);
    element.onerror = () => done(null);
    element.src = url;
  });
}

// PUBLIC ~30-second preview for the token's animation_url. Never the full track.
export async function uploadStudioPreview({ artistId, file, headers, fetchImpl = fetch, durationOf = audioDurationSeconds }) {
  if (!artistId) throw new Error("Create the release before uploading a preview.");
  assertAudioFile(file);
  if (file.size > MAX_PREVIEW_AUDIO_BYTES) throw new Error("A preview must be 5 MB or smaller. Upload a ~30-second clip, not the full track.");
  const seconds = await durationOf(file);
  if (seconds !== null && seconds > MAX_PREVIEW_SECONDS) throw new Error(`This file is ${Math.round(seconds)} seconds long. The public preview must be a ~30-second clip; upload the full track as private audio.`);
  const data = await fileToBase64(file);
  return studioFetch(`/studio/artists/${encodeURIComponent(artistId)}/audio-preview`, { method: "POST", payload: { data, filename: file.name }, headers, fetchImpl });
}

export async function sha256Hex(file) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// XMLHttpRequest, because fetch cannot report upload progress.
export function xhrSend({ method, url, headers = {}, body, onProgress }) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(method, url);
    for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value);
    if (onProgress) request.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(event.loaded); };
    request.onload = () => resolve({ status: request.status, ok: request.status >= 200 && request.status < 300, header: (name) => request.getResponseHeader(name), text: request.responseText });
    request.onerror = () => reject(new Error("The upload connection failed. Check your connection and try again."));
    request.send(body);
  });
}

async function sendToSignedUrl({ url, file, contentType, send, onProgress }) {
  const report = (loaded) => onProgress?.(Math.min(loaded, file.size), file.size);
  if (file.size <= CHUNKED_UPLOAD_THRESHOLD) {
    const form = new FormData();
    form.append("network", "private");
    form.append("name", file.name);
    form.append("file", new Blob([file], { type: contentType }), file.name);
    const response = await send({ method: "POST", url, body: form, onProgress: report });
    if (!response.ok) throw new Error(`Private storage rejected the upload (HTTP ${response.status}).`);
    report(file.size);
    return;
  }
  // tus resumable upload, the protocol Pinata uses for large files.
  const metadata = [["filename", file.name], ["filetype", contentType], ["network", "private"]].map(([key, value]) => `${key} ${btoa(unescape(encodeURIComponent(value)))}`).join(",");
  const created = await send({ method: "POST", url, headers: { "Upload-Length": String(file.size), "Upload-Metadata": metadata } });
  const location = created.header("Location");
  if (!created.ok || !location) throw new Error(`Private storage did not start the upload (HTTP ${created.status}).`);
  const target = new URL(location, url).toString();
  for (let offset = 0; offset < file.size;) {
    const chunk = file.slice(offset, offset + CHUNK_BYTES);
    let response;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        response = await send({ method: "PATCH", url: target, headers: { "Content-Type": "application/offset+octet-stream", "Upload-Offset": String(offset) }, body: chunk, onProgress: (loaded) => report(offset + loaded) });
        if (response.ok) break;
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
    if (!response?.ok) throw new Error(`Private storage rejected part of the upload (HTTP ${response?.status ?? "network"}).`);
    offset += chunk.size;
    report(offset);
  }
}

const PRIVATE_STORAGE_RETRY_DELAYS_MS = Object.freeze([0, 1000, 2000, 4000, 8000, 15000]);

function withUploadPhase(error, phase) {
  if (error && typeof error === "object") {
    error.phase = phase;
    return error;
  }
  const wrapped = new Error(String(error || "Upload failed."));
  wrapped.phase = phase;
  return wrapped;
}

// PRIVATE full-length track. The API issues a short-lived private upload link
// to the artist's wallet, the browser sends the file straight to private
// storage, and the API then records it. Only an asset id comes back, never a
// storage address.
export async function uploadStudioFullTrack({ artistId, file, headers, fetchImpl = fetch, send = xhrSend, hash = sha256Hex, onProgress, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  if (!artistId) throw new Error("Create the release before uploading the full track.");
  assertAudioFile(file);
  if (!file.size) throw new Error("The audio file is empty.");
  if (file.size > MAX_FULL_TRACK_BYTES) throw new Error(`The full track must be ${formatMegabytes(MAX_FULL_TRACK_BYTES)} or smaller.`);
  const contentType = audioContentType(file);
  const base = `/studio/artists/${encodeURIComponent(artistId)}/media`;
  let link;
  try {
    link = await studioFetch(`${base}/upload-url`, { method: "POST", payload: { mediaType: "AUDIO", filename: file.name, contentType, byteSize: file.size }, headers, fetchImpl });
  } catch (error) {
    if (error.code !== "MEDIA_DIRECT_UPLOAD_UNAVAILABLE") throw error;
    if (file.size > MAX_FULL_TRACK_FALLBACK_BYTES) throw new Error("Large uploads need private storage configured on the API. This server only accepts files up to 15 MB.", { cause: error });
    const data = await fileToBase64(file);
    const asset = await studioFetch(base, { method: "POST", payload: { mediaType: "AUDIO", filename: file.name, contentType, data }, headers, fetchImpl });
    return { assetId: asset.id, filename: file.name, contentType, byteSize: file.size };
  }
  onProgress?.({ stage: "hashing" });
  const contentSha256 = await hash(file);
  try {
    await sendToSignedUrl({ url: link.url, file, contentType, send, onProgress: (loaded, total) => onProgress?.({ stage: "uploading", loaded, total }) });
  } catch (error) {
    throw withUploadPhase(error, "upload");
  }
  onProgress?.({ stage: "verifying" });
  for (let attempt = 0; attempt < PRIVATE_STORAGE_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await wait(PRIVATE_STORAGE_RETRY_DELAYS_MS[attempt]);
    try {
      onProgress?.({ stage: "verifying", attempt: attempt + 1, totalAttempts: PRIVATE_STORAGE_RETRY_DELAYS_MS.length });
      const asset = await studioFetch(`${base}/register`, { method: "POST", payload: { uploadId: link.uploadId, contentSha256 }, headers, fetchImpl });
      onProgress?.({ stage: "registering" });
      return { assetId: asset.id, filename: file.name, contentType, byteSize: asset.byteSize ?? file.size };
    } catch (error) {
      if (error.code !== "MEDIA_UPLOAD_NOT_FOUND" || error.details?.retryable !== true || attempt === PRIVATE_STORAGE_RETRY_DELAYS_MS.length - 1) {
        throw withUploadPhase(error, error.code === "MEDIA_UPLOAD_NOT_FOUND" ? "private-storage" : "registration");
      }
    }
  }
}

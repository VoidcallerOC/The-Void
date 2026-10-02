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

export const AUDIO_ACCEPT = "audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/wave,audio/flac,audio/x-flac,audio/aac,audio/mp4,audio/x-m4a,audio/ogg";
export const MAX_PREVIEW_AUDIO_BYTES = 5 * 1000 * 1000;
export const MAX_PREVIEW_SECONDS = 35;
export const MAX_FULL_TRACK_BYTES = 15 * 1000 * 1000;

function assertAudioFile(file) {
  if (!file) throw new Error("Choose an audio file to upload.");
  if (!AUDIO_ACCEPT.split(",").includes(file.type)) throw new Error("Audio must be MP3, WAV, FLAC, AAC/M4A or OGG.");
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

// PRIVATE full-length track. Stored through the protected-media path; the
// response is only an asset id, never a storage address.
export async function uploadStudioFullTrack({ artistId, file, headers, fetchImpl = fetch }) {
  if (!artistId) throw new Error("Create the release before uploading the full track.");
  assertAudioFile(file);
  if (file.size > MAX_FULL_TRACK_BYTES) throw new Error("The full track must be 15 MB or smaller.");
  const data = await fileToBase64(file);
  const asset = await studioFetch(`/studio/artists/${encodeURIComponent(artistId)}/media`, { method: "POST", payload: { mediaType: "AUDIO", filename: file.name, contentType: file.type, data }, headers, fetchImpl });
  return { assetId: asset.id, filename: file.name, contentType: file.type };
}

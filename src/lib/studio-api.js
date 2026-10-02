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
    const error = new Error(body.error?.message || (response.status === 404 ? `Artist Studio API route not found: ${method} ${path} (${response.status}).` : `Artist Studio request failed (${response.status}).`));
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

export const MAX_AUDIO_BYTES = 15 * 1000 * 1000;
export const AUDIO_ACCEPT = "audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/wave,audio/flac,audio/x-flac,audio/aac,audio/mp4,audio/x-m4a,audio/ogg";

// Uploads a track's audio for its token metadata (animation_url) and returns
// the public ipfs:// URI. The server re-checks type and size from the bytes.
export async function uploadStudioAudio({ artistId, file, headers, fetchImpl = fetch }) {
  if (!artistId) throw new Error("Create the release before uploading audio.");
  if (!file) throw new Error("Choose an audio file to upload.");
  if (!AUDIO_ACCEPT.split(",").includes(file.type)) throw new Error("Audio must be MP3, WAV, FLAC, AAC/M4A or OGG.");
  if (file.size > MAX_AUDIO_BYTES) throw new Error("Audio must be 15 MB or smaller.");
  const data = await fileToBase64(file);
  return studioFetch(`/studio/artists/${encodeURIComponent(artistId)}/audio`, { method: "POST", payload: { data, filename: file.name }, headers, fetchImpl });
}

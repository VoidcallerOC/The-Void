function apiBase() {
  const configured = import.meta.env.VITE_API_ORIGIN;
  return configured ? configured.replace(/\/$/, "") : "";
}

async function readJson(response) {
  try { return await response.json(); } catch { return {}; }
}

export async function fetchArtistVerification(slug, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${apiBase()}/api/artists/${encodeURIComponent(slug)}/verification`, { headers: { accept: "application/json" } });
  const payload = await readJson(response);
  if (!response.ok) return { verified: false };
  return payload.data || { verified: false };
}

export async function requestArtistChallenge(slug, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${apiBase()}/api/artists/${encodeURIComponent(slug)}/verify/challenge`, { headers: { accept: "application/json" } });
  const payload = await readJson(response);
  if (!response.ok) {
    const error = new Error(payload?.error?.message || "Could not create a verification challenge.");
    error.code = payload?.error?.code;
    error.status = response.status;
    throw error;
  }
  return payload.data;
}

export async function submitArtistVerification({ slug, address, signature, nonce, fetchImpl = fetch }) {
  const response = await fetchImpl(`${apiBase()}/api/artists/${encodeURIComponent(slug)}/verify`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ address, signature, nonce }),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    const error = new Error(payload?.error?.message || "Verification failed.");
    error.code = payload?.error?.code;
    error.status = response.status;
    throw error;
  }
  return payload.data;
}

export function verificationBadgeVisible(record) {
  return Boolean(record?.verified);
}

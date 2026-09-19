function apiBase() {
  const configured = import.meta.env.VITE_API_ORIGIN;
  return configured ? configured.replace(/\/$/, "") : "";
}

async function request(path, { method = "GET", body = null, headers = {}, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${apiBase()}/api${path}`, {
    method,
    headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let payload;
  try { payload = await response.json(); } catch { throw new Error("Verification service returned an invalid response."); }
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `Verification request failed (${response.status}).`);
    error.code = payload?.error?.code || `HTTP_${response.status}`;
    error.status = response.status;
    error.details = payload?.error?.details || null;
    throw error;
  }
  return payload.data;
}

export function fetchMyApplication({ headers, fetchImpl } = {}) {
  return request("/verification/me", { headers, fetchImpl });
}

export function submitVerificationApplication({ payload, headers, fetchImpl } = {}) {
  return request("/verification/applications", { method: "POST", body: payload, headers, fetchImpl });
}

export function respondToVerificationRequest({ publicId, payload, headers, fetchImpl } = {}) {
  return request(`/verification/applications/${encodeURIComponent(publicId)}/response`, { method: "POST", body: payload, headers, fetchImpl });
}

export function fetchVerifiedArtists({ fetchImpl } = {}) {
  return request("/verification/artists", { fetchImpl });
}

export function fetchReviewQueue({ headers, fetchImpl } = {}) {
  return request("/verification/review", { headers, fetchImpl });
}

export function fetchReviewApplication({ publicId, headers, fetchImpl } = {}) {
  return request(`/verification/review/${encodeURIComponent(publicId)}`, { headers, fetchImpl });
}

export function decideVerificationApplication({ publicId, payload, headers, fetchImpl } = {}) {
  return request(`/verification/review/${encodeURIComponent(publicId)}/decision`, { method: "POST", body: payload, headers, fetchImpl });
}

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
  try { payload = await response.json(); } catch { throw new Error("X account service returned an invalid response."); }
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `X account request failed (${response.status}).`);
    error.code = payload?.error?.code || `HTTP_${response.status}`;
    error.status = response.status;
    throw error;
  }
  if (!payload?.data) throw new Error("X account service returned an invalid response.");
  return payload.data;
}

export const fetchXLink = ({ headers, fetchImpl } = {}) => request("/x-link", { headers, fetchImpl });
export const startXLink = ({ headers, fetchImpl } = {}) => request("/x-link/start", { method: "POST", body: {}, headers, fetchImpl });
export const completeXLink = ({ code, state, error, headers, fetchImpl } = {}) => request("/x-link/callback", { method: "POST", body: { code, state, error }, headers, fetchImpl });
export const disconnectXLink = ({ headers, fetchImpl } = {}) => request("/x-link/disconnect", { method: "POST", body: { confirm: true }, headers, fetchImpl });

export const X_LINK_MESSAGE = "void:x-link-callback";

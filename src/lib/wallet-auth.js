function apiBase() {
  const configured = import.meta.env.VITE_API_ORIGIN;
  return configured ? configured.replace(/\/$/, "") : "";
}

function endpoint(path) {
  return `${apiBase()}${path}`;
}

async function postJson(path, body, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(endpoint(path), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  let payload;
  try { payload = await response.json(); } catch { throw new Error("Authentication service returned an invalid response."); }
  if (!response.ok) {
    const error = new Error(payload?.error?.message || "Wallet authentication failed.");
    error.code = payload?.error?.code || "AUTH_REQUEST_FAILED";
    throw error;
  }
  if (!payload?.data) throw new Error("Authentication service returned an invalid response.");
  return payload.data;
}

export async function authenticateWallet({ provider, wallet, chainId, purpose = "wallet-auth", fetchImpl = fetch } = {}) {
  if (!provider?.request || !wallet || !Number.isInteger(chainId)) throw new Error("A connected wallet and network are required for authentication.");
  const challenge = await postJson("/api/auth/nonce", { wallet, chainId, purpose }, { fetchImpl });
  if (!challenge?.message || !challenge?.nonce) throw new Error("Authentication challenge was incomplete.");
  let signature;
  try {
    signature = await provider.request({ method: "personal_sign", params: [challenge.message, wallet] });
  } catch (error) {
    if (error?.code === 4001) {
      const rejected = new Error("Wallet signature was rejected.");
      rejected.code = "AUTH_SIGNATURE_REJECTED";
      throw rejected;
    }
    throw error;
  }
  const session = await postJson("/api/auth/verify", { wallet, chainId, purpose, nonce: challenge.nonce, message: challenge.message, signature }, { fetchImpl });
  if (!session?.token || String(session.wallet).toLowerCase() !== wallet.toLowerCase() || Number(session.chainId) !== chainId) throw new Error("Authentication session did not match the connected wallet.");
  return session;
}

export function authorizationHeaders(session) {
  return session?.token ? { authorization: `Bearer ${session.token}` } : {};
}

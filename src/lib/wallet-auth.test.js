import { describe, expect, it, vi } from "vitest";
import { authenticateWallet, authorizationHeaders } from "./wallet-auth.js";

const wallet = "0xd1b4367dd9f235f9ee61878019d66e31511e98ee";
const message = "voidcaller.example wants you to sign in with your Ethereum account:\n0xd1b4367dd9f235f9ee61878019d66e31511e98ee";

function response({ ok = true, data = null, error = null } = {}) {
  return { ok, json: async () => (ok ? { data } : { error }) };
}

describe("browser wallet authentication", () => {
  it("requests a challenge, signs exactly the issued message, and exchanges it for a session", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ data: { nonce: "nonce_00000000000000000000000001", message } }))
      .mockResolvedValueOnce(response({ data: { token: "session_000000000000000000000001", wallet, chainId: 43113 } }));
    const provider = { request: vi.fn().mockResolvedValue("0xsigned") };

    const session = await authenticateWallet({ provider, wallet, chainId: 43113, fetchImpl });

    expect(provider.request).toHaveBeenCalledWith({ method: "personal_sign", params: [message, wallet] });
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "/api/auth/nonce", expect.objectContaining({ method: "POST", body: JSON.stringify({ wallet, chainId: 43113, purpose: "wallet-auth" }) }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "/api/auth/verify", expect.objectContaining({ method: "POST", body: JSON.stringify({ wallet, chainId: 43113, purpose: "wallet-auth", nonce: "nonce_00000000000000000000000001", message, signature: "0xsigned" }) }));
    expect(authorizationHeaders(session)).toEqual({ authorization: "Bearer session_000000000000000000000001" });
  });

  it("does not create a session when the user rejects the signature or the server rejects verification", async () => {
    const rejectedProvider = { request: vi.fn().mockRejectedValue({ code: 4001 }) };
    const fetchImpl = vi.fn().mockResolvedValue(response({ data: { nonce: "nonce_00000000000000000000000001", message } }));
    await expect(authenticateWallet({ provider: rejectedProvider, wallet, chainId: 43113, fetchImpl })).rejects.toMatchObject({ code: "AUTH_SIGNATURE_REJECTED" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const provider = { request: vi.fn().mockResolvedValue("0xsigned") };
    const rejectedVerification = vi.fn()
      .mockResolvedValueOnce(response({ data: { nonce: "nonce_00000000000000000000000001", message } }))
      .mockResolvedValueOnce(response({ ok: false, error: { code: "AUTH_CHALLENGE_REUSED", message: "Authentication challenge has already been used." } }));
    await expect(authenticateWallet({ provider, wallet, chainId: 43113, fetchImpl: rejectedVerification })).rejects.toMatchObject({ code: "AUTH_CHALLENGE_REUSED" });
    expect(authorizationHeaders(null)).toEqual({});
  });
});

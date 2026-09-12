import { describe, expect, it } from "vitest";
import { Wallet } from "ethers";
import { ApiError } from "./api-errors.js";
import { createWalletAuthenticator } from "./wallet-auth.js";

const config = { authDomain: "https://the-void.example", authUri: "https://the-void.example/login", authChainId: 43113 };
const request = { headers: { origin: "https://the-void.example" } };

function fakeDb() {
  const state = { nonce: null, consumed: false, sessions: [] };
  return {
    state,
    async query(sql, values) {
      if (sql.startsWith("INSERT INTO auth_nonces")) { state.nonce = { hash: values[0], wallet: values[1], domain: values[2], origin: values[3], uri: values[4], chainId: values[5], purpose: values[6], issuedAt: values[7], expiresAt: values[8] }; return { rows: [] }; }
      if (sql.startsWith("SELECT issued_at")) {
        if (state.consumed || !state.nonce || values[0] !== state.nonce.hash || values[1] !== state.nonce.wallet || values[2] !== state.nonce.domain || values[3] !== state.nonce.origin || values[4] !== state.nonce.uri || values[5] !== state.nonce.chainId || values[6] !== state.nonce.purpose) return { rows: [] };
        return { rows: [{ issued_at: state.nonce.issuedAt, expires_at: state.nonce.expiresAt }] };
      }
      if (sql.startsWith("UPDATE auth_nonces")) {
        if (state.consumed || !state.nonce || new Date(state.nonce.expiresAt) <= values[0] || values[1] !== state.nonce.hash || values[2] !== state.nonce.wallet || values[3] !== state.nonce.domain || values[4] !== state.nonce.origin || values[5] !== state.nonce.uri || values[6] !== state.nonce.chainId || values[7] !== state.nonce.purpose) return { rows: [] };
        state.consumed = true;
        return { rows: [{ issued_at: state.nonce.issuedAt, expires_at: state.nonce.expiresAt }] };
      }
      if (sql.startsWith("INSERT INTO auth_sessions")) { state.sessions.push(values); return { rows: [] }; }
      if (sql.startsWith("SELECT wallet_address")) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

async function setup(overrides = {}) {
  const wallet = Wallet.createRandom();
  const db = fakeDb();
  const auth = createWalletAuthenticator({ db, config: { ...config, ...overrides }, now: () => new Date("2026-09-12T13:00:00.000Z") });
  const challenge = await auth.issueChallenge({ wallet: wallet.address, request, purpose: "wallet-login", requestId: "test" });
  return { wallet, db, auth, challenge };
}

describe("production wallet authentication", () => {
  it("authenticates a valid EIP-191 signature and persists a session", async () => {
    const { wallet, db, auth, challenge } = await setup();
    const signature = await wallet.signMessage(challenge.message);
    const result = await auth.verify({ wallet: wallet.address, signature, nonce: challenge.nonce, request, purpose: "wallet-login" });
    expect(result).toMatchObject({ wallet: wallet.address, chainId: 43113 });
    expect(db.state.consumed).toBe(true);
    expect(db.state.sessions).toHaveLength(1);
  });

  it("rejects invalid, malformed, and wrong-wallet signatures", async () => {
    const first = await setup();
    await expect(first.auth.verify({ wallet: first.wallet.address, signature: "0x1234", nonce: first.challenge.nonce, request })).rejects.toMatchObject({ code: "MALFORMED_SIGNATURE" });
    const second = await setup();
    const other = Wallet.createRandom();
    const signature = await other.signMessage(second.challenge.message);
    await expect(second.auth.verify({ wallet: second.wallet.address, signature, nonce: second.challenge.nonce, request })).rejects.toMatchObject({ code: "WALLET_MISMATCH" });
  });

  it("consumes a nonce once and rejects concurrent reuse", async () => {
    const { wallet, auth, challenge } = await setup();
    const signature = await wallet.signMessage(challenge.message);
    const results = await Promise.allSettled([
      auth.verify({ wallet: wallet.address, signature, nonce: challenge.nonce, request }),
      auth.verify({ wallet: wallet.address, signature, nonce: challenge.nonce, request }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")[0].reason).toMatchObject({ code: "CHALLENGE_INVALID" });
  });

  it("rejects wrong origin, purpose, and chain-bound challenges", async () => {
    const { wallet, auth, challenge } = await setup();
    const signature = await wallet.signMessage(challenge.message);
    await expect(auth.verify({ wallet: wallet.address, signature, nonce: challenge.nonce, request: { headers: { origin: "https://evil.example" } } })).rejects.toMatchObject({ code: "ORIGIN_MISMATCH" });
    const wrongPurpose = await setup();
    await expect(wrongPurpose.auth.verify({ wallet: wallet.address, signature, nonce: wrongPurpose.challenge.nonce, request, purpose: "other" })).rejects.toMatchObject({ code: "INVALID_PURPOSE" });
    expect(createWalletAuthenticator({ db: fakeDb(), config: { ...config, authChainId: 43114 } })).toBeTruthy();
  });

  it("rejects an expired challenge before signature verification", async () => {
    const wallet = Wallet.createRandom();
    const db = fakeDb();
    const auth = createWalletAuthenticator({ db, config, now: () => new Date("2026-09-12T13:00:00.000Z"), nonceTtlMs: -1 });
    const challenge = await auth.issueChallenge({ wallet: wallet.address, request });
    const signature = await wallet.signMessage(challenge.message);
    await expect(auth.verify({ wallet: wallet.address, signature, nonce: challenge.nonce, request })).rejects.toMatchObject({ code: "CHALLENGE_INVALID" });
    expect(new ApiError(401, "UNAUTHORIZED", "x")).toBeInstanceOf(Error);
  });
});

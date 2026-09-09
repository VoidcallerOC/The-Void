import { Wallet } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api-errors.js";
import { WalletAuthService, createAuthMessage, createWalletAuthenticator, hashSecret } from "./auth.js";
import { loadServerConfig } from "./config.js";
import { ApiService } from "./api-service.js";

const wallet = "0xd1b4367dd9f235f9ee61878019d66e31511e98ee";
const otherWallet = "0x1111111111111111111111111111111111111111";

function memoryRepository(clock) {
  const nonces = new Map();
  const sessions = new Map();
  return {
    nonces,
    sessions,
    createNonce: vi.fn(async (value) => {
      nonces.set(value.nonceHash, { nonce_hash: value.nonceHash, wallet_address: value.wallet, chain_id: value.chainId, domain: value.domain, uri: value.uri, purpose: value.purpose, issued_at: value.issuedAt, expires_at: value.expiresAt, consumed_at: null, request_id: value.requestId });
      return nonces.get(value.nonceHash);
    }),
    getNonce: vi.fn(async ({ nonceHash }) => nonces.get(nonceHash) || null),
    consumeNonce: vi.fn(async (value) => {
      const row = nonces.get(value.nonceHash);
      if (!row || row.consumed_at || row.wallet_address !== value.wallet || row.chain_id !== value.chainId || row.domain !== value.domain || row.uri !== value.uri || row.purpose !== value.purpose || new Date(row.expires_at) <= clock.now) {
        const error = new Error("Nonce is missing, expired, or already consumed.");
        error.code = "CONFLICT";
        throw error;
      }
      row.consumed_at = new Date(clock.now);
      return row;
    }),
    createAuthSession: vi.fn(async (value) => {
      sessions.set(value.sessionHash, { session_hash: value.sessionHash, wallet_address: value.wallet, chain_id: value.chainId, purpose: value.purpose, issued_at: value.issuedAt, expires_at: value.expiresAt, revoked_at: null, request_id: value.requestId });
      return sessions.get(value.sessionHash);
    }),
    getActiveAuthSession: vi.fn(async ({ sessionHash }) => {
      const session = sessions.get(sessionHash);
      return session && !session.revoked_at && new Date(session.expires_at) > clock.now ? session : null;
    }),
  };
}

function harness({ allowedChainIds = [43113, 43114], challengeTtlSeconds = 300, sessionTtlSeconds = 600 } = {}) {
  const clock = { now: new Date("2026-09-09T20:00:00.000Z") };
  const repository = memoryRepository(clock);
  let nonceSequence = 0;
  let sessionSequence = 0;
  const auth = new WalletAuthService({
    repository,
    config: { authDomain: "app.voidcaller.example", authUri: "https://app.voidcaller.example", authAllowedChainIds: allowedChainIds, authChallengeTtlSeconds: challengeTtlSeconds, authSessionTtlSeconds: sessionTtlSeconds },
    now: () => new Date(clock.now),
    nonceGenerator: () => `nonce_${String(++nonceSequence).padStart(26, "0")}`,
    sessionTokenGenerator: () => `session_${String(++sessionSequence).padStart(24, "0")}`,
  });
  return { auth, clock, repository };
}

async function signedChallenge(auth, signer, input = {}) {
  const challenge = await auth.createChallenge({ wallet: signer.address, chainId: 43113, purpose: "wallet-auth", ...input });
  return { challenge, signature: await signer.signMessage(challenge.message) };
}

async function expectApiError(promise, code) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("EIP-191 wallet authentication", () => {
  it("issues a secure challenge, persists only the nonce hash, verifies the signer, and creates a hashed session", async () => {
    const signer = new Wallet("0x8b3a350cf5c34c9194ca3a545d6c9c10d8fcb5d8e83b2f628c71083b4a75807f");
    const { auth, repository } = harness();
    const { challenge, signature } = await signedChallenge(auth, signer);
    const result = await auth.verifyChallenge({ wallet: signer.address, chainId: 43113, nonce: challenge.nonce, message: challenge.message, signature });

    expect(challenge.message).toBe(createAuthMessage(challenge));
    expect(challenge.message).toContain("app.voidcaller.example");
    expect(challenge.message).toContain("URI: https://app.voidcaller.example");
    expect(challenge.message).toContain("Chain ID: 43113");
    expect(challenge.message).toContain(`Nonce: ${challenge.nonce}`);
    expect(challenge.message).toContain("Purpose: wallet-auth");
    expect(result.wallet).toBe(signer.address.toLowerCase());
    expect(result.token).not.toBe(result.wallet);
    expect(repository.createNonce).toHaveBeenCalledWith(expect.objectContaining({ nonceHash: hashSecret(challenge.nonce), wallet: signer.address.toLowerCase(), chainId: 43113 }));
    expect(repository.createNonce.mock.calls[0][0]).not.toHaveProperty("nonce");
    expect(repository.createAuthSession.mock.calls[0][0]).toEqual(expect.objectContaining({ sessionHash: hashSecret(result.token), wallet: signer.address.toLowerCase(), chainId: 43113 }));
    expect(repository.createAuthSession.mock.calls[0][0]).not.toHaveProperty("token");
  });

  it("authenticates only with an active opaque bearer session", async () => {
    const signer = Wallet.createRandom();
    const { auth, clock } = harness({ sessionTtlSeconds: 300 });
    const { challenge, signature } = await signedChallenge(auth, signer);
    const session = await auth.verifyChallenge({ wallet: signer.address, chainId: 43113, nonce: challenge.nonce, message: challenge.message, signature });

    await expect(auth.authenticate({ headers: { authorization: `Bearer ${session.token}` } })).resolves.toMatchObject({ wallet: signer.address.toLowerCase(), chainId: 43113 });
    await expectApiError(auth.authenticate({ headers: {} }), "UNAUTHORIZED");
    clock.now = new Date(clock.now.getTime() + 301_000);
    await expectApiError(auth.authenticate({ headers: { authorization: `Bearer ${session.token}` } }), "UNAUTHORIZED");
  });

  it("protects identity-bearing API operations with the verified session, not a browser wallet claim", async () => {
    const signer = Wallet.createRandom();
    const { auth, repository } = harness();
    const { challenge, signature } = await signedChallenge(auth, signer);
    const session = await auth.verifyChallenge({ wallet: signer.address, chainId: 43113, nonce: challenge.nonce, message: challenge.message, signature });
    const service = new ApiService({ db: { query: vi.fn().mockResolvedValue({ rows: [{ id: "marketplace-contract", address: otherWallet }] }) }, repository: { ...repository, upsertTransaction: vi.fn().mockResolvedValue({ status: "SUBMITTED" }) }, authenticator: createWalletAuthenticator(auth) });
    const request = { headers: { authorization: `Bearer ${session.token}` } };

    const transactionHash = `0x${"a".repeat(64)}`;
    await expect(service.createListing({ request, input: { sellerWallet: signer.address, chainId: 43113, transactionHash, marketplaceAddress: otherWallet } })).resolves.toMatchObject({ state: "PENDING" });
    await expectApiError(service.createListing({ request, input: { sellerWallet: otherWallet, chainId: 43113, transactionHash, marketplaceAddress: otherWallet } }), "WALLET_MISMATCH");
    await expectApiError(service.createListing({ request: { headers: {} }, input: { sellerWallet: signer.address, chainId: 43113, transactionHash, marketplaceAddress: otherWallet } }), "UNAUTHORIZED");
  });

  it("rejects invalid, malformed, and wrong-wallet signatures", async () => {
    const signer = Wallet.createRandom();
    const attacker = Wallet.createRandom();
    const { auth } = harness();
    const first = await signedChallenge(auth, signer);
    await expectApiError(auth.verifyChallenge({ wallet: signer.address, chainId: 43113, nonce: first.challenge.nonce, message: first.challenge.message, signature: "0x" + "00".repeat(65) }), "AUTH_INVALID_SIGNATURE");

    const second = await signedChallenge(auth, signer);
    await expectApiError(auth.verifyChallenge({ wallet: signer.address, chainId: 43113, nonce: second.challenge.nonce, message: second.challenge.message, signature: "not-a-signature" }), "AUTH_INVALID_SIGNATURE");

    const third = await signedChallenge(auth, signer);
    const attackerSignature = await attacker.signMessage(third.challenge.message);
    await expectApiError(auth.verifyChallenge({ wallet: signer.address, chainId: 43113, nonce: third.challenge.nonce, message: third.challenge.message, signature: attackerSignature }), "AUTH_WALLET_MISMATCH");
  });

  it("rejects a request wallet or permitted chain that differs from the issued challenge", async () => {
    const signer = Wallet.createRandom();
    const { auth } = harness();
    const { challenge, signature } = await signedChallenge(auth, signer);
    await expectApiError(auth.verifyChallenge({ wallet: otherWallet, chainId: 43113, nonce: challenge.nonce, message: challenge.message, signature }), "AUTH_CHALLENGE_MISMATCH");
    await expectApiError(auth.verifyChallenge({ wallet: signer.address, chainId: 43114, nonce: challenge.nonce, message: challenge.message, signature }), "AUTH_CHALLENGE_MISMATCH");
  });

  it("rejects tampered domain, URI, nonce, purpose, timestamp, and malformed messages", async () => {
    const signer = Wallet.createRandom();
    const { auth } = harness();
    const variants = [
      (message) => message.replace("app.voidcaller.example", "attacker.example"),
      (message) => message.replace("https://app.voidcaller.example", "https://attacker.example"),
      (message) => message.replace("Purpose: wallet-auth", "Purpose: media-download"),
      (message) => message.replace("Issued At: 2026", "Issued At: 2025"),
      () => "not an issued authentication message",
    ];
    for (const mutate of variants) {
      const { challenge, signature } = await signedChallenge(auth, signer);
      await expectApiError(auth.verifyChallenge({ wallet: signer.address, chainId: 43113, nonce: challenge.nonce, message: mutate(challenge.message), signature }), "AUTH_MESSAGE_MISMATCH");
    }
  });

  it("rejects expired challenges and unsupported networks before signature verification", async () => {
    const signer = Wallet.createRandom();
    const { auth, clock } = harness({ challengeTtlSeconds: 60, allowedChainIds: [43113] });
    const { challenge, signature } = await signedChallenge(auth, signer);
    clock.now = new Date(clock.now.getTime() + 61_000);
    await expectApiError(auth.verifyChallenge({ wallet: signer.address, chainId: 43113, nonce: challenge.nonce, message: challenge.message, signature }), "AUTH_CHALLENGE_EXPIRED");
    await expectApiError(auth.createChallenge({ wallet: signer.address, chainId: 43114 }), "AUTH_CHAIN_UNSUPPORTED");
  });

  it("consumes each challenge once and rejects replay, including concurrent reuse", async () => {
    const signer = Wallet.createRandom();
    const { auth, repository } = harness();
    const { challenge, signature } = await signedChallenge(auth, signer);
    await expect(auth.verifyChallenge({ wallet: signer.address, chainId: 43113, nonce: challenge.nonce, message: challenge.message, signature })).resolves.toMatchObject({ wallet: signer.address.toLowerCase() });
    await expectApiError(auth.verifyChallenge({ wallet: signer.address, chainId: 43113, nonce: challenge.nonce, message: challenge.message, signature }), "AUTH_CHALLENGE_REUSED");

    const concurrent = await signedChallenge(auth, signer);
    const attempts = await Promise.allSettled([
      auth.verifyChallenge({ wallet: signer.address, chainId: 43113, nonce: concurrent.challenge.nonce, message: concurrent.challenge.message, signature: concurrent.signature }),
      auth.verifyChallenge({ wallet: signer.address, chainId: 43113, nonce: concurrent.challenge.nonce, message: concurrent.challenge.message, signature: concurrent.signature }),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")[0].reason).toMatchObject({ code: "AUTH_CHALLENGE_REUSED" });
    expect(repository.consumeNonce).toHaveBeenCalledWith(expect.objectContaining({ chainId: 43113, domain: "app.voidcaller.example", uri: "https://app.voidcaller.example" }));
  });

  it("preserves production C-Chain-only configuration requirements", () => {
    expect(() => new WalletAuthService({ repository: {}, config: {} })).toThrow(TypeError);
    expect(() => createAuthMessage({ domain: "x", uri: "https://x", wallet, chainId: 43114, nonce: "short", issuedAt: new Date(), expiresAt: new Date(Date.now() + 1000), purpose: "wallet-auth" })).toThrow(ApiError);
    expect(loadServerConfig({ NODE_ENV: "production", DATABASE_URL: "postgres://example", PUBLIC_APP_URL: "https://app.voidcaller.example" })).toMatchObject({ authDomain: "app.voidcaller.example", authAllowedChainIds: [43114] });
    expect(() => loadServerConfig({ NODE_ENV: "production", DATABASE_URL: "postgres://example", PUBLIC_APP_URL: "http://app.voidcaller.example" })).toThrow(/HTTPS/);
    expect(() => loadServerConfig({ NODE_ENV: "production", DATABASE_URL: "postgres://example", PUBLIC_APP_URL: "https://app.voidcaller.example", AUTH_ALLOWED_CHAIN_IDS: "43113" })).toThrow(/C-Chain/);
    expect(() => loadServerConfig({ DATABASE_URL: "postgres://example", PUBLIC_APP_URL: "http://localhost:5173", AUTH_ALLOWED_CHAIN_IDS: "36463" })).toThrow(/Fuji/);
  });
});

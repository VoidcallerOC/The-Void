import { createHash, randomBytes } from "node:crypto";
import { getAddress, verifyMessage } from "ethers";
import { ApiError } from "./api-errors.js";
import { chainId, requiredText, walletAddress } from "./validation.js";

export const AUTH_PURPOSES = Object.freeze(["wallet-auth"]);

function timestamp(value) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new ApiError(400, "AUTH_CHALLENGE_MALFORMED", "Authentication challenge timestamps are invalid.");
  return parsed;
}

function isoTimestamp(value) {
  return timestamp(value).toISOString();
}

function requirePurpose(value) {
  const purpose = requiredText(value || "wallet-auth", "auth.purpose", { max: 64 });
  if (!AUTH_PURPOSES.includes(purpose)) throw new ApiError(400, "AUTH_PURPOSE_UNSUPPORTED", "Authentication purpose is not supported.");
  return purpose;
}

function nonceValue(value) {
  const nonce = requiredText(value, "auth.nonce", { max: 128 });
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(nonce)) throw new ApiError(400, "AUTH_CHALLENGE_MALFORMED", "Authentication nonce is malformed.");
  return nonce;
}

function signatureValue(value) {
  const signature = requiredText(value, "auth.signature", { max: 132 });
  if (!/^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/.test(signature)) throw new ApiError(401, "AUTH_INVALID_SIGNATURE", "Wallet signature is malformed.");
  return signature;
}

function bearerToken(headers = {}) {
  const raw = headers.authorization || headers.Authorization;
  if (Array.isArray(raw) || typeof raw !== "string") throw new ApiError(401, "UNAUTHORIZED", "A wallet authentication session is required.");
  const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(raw.trim());
  if (!match) throw new ApiError(401, "UNAUTHORIZED", "A wallet authentication session is required.");
  return match[1];
}

export function hashSecret(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function createSecureNonce() {
  return randomBytes(32).toString("base64url");
}

export function createSecureSessionToken() {
  return randomBytes(32).toString("base64url");
}

export function createAuthMessage({ domain, uri, wallet, chainId: rawChainId, nonce, issuedAt, expiresAt, purpose }) {
  const normalizedDomain = requiredText(domain, "auth.domain", { max: 255 });
  const normalizedUri = requiredText(uri, "auth.uri", { max: 2048 });
  const normalizedWallet = walletAddress(wallet, "auth.wallet");
  const normalizedChainId = chainId(rawChainId, "auth.chainId");
  const normalizedNonce = nonceValue(nonce);
  const normalizedPurpose = requirePurpose(purpose);
  const normalizedIssuedAt = isoTimestamp(issuedAt);
  const normalizedExpiresAt = isoTimestamp(expiresAt);
  if (timestamp(normalizedExpiresAt) <= timestamp(normalizedIssuedAt)) throw new ApiError(400, "AUTH_CHALLENGE_MALFORMED", "Authentication challenge expiration must be after issuance.");

  return `${normalizedDomain} wants you to sign in with your Ethereum account:\n${normalizedWallet}\n\nSign in to Voidcaller.\n\nURI: ${normalizedUri}\nVersion: 1\nChain ID: ${normalizedChainId}\nNonce: ${normalizedNonce}\nIssued At: ${normalizedIssuedAt}\nExpiration Time: ${normalizedExpiresAt}\nPurpose: ${normalizedPurpose}`;
}

function normalizeStoredChallenge(row) {
  if (!row || !row.nonce_hash) throw new ApiError(401, "AUTH_CHALLENGE_INVALID", "Authentication challenge is invalid.");
  try {
    return {
      nonceHash: requiredText(row.nonce_hash, "auth.nonceHash", { max: 256 }),
      wallet: walletAddress(row.wallet_address, "auth.wallet"),
      chainId: chainId(row.chain_id, "auth.chainId"),
      domain: requiredText(row.domain, "auth.domain", { max: 255 }),
      uri: requiredText(row.uri, "auth.uri", { max: 2048 }),
      purpose: requirePurpose(row.purpose),
      issuedAt: timestamp(row.issued_at),
      expiresAt: timestamp(row.expires_at),
      consumedAt: row.consumed_at ? timestamp(row.consumed_at) : null,
    };
  } catch {
    throw new ApiError(401, "AUTH_CHALLENGE_INVALID", "Authentication challenge is invalid.");
  }
}

export class WalletAuthService {
  constructor({ repository, config, now = () => new Date(), nonceGenerator = createSecureNonce, sessionTokenGenerator = createSecureSessionToken } = {}) {
    if (!repository?.createNonce || !repository?.getNonce || !repository?.consumeNonce || !repository?.createAuthSession || !repository?.getActiveAuthSession) throw new TypeError("WalletAuthService requires nonce and session persistence methods.");
    if (!config?.authDomain || !config?.authUri || !Array.isArray(config.authAllowedChainIds) || config.authAllowedChainIds.length === 0) throw new TypeError("WalletAuthService requires authentication configuration.");
    this.repository = repository;
    this.config = config;
    this.now = now;
    this.nonceGenerator = nonceGenerator;
    this.sessionTokenGenerator = sessionTokenGenerator;
  }

  assertAllowedChain(rawChainId) {
    const selectedChainId = chainId(rawChainId, "auth.chainId");
    if (!this.config.authAllowedChainIds.includes(selectedChainId)) throw new ApiError(400, "AUTH_CHAIN_UNSUPPORTED", "Authentication is not available on this network.");
    return selectedChainId;
  }

  async createChallenge({ wallet, chainId: rawChainId, purpose = "wallet-auth", requestId = null }) {
    const normalizedWallet = walletAddress(wallet, "auth.wallet");
    const selectedChainId = this.assertAllowedChain(rawChainId);
    const normalizedPurpose = requirePurpose(purpose);
    const issuedAt = timestamp(this.now());
    const expiresAt = new Date(issuedAt.getTime() + this.config.authChallengeTtlSeconds * 1000);
    const nonce = nonceValue(this.nonceGenerator());
    const nonceHash = hashSecret(nonce);
    const challenge = {
      domain: this.config.authDomain,
      uri: this.config.authUri,
      wallet: normalizedWallet,
      chainId: selectedChainId,
      nonce,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      purpose: normalizedPurpose,
    };
    const message = createAuthMessage(challenge);
    await this.repository.createNonce({
      nonceHash,
      wallet: normalizedWallet,
      chainId: selectedChainId,
      domain: this.config.authDomain,
      uri: this.config.authUri,
      purpose: normalizedPurpose,
      issuedAt,
      expiresAt,
      requestId,
    });
    return { ...challenge, message };
  }

  async verifyChallenge({ wallet, chainId: rawChainId, purpose = "wallet-auth", nonce, message, signature, requestId = null }) {
    const normalizedWallet = walletAddress(wallet, "auth.wallet");
    const selectedChainId = this.assertAllowedChain(rawChainId);
    const normalizedPurpose = requirePurpose(purpose);
    const normalizedNonce = nonceValue(nonce);
    const nonceHash = hashSecret(normalizedNonce);
    const stored = normalizeStoredChallenge(await this.repository.getNonce({ nonceHash }));
    const currentTime = timestamp(this.now());

    if (stored.consumedAt) throw new ApiError(401, "AUTH_CHALLENGE_REUSED", "Authentication challenge has already been used.");
    if (stored.expiresAt <= currentTime) throw new ApiError(401, "AUTH_CHALLENGE_EXPIRED", "Authentication challenge has expired.");
    if (stored.wallet !== normalizedWallet || stored.chainId !== selectedChainId || stored.purpose !== normalizedPurpose || stored.domain !== this.config.authDomain || stored.uri !== this.config.authUri) {
      throw new ApiError(401, "AUTH_CHALLENGE_MISMATCH", "Authentication challenge does not match this request.");
    }

    const expectedMessage = createAuthMessage({
      domain: stored.domain,
      uri: stored.uri,
      wallet: stored.wallet,
      chainId: stored.chainId,
      nonce: normalizedNonce,
      issuedAt: stored.issuedAt,
      expiresAt: stored.expiresAt,
      purpose: stored.purpose,
    });
    if (typeof message !== "string" || message !== expectedMessage) throw new ApiError(401, "AUTH_MESSAGE_MISMATCH", "Authentication message does not match the issued challenge.");

    let recoveredWallet;
    try {
      recoveredWallet = getAddress(verifyMessage(expectedMessage, signatureValue(signature))).toLowerCase();
    } catch {
      throw new ApiError(401, "AUTH_INVALID_SIGNATURE", "Wallet signature could not be verified.");
    }
    if (recoveredWallet !== stored.wallet) throw new ApiError(401, "AUTH_WALLET_MISMATCH", "Wallet signature does not match the challenged wallet.");

    try {
      await this.repository.consumeNonce({
        nonceHash,
        wallet: stored.wallet,
        chainId: stored.chainId,
        domain: stored.domain,
        uri: stored.uri,
        purpose: stored.purpose,
      });
    } catch (error) {
      if (error?.code === "CONFLICT") throw new ApiError(401, "AUTH_CHALLENGE_REUSED", "Authentication challenge has already been used.");
      throw error;
    }

    const sessionToken = requiredText(this.sessionTokenGenerator(), "auth.sessionToken", { max: 128 });
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(sessionToken)) throw new Error("Session token generator returned an invalid token.");
    const sessionHash = hashSecret(sessionToken);
    const sessionIssuedAt = currentTime;
    const sessionExpiresAt = new Date(sessionIssuedAt.getTime() + this.config.authSessionTtlSeconds * 1000);
    await this.repository.createAuthSession({
      sessionHash,
      wallet: stored.wallet,
      chainId: stored.chainId,
      purpose: stored.purpose,
      issuedAt: sessionIssuedAt,
      expiresAt: sessionExpiresAt,
      requestId,
    });
    return { token: sessionToken, wallet: stored.wallet, chainId: stored.chainId, purpose: stored.purpose, issuedAt: sessionIssuedAt.toISOString(), expiresAt: sessionExpiresAt.toISOString() };
  }

  async authenticate(request = {}) {
    const sessionHash = hashSecret(bearerToken(request.headers));
    const session = await this.repository.getActiveAuthSession({ sessionHash });
    if (!session) throw new ApiError(401, "UNAUTHORIZED", "Wallet authentication session is invalid or expired.");
    try {
      return {
        wallet: walletAddress(session.wallet_address, "session.wallet"),
        chainId: chainId(session.chain_id, "session.chainId"),
        purpose: requirePurpose(session.purpose),
        expiresAt: isoTimestamp(session.expires_at),
      };
    } catch {
      throw new ApiError(401, "UNAUTHORIZED", "Wallet authentication session is invalid or expired.");
    }
  }
}

export function createWalletAuthenticator(authService) {
  if (!authService?.authenticate) throw new TypeError("A WalletAuthService is required.");
  return (request) => authService.authenticate(request);
}

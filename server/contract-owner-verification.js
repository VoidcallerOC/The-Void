import { randomUUID } from "node:crypto";
import { verifyMessage } from "ethers";
import { ApiError } from "./api-errors.js";
import { createSecureNonce } from "./auth.js";
import { requiredText, walletAddress } from "./validation.js";
import { LEGACY_CHAIN_ID, LEGACY_CONTRACT } from "../src/lib/legacy-genesis.js";

const OWNER_SELECTOR = "0x8da5cb5b";
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const SNOWTRACE = "https://snowtrace.io/address/";

export const CONTRACT_OWNER_ARTISTS = Object.freeze({
  voidcaller: Object.freeze({ slug: "voidcaller", contract: LEGACY_CONTRACT, chainId: LEGACY_CHAIN_ID }),
});

export function resolveClaimableArtist(slug) {
  const key = String(slug || "").trim().toLowerCase();
  return CONTRACT_OWNER_ARTISTS[key] || null;
}

function decodeAddress(hex) {
  const body = String(hex || "").replace(/^0x/, "").toLowerCase();
  if (body.length !== 64 || !/^[0-9a-f]+$/.test(body)) throw new Error("invalid owner encoding");
  return `0x${body.slice(24)}`;
}

export function createClaimMessage({ slug, contract, chainId, nonce, expiresAt }) {
  return [
    "The Void — verify artist control of the original collection.",
    `Artist: ${slug}`,
    `Contract: ${contract}`,
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Expires: ${expiresAt}`,
    "This signature spends no gas and sends no transaction.",
  ].join("\n");
}

export function verifyPersonalSign({ address, message, signature }) {
  const recovered = verifyMessage(message, signature);
  return recovered.toLowerCase() === String(address).toLowerCase();
}

function signatureMatchesChallenge({ address, message, signature }) {
  try {
    return verifyPersonalSign({ address, message, signature });
  } catch {
    return false;
  }
}

export class MainnetOwnerReader {
  constructor({ rpcUrl, fetchImpl = fetch, timeoutMs = 8_000 } = {}) {
    this.rpcUrl = String(rpcUrl || "").trim();
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async ownerOf(contract) {
    if (!this.rpcUrl) throw new ApiError(503, "MAINNET_RPC_UNAVAILABLE", "MAINNET_RPC_URL is not configured.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ to: contract, data: OWNER_SELECTOR }, "latest"],
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`rpc http ${response.status}`);
      const body = await response.json();
      if (body.error) throw new Error(body.error.message || "rpc error");
      return decodeAddress(body.result);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, "MAINNET_RPC_UNAVAILABLE", "Mainnet owner() lookup failed closed.");
    } finally {
      clearTimeout(timer);
    }
  }
}

export class ContractOwnerVerificationService {
  constructor({ db, config, ownerReader = null, now = () => new Date() } = {}) {
    if (!db?.query) throw new TypeError("ContractOwnerVerificationService requires a database executor.");
    this.db = db;
    this.config = config || {};
    this.ownerReader = ownerReader || new MainnetOwnerReader({ rpcUrl: this.config.mainnetRpcUrl });
    this.now = now;
  }

  async getStatus({ slug }) {
    const artist = resolveClaimableArtist(slug);
    if (!artist) throw new ApiError(404, "ARTIST_NOT_FOUND", "Artist was not found.");
    const { rows } = await this.db.query(
      "SELECT wallet_address, contract_address, chain_id, verified_at FROM artist_contract_verifications WHERE artist_slug=$1 AND contract_address=$2 AND chain_id=$3 LIMIT 1",
      [artist.slug, artist.contract, artist.chainId],
    );
    const row = rows[0];
    return {
      slug: artist.slug,
      verified: Boolean(row),
      contract: artist.contract,
      chainId: artist.chainId,
      wallet: row?.wallet_address || null,
      verifiedAt: row?.verified_at || null,
      snowtrace: `${SNOWTRACE}${artist.contract}`,
    };
  }

  async createChallenge({ slug }) {
    const artist = resolveClaimableArtist(slug);
    if (!artist) throw new ApiError(404, "ARTIST_NOT_FOUND", "Artist was not found.");
    const nonce = createSecureNonce();
    const issued = this.now();
    const expiresAt = new Date(issued.getTime() + CHALLENGE_TTL_MS).toISOString();
    const message = createClaimMessage({ slug: artist.slug, contract: artist.contract, chainId: artist.chainId, nonce, expiresAt });
    await this.db.query(
      "INSERT INTO artist_contract_verify_challenges (nonce, artist_slug, contract_address, chain_id, message, expires_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [nonce, artist.slug, artist.contract, artist.chainId, message, expiresAt],
    );
    return { nonce, message, slug: artist.slug, contract: artist.contract, chainId: artist.chainId, expiresAt };
  }

  async verifyClaim({ slug, address, signature, nonce }) {
    const artist = resolveClaimableArtist(slug);
    if (!artist) throw new ApiError(404, "ARTIST_NOT_FOUND", "Artist was not found.");
    const wallet = walletAddress(address, "address");
    const sig = requiredText(signature, "signature", { max: 132 });
    const challengeNonce = requiredText(nonce, "nonce", { max: 128 });
    const { rows } = await this.db.query(
      "SELECT nonce, message, expires_at, used_at FROM artist_contract_verify_challenges WHERE nonce=$1 AND artist_slug=$2 LIMIT 1",
      [challengeNonce, artist.slug],
    );
    const live = rows[0];
    if (!live) throw new ApiError(401, "INVALID_SIGNATURE", "Signature does not match a live challenge for this artist.");
    if (live.used_at) throw new ApiError(409, "NONCE_REUSED", "This verification challenge was already used.");
    if (new Date(live.expires_at).getTime() <= this.now().getTime()) throw new ApiError(401, "CHALLENGE_EXPIRED", "Verification challenge has expired.");
    if (!signatureMatchesChallenge({ address: wallet, message: live.message, signature: sig })) {
      throw new ApiError(401, "INVALID_SIGNATURE", "Signature does not match a live challenge for this artist.");
    }
    const consumed = await this.db.query(
      "UPDATE artist_contract_verify_challenges SET used_at=$1 WHERE nonce=$2 AND used_at IS NULL RETURNING nonce",
      [this.now().toISOString(), live.nonce],
    );
    if (!consumed.rows[0]) throw new ApiError(409, "NONCE_REUSED", "This verification challenge was already used.");
    const onChainOwner = await this.ownerReader.ownerOf(artist.contract);
    if (onChainOwner.toLowerCase() !== wallet.toLowerCase()) {
      throw new ApiError(403, "NOT_CONTRACT_OWNER", "Signer is not the on-chain owner() of the legacy collection.");
    }
    const id = randomUUID();
    const verifiedAt = this.now().toISOString();
    await this.db.query(
      "INSERT INTO artist_contract_verifications (id, artist_slug, wallet_address, contract_address, chain_id, signature, message, verified_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (artist_slug, contract_address, chain_id) DO NOTHING",
      [id, artist.slug, wallet, artist.contract, artist.chainId, sig, live.message, verifiedAt],
    );
    const persisted = await this.db.query(
      "SELECT id, wallet_address, verified_at FROM artist_contract_verifications WHERE artist_slug=$1 AND contract_address=$2 AND chain_id=$3 LIMIT 1",
      [artist.slug, artist.contract, artist.chainId],
    );
    const row = persisted.rows[0];
    if (!row) throw new ApiError(500, "VERIFICATION_PERSIST_FAILED", "Verification record could not be read after insert.");
    return { verified: true, slug: artist.slug, wallet: row.wallet_address, contract: artist.contract, chainId: artist.chainId, verifiedAt: row.verified_at, snowtrace: `${SNOWTRACE}${artist.contract}` };
  }
}

export function createContractOwnerVerificationService(options) {
  return new ContractOwnerVerificationService(options);
}

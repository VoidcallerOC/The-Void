import { ApiError } from "./api-errors.js";
import { chainId, nonNegativeBigInt, requiredText, walletAddress } from "./validation.js";
import { isLegacyMainnetRequirement } from "../src/lib/legacy-genesis.js";
import { createMainnetBalanceClient, verifyLegacyMainnetOwnership } from "./legacy-ownership.js";

const SUPPORTED_REQUIREMENT = "erc1155-balance";

function parseRequirements(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || "[]"));
    if (!Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new ApiError(500, "EXPERIENCE_REQUIREMENTS_INVALID", "Experience ownership requirements are invalid.");
  }
}

function contractAddress(value) {
  const address = requiredText(value, "requirement.contract", { max: 42 }).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new ApiError(400, "EXPERIENCE_REQUIREMENT_INVALID", "Experience requirement contract must be an EVM address.");
  return address;
}

function normalizeRequirement(input, fallbackChainId) {
  if (!input || typeof input !== "object" || Array.isArray(input) || String(input.type || "").toLowerCase() !== SUPPORTED_REQUIREMENT) {
    throw new ApiError(400, "EXPERIENCE_REQUIREMENT_UNSUPPORTED", "Only ERC-1155 balance experience requirements are supported.");
  }
  const tokenIds = Array.isArray(input.tokenIds) ? [...new Set(input.tokenIds.map((item) => nonNegativeBigInt(item, "requirement.tokenIds")))] : [];
  if (!tokenIds.length) throw new ApiError(400, "EXPERIENCE_REQUIREMENT_INVALID", "An ERC-1155 experience requirement needs at least one token ID.");
  const selectedChainId = input.chainId === undefined || input.chainId === null ? fallbackChainId : chainId(input.chainId, "requirement.chainId");
  return { type: SUPPORTED_REQUIREMENT, contract: contractAddress(input.contract), tokenIds, minAmount: nonNegativeBigInt(input.minAmount ?? 1, "requirement.minAmount"), chainId: selectedChainId };
}

function mediaIsProtected(mediaConfig) {
  let config = mediaConfig;
  if (typeof config === "string") {
    try { config = JSON.parse(config); } catch { return true; }
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) return false;
  if (config.protected === true) return true;
  return Array.isArray(config.protectedMedia) && config.protectedMedia.length > 0;
}

// Freshness is judged against the last run that completed successfully. The
// indexer writes the current chain head into `latest_known_block` when a run
// starts, before `last_processed_block` moves, so while a row is RUNNING those
// two columns describe different runs and their difference is not an indexing
// lag. A run that completed ended at head minus confirmations, so its lag was
// within bounds by construction; what still matters while the next run is in
// flight is how long ago that completion happened. A checkpoint that has never
// completed a run successfully is stale no matter how recently it was written.
function checkpointFresh(row, { maxLagBlocks, maxStalenessMs, now }) {
  const status = String(row?.status || "").toUpperCase();
  if (!row || !["IDLE", "RUNNING"].includes(status)) return false;
  const successfulAt = row.last_successful_run_at ? new Date(row.last_successful_run_at).getTime() : NaN;
  if (!Number.isFinite(successfulAt) || successfulAt <= 0 || now().getTime() - successfulAt > maxStalenessMs) return false;
  if (status === "RUNNING") return true;
  // A missing progress column is not block 0: a row that cannot state its own lag is not fresh.
  const block = (value) => (value === null || value === undefined || value === "" ? NaN : Number(value));
  const latest = block(row.latest_known_block);
  const current = block(row.last_processed_block);
  return Number.isSafeInteger(latest) && Number.isSafeInteger(current) && latest - current <= maxLagBlocks;
}

/**
 * Resolves access from canonical, finalized ownership snapshots. A stale or
 * reorganizing index deliberately fails closed; browser-reported balances are
 * never part of this decision.
 */
export class IndexedOwnershipVerifier {
  constructor({ db, config, now = () => new Date(), mainnetClient = null, denyUnauthorizedWith401 = true } = {}) {
    if (!db?.query) throw new TypeError("IndexedOwnershipVerifier requires a database executor.");
    if (!config?.ownershipMaxIndexerLagBlocks || !config?.ownershipMaxIndexerStalenessMs || !Array.isArray(config.authAllowedChainIds)) throw new TypeError("IndexedOwnershipVerifier requires server ownership configuration.");
    this.db = db;
    this.config = config;
    this.now = now;
    this.mainnetClient = mainnetClient || (config.mainnetRpcUrl ? createMainnetBalanceClient({ rpcUrl: config.mainnetRpcUrl }) : null);
    this.denyUnauthorizedWith401 = denyUnauthorizedWith401;
  }

  async assertCheckpoint({ chainId: selectedChainId, contract }) {
    const { rows } = await this.db.query(
      "SELECT status, last_processed_block, latest_known_block, last_successful_run_at, updated_at FROM indexer_checkpoints WHERE chain_id=$1 AND contract_address=$2 LIMIT 1",
      [selectedChainId, contract],
    );
    if (!checkpointFresh(rows[0], { maxLagBlocks: this.config.ownershipMaxIndexerLagBlocks, maxStalenessMs: this.config.ownershipMaxIndexerStalenessMs, now: this.now })) {
      throw new ApiError(503, "OWNERSHIP_INDEX_STALE", "Ownership verification is temporarily unavailable while the canonical index catches up.");
    }
  }

  async verify({ wallet, experienceId = null, requirements, mediaConfig = null }) {
    const normalizedWallet = walletAddress(wallet);
    const parsed = parseRequirements(requirements);
    if (!parsed.length) {
      if (mediaIsProtected(mediaConfig)) return { owns: false, state: "CONFIRMED", chainId: null, watermark: null, experienceId };
      return { owns: true, state: "CONFIRMED", chainId: null, watermark: "NO_REQUIREMENT", experienceId };
    }

    const matches = [];
    for (const source of parsed) {
      const requirement = normalizeRequirement(source, this.config.authAllowedChainIds[0]);
      if (isLegacyMainnetRequirement(requirement)) {
        if (!this.mainnetClient) throw new ApiError(503, "MAINNET_RPC_UNAVAILABLE", "MAINNET_RPC_URL is not configured.");
        const live = await verifyLegacyMainnetOwnership({ requirement, wallet: normalizedWallet, client: this.mainnetClient, experienceId });
        if (!live.owns && this.denyUnauthorizedWith401) throw new ApiError(401, "UNAUTHORIZED", "Wallet does not hold the required legacy token.");
        if (!live.owns) return live;
        matches.push({ chainId: live.chainId, watermark: live.watermark, tokenId: "legacy" });
        continue;
      }
      if (!this.config.authAllowedChainIds.includes(requirement.chainId)) throw new ApiError(400, "EXPERIENCE_REQUIREMENT_INVALID", "Experience requirement chain is not enabled for this environment.");
      await this.assertCheckpoint({ chainId: requirement.chainId, contract: requirement.contract });
      const { rows } = await this.db.query(
        "SELECT token_id, amount, synchronization_watermark FROM ownership_snapshots WHERE chain_id=$1 AND contract_address=$2 AND wallet_address=$3 AND token_id = ANY($4::numeric[]) AND amount >= $5::numeric AND synchronization_watermark <> 'REORG_PENDING' ORDER BY token_id ASC LIMIT 1",
        [requirement.chainId, requirement.contract, normalizedWallet, requirement.tokenIds, requirement.minAmount],
      );
      if (!rows[0]) return { owns: false, state: "CONFIRMED", chainId: requirement.chainId, watermark: null, experienceId };
      matches.push({ chainId: requirement.chainId, watermark: rows[0].synchronization_watermark, tokenId: String(rows[0].token_id) });
    }
    return { owns: true, state: "CONFIRMED", chainId: matches[0].chainId, watermark: matches.map((item) => `${item.chainId}:${item.tokenId}:${item.watermark}`).join("|"), experienceId, source: matches[0].tokenId === "legacy" ? "mainnet-rpc" : "indexer" };
  }
}

export function createIndexedOwnershipVerifier(options) {
  const verifier = new IndexedOwnershipVerifier(options);
  return (input) => verifier.verify(input);
}

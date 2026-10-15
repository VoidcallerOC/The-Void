import { releaseDeploymentForFactory } from "../../config/release-network.js";
import { FUJI_RELEASE_CONFIG, isCertifiedFujiEdition } from "./fuji-release.js";
import { CHAINS, RELIC_TOKEN_IDS } from "./web3.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TOKEN_ID = /^\d+$/;
const UNPUBLISHED_STATUSES = new Set(["draft", "archived"]);
const lower = (value) => String(value || "").trim().toLowerCase();

const FUJI_CHAIN = Object.freeze({
  key: "fuji",
  id: FUJI_RELEASE_CONFIG.chainId,
  hexId: FUJI_RELEASE_CONFIG.chainHexId,
  name: FUJI_RELEASE_CONFIG.networkName,
  short: "FUJI",
  rpc: FUJI_RELEASE_CONFIG.rpcUrl,
  explorer: FUJI_RELEASE_CONFIG.explorer,
  token: "AVAX",
  contract: FUJI_RELEASE_CONFIG.contractAddress,
});

/**
 * A per-release factory clone edition whose balance may be read: on the active release chain, served
 * from the release contract a recorded factory deployment created (the factory must be known, so an
 * arbitrary contract named by a catalog row is never queried). The legacy shared contract keeps its
 * own path (isCertifiedFujiEdition) and is not a clone.
 */
export function isCertifiedReleaseCloneEdition(edition) {
  if (!edition || Number(edition.chainId) !== FUJI_RELEASE_CONFIG.chainId) return false;
  if (UNPUBLISHED_STATUSES.has(lower(edition.status))) return false;
  const contract = lower(edition.contractAddress);
  if (!ADDRESS.test(contract) || isCertifiedFujiEdition(edition)) return false;
  const deployment = releaseDeploymentForFactory(edition.factoryAddress);
  if (!deployment || Number(deployment.chainId) !== FUJI_RELEASE_CONFIG.chainId) return false;
  return lower(edition.releaseContractAddress || contract) === contract;
}

export function buildMarketplaceOwnershipConfig(editions = []) {
  const tokenIds = [...new Set(
    (Array.isArray(editions) ? editions : [])
      .filter(isCertifiedFujiEdition)
      .flatMap((edition) => Array.isArray(edition.tokenIds) ? edition.tokenIds : [])
      .map((tokenId) => String(tokenId).trim())
      .filter((tokenId) => /^\d+$/.test(tokenId)),
  )];

  // Exact (chain, contract, tokenId) tuples for editions on per-release clones. Distinct releases can
  // share a title or even a token ID, so identity is the tuple, never the title.
  const assets = [];
  const seen = new Set();
  for (const edition of Array.isArray(editions) ? editions : []) {
    if (!isCertifiedReleaseCloneEdition(edition)) continue;
    for (const tokenId of Array.isArray(edition.tokenIds) ? edition.tokenIds : []) {
      const id = String(tokenId).trim();
      const key = `${lower(edition.contractAddress)}:${id}`;
      if (!TOKEN_ID.test(id) || seen.has(key)) continue;
      seen.add(key);
      assets.push({ chainKey: "fuji", chainId: FUJI_RELEASE_CONFIG.chainId, contract: lower(edition.contractAddress), tokenId: id });
    }
  }

  return {
    chains: {
      ...CHAINS,
      fuji: { ...FUJI_CHAIN, tokenIds },
    },
    tokenIds: RELIC_TOKEN_IDS,
    assets,
  };
}

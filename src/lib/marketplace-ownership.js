import { FUJI_RELEASE_CONFIG, isCertifiedFujiEdition } from "./fuji-release.js";
import { CHAINS, RELIC_TOKEN_IDS } from "./web3.js";

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

export function buildMarketplaceOwnershipConfig(editions = []) {
  const tokenIds = [...new Set(
    (Array.isArray(editions) ? editions : [])
      .filter(isCertifiedFujiEdition)
      .flatMap((edition) => Array.isArray(edition.tokenIds) ? edition.tokenIds : [])
      .map((tokenId) => String(tokenId).trim())
      .filter((tokenId) => /^\d+$/.test(tokenId)),
  )];

  return {
    chains: {
      ...CHAINS,
      fuji: { ...FUJI_CHAIN, tokenIds },
    },
    tokenIds: RELIC_TOKEN_IDS,
  };
}

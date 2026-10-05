import { LEGACY_CHAIN_ID, LEGACY_CONTRACT, LEGACY_TOKENS } from "./legacy-genesis.js";
import { CHAINS, checkCollectionOwnership } from "./web3.js";

export const CLAIM_ELIGIBLE_TOKEN_IDS = Object.freeze(LEGACY_TOKENS.map(({ tokenId }) => Number(tokenId)));

const CLAIM_OWNERSHIP_CONFIG = Object.freeze({
  chains: Object.freeze({
    cchain: Object.freeze({
      ...CHAINS.cchain,
      id: LEGACY_CHAIN_ID,
      contract: LEGACY_CONTRACT,
      tokenIds: CLAIM_ELIGIBLE_TOKEN_IDS,
    }),
  }),
  tokenIds: CLAIM_ELIGIBLE_TOKEN_IDS,
  throwOnError: true,
});

/** Resolve claim access from live ERC-1155 balances of the canonical main collection only. */
export async function checkMainCollectionEligibility(account, { ownershipReader = checkCollectionOwnership } = {}) {
  if (!account) {
    const error = new Error("Connect a wallet before checking claim access.");
    error.code = "WALLET_REQUIRED";
    throw error;
  }

  const owned = await ownershipReader(account, CLAIM_OWNERSHIP_CONFIG);
  const cchainOwnership = owned?.cchain;
  if (!cchainOwnership || typeof cchainOwnership.has !== "function") {
    const error = new Error("The main collection ownership read returned no verifiable result.");
    error.code = "OWNERSHIP_READ_FAILED";
    throw error;
  }

  const ownedTokenIds = CLAIM_ELIGIBLE_TOKEN_IDS.filter((tokenId) => (
    cchainOwnership.has(tokenId) || cchainOwnership.has(String(tokenId))
  ));
  return { eligible: ownedTokenIds.length > 0, ownedTokenIds };
}

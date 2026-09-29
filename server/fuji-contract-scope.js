import { ethers } from "ethers";
import deployment from "../config/fuji-release.json" with { type: "json" };

export const CANONICAL_FUJI_CHAIN_ID = Number(deployment.chainId);
export const CANONICAL_FUJI_RELEASE = String(deployment.contractAddress).toLowerCase();
export const LEGACY_FUJI_V1_RELEASE = String(deployment.legacyV1?.contractAddress || "0x262B774cf9a1949170B58E2d57F6189980FE757b").toLowerCase();
export const C_CHAIN_VOIDCALLER_COLLECTION = String(deployment.outOfScope?.cChainVoidcallerCollection || "0xd1b4367dd9f235f9ee61878019d66e31511e98ee").toLowerCase();

export function isCanonicalFujiRelease(address) {
  return Boolean(address) && String(address).toLowerCase() === CANONICAL_FUJI_RELEASE;
}

export function isLegacyFujiV1Release(address) {
  return Boolean(address) && String(address).toLowerCase() === LEGACY_FUJI_V1_RELEASE;
}

export function isOutOfScopeCChainCollection(address) {
  return Boolean(address) && String(address).toLowerCase() === C_CHAIN_VOIDCALLER_COLLECTION;
}

/**
 * Join tokens for an edition only when the token belongs to the canonical
 * Fuji release contract. V1 and C-Chain rows stay in the table but are not
 * selected as the active Studio publication token.
 */
export function certifiedTokenJoinSql({ tokenAlias = "t", editionAlias = "e", contractParam = 2, chainParam = 3 } = {}) {
  return `${tokenAlias} ON ${tokenAlias}.edition_id=${editionAlias}.id AND ${tokenAlias}.contract_id IN (SELECT id FROM contracts WHERE lower(address)=$${contractParam} AND chain_id=$${chainParam})`;
}

export function certifiedContractParams() {
  return [CANONICAL_FUJI_RELEASE, CANONICAL_FUJI_CHAIN_ID];
}

export function selectCertifiedEditionToken(tokens = [], { contractAddress = CANONICAL_FUJI_RELEASE, chainId = CANONICAL_FUJI_CHAIN_ID } = {}) {
  const wanted = String(contractAddress).toLowerCase();
  const matches = (tokens || []).filter((row) => String(row.contract_address || row.contractAddress || "").toLowerCase() === wanted && Number(row.chain_id || row.chainId) === Number(chainId));
  if (matches.length > 1) {
    throw new Error("Multiple token rows exist for the same edition on the canonical Fuji contract; refuse ambiguous selection.");
  }
  return matches[0] || null;
}

export function editionCreatedLogMatches({ log, parsed, contractAddress, expectedTokenId, expectedReleaseId, expectedEditionId, expectedMetadataUri }) {
  if (!parsed || parsed.name !== "EditionCreated") return false;
  if (!log?.address || !ethers.isAddress(log.address)) return false;
  if (ethers.getAddress(log.address) !== ethers.getAddress(contractAddress)) return false;
  if (parsed.args.tokenId !== expectedTokenId) return false;
  if (parsed.args.releaseId !== expectedReleaseId) return false;
  if (parsed.args.editionId !== expectedEditionId) return false;
  if (expectedMetadataUri !== undefined && parsed.args.metadataUri !== expectedMetadataUri) return false;
  return true;
}

export function reuseExistingMetadataForCertifiedToken({ existingToken, certifiedToken, metadataUri, metadata, metadataVersion }) {
  if (certifiedToken?.metadata_uri) {
    return { action: "keep-certified", token: certifiedToken };
  }
  if (!metadataUri && !existingToken?.metadata_uri) {
    return { action: "missing-metadata", token: null };
  }
  return {
    action: "clone-metadata-to-certified",
    token: {
      metadata_uri: metadataUri || existingToken.metadata_uri,
      metadata: metadata || existingToken.metadata || null,
      metadata_version: metadataVersion || existingToken.metadata_version || null,
      source_contract_address: existingToken?.contract_address || existingToken?.contractAddress || null,
    },
  };
}

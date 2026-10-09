import { ethers } from "ethers";
import { FUJI_RELEASE_FACTORY_V2_CONFIG } from "./fuji-release.js";

export const CLAIM_STATES = Object.freeze({
  WALLET_DISCONNECTED: "wallet-disconnected",
  WALLET_CONNECTED: "wallet-connected",
  WRONG_NETWORK: "wrong-network",
  ELIGIBLE: "eligible",
  NOT_ELIGIBLE: "not-eligible",
  CLAIM_AVAILABLE: "claim-available",
  CLAIMING: "claiming",
  TRANSACTION_PENDING: "transaction-pending",
  CLAIM_CONFIRMED: "claim-confirmed",
  ALREADY_CLAIMED: "already-claimed",
  SOLD_OUT: "sold-out",
  RELEASE_UNAVAILABLE: "release-unavailable",
  INVALID_RELEASE_BINDING: "invalid-release-binding",
  ERROR: "error",
});

// This is intentionally kept separate from the legacy shared contract. A claim
// page must never turn an incomplete release binding into a singleton fallback.
const LEGACY_FUJI_SINGLETON = "0x7bba0690a43e2ffe9ad553fbda0451177b7b95b6";

export function releaseBindingFor(edition) {
  const releaseContractAddress = String(edition?.releaseContractAddress || edition?.contractAddress || "").trim();
  const primarySaleAddress = String(edition?.primarySaleAddress || "").trim();
  const tokenId = edition?.tokenIds?.[0];
  const chainId = Number(edition?.chainId);
  const architecture = String(edition?.publicationArchitecture || edition?.releaseArchitecture || "release-per-contract").trim().toLowerCase();
  const addressLooksValid = ethers.isAddress(releaseContractAddress) && ethers.getAddress(releaseContractAddress) !== ethers.ZeroAddress;
  const saleLooksValid = ethers.isAddress(primarySaleAddress) && ethers.getAddress(primarySaleAddress) !== ethers.ZeroAddress;
  const tokenLooksValid = tokenId !== undefined && tokenId !== null && /^\d+$/.test(String(tokenId));
  const isLegacySingleton = releaseContractAddress.toLowerCase() === LEGACY_FUJI_SINGLETON;
  const factoryAddress = String(edition?.factoryAddress || "").trim();
  const factoryMatches = factoryAddress.length > 0
    && factoryAddress.toLowerCase() === String(FUJI_RELEASE_FACTORY_V2_CONFIG.factoryAddress || "").toLowerCase();
  const valid = architecture === "release-per-contract"
    && chainId === FUJI_RELEASE_FACTORY_V2_CONFIG.chainId
    && addressLooksValid
    && saleLooksValid
    && tokenLooksValid
    && !isLegacySingleton
    && factoryMatches;
  return Object.freeze({
    valid,
    architecture,
    chainId,
    releaseContractAddress,
    primarySaleAddress,
    tokenId: tokenLooksValid ? String(tokenId) : null,
    factoryAddress,
    reason: !valid ? "This release has no valid factory-created release contract binding. Claim is closed." : "",
  });
}

export function claimState({ edition, walletConnected = false, chainId = null, balance = null, executorAvailable = false, error = "" } = {}) {
  const binding = releaseBindingFor(edition);
  if (error) return { state: CLAIM_STATES.ERROR, binding, message: error };
  if (!binding.valid) return { state: CLAIM_STATES.INVALID_RELEASE_BINDING, binding, message: binding.reason };
  if (!walletConnected) return { state: CLAIM_STATES.WALLET_DISCONNECTED, binding, message: "Connect a wallet to check this release." };
  if (Number(chainId) !== binding.chainId) return { state: CLAIM_STATES.WRONG_NETWORK, binding, message: `Switch your wallet to ${FUJI_RELEASE_FACTORY_V2_CONFIG.networkName} (chain ${binding.chainId}).` };
  if (balance !== null && balance !== undefined && BigInt(balance) > 0n) return { state: CLAIM_STATES.ALREADY_CLAIMED, binding, message: "This wallet already holds this release token." };
  if (!executorAvailable) return { state: CLAIM_STATES.RELEASE_UNAVAILABLE, binding, message: "Claim is not wired for this release yet. No transaction was submitted." };
  return { state: CLAIM_STATES.CLAIM_AVAILABLE, binding, message: "This release is ready to claim." };
}

export function claimStateLabel(state) {
  return {
    [CLAIM_STATES.WALLET_DISCONNECTED]: "Wallet disconnected",
    [CLAIM_STATES.WRONG_NETWORK]: "Wrong network",
    [CLAIM_STATES.ALREADY_CLAIMED]: "Already claimed",
    [CLAIM_STATES.CLAIM_AVAILABLE]: "Claim available",
    [CLAIM_STATES.RELEASE_UNAVAILABLE]: "Release unavailable",
    [CLAIM_STATES.INVALID_RELEASE_BINDING]: "Invalid release binding",
    [CLAIM_STATES.ERROR]: "Error",
  }[state] || "Checking release";
}

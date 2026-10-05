import { ethers } from "ethers";

const releaseInterface = new ethers.Interface([
  "function balanceOf(address account,uint256 id) view returns (uint256)",
  "function paused() view returns (bool)",
]);

function requiredAddress(value, field) {
  const source = String(value || "").trim();
  if (!ethers.isAddress(source) || ethers.getAddress(source) === ethers.ZeroAddress) throw new Error(`${field} must be a non-zero EVM address.`);
  return ethers.getAddress(source);
}

function requiredChainId(value) {
  const selected = Number(value);
  if (!Number.isSafeInteger(selected) || selected <= 0) throw new Error("chainId must be a positive integer.");
  return selected;
}

function requiredTokenId(value) {
  try {
    const tokenId = BigInt(value);
    if (tokenId < 0n) throw new Error();
    return tokenId;
  } catch {
    throw new Error("tokenId must be a non-negative integer.");
  }
}

/**
 * The exact identity required by Collect, ownership, and protected-media paths
 * for a newly independent release. Numeric token IDs are never sufficient alone.
 */
export function releaseAssetIdentity({ chainId, releaseContractAddress, primarySaleAddress, tokenId } = {}) {
  return Object.freeze({
    chainId: requiredChainId(chainId),
    releaseContractAddress: requiredAddress(releaseContractAddress, "releaseContractAddress"),
    primarySaleAddress: requiredAddress(primarySaleAddress, "primarySaleAddress"),
    tokenId: requiredTokenId(tokenId),
  });
}

export async function assertReleaseProvider(provider, targetChainId) {
  if (!provider || typeof provider.request !== "function") throw new Error("A wallet provider is required.");
  const rawChainId = await provider.request({ method: "eth_chainId" });
  const currentChainId = Number(BigInt(rawChainId));
  if (currentChainId !== Number(targetChainId)) {
    const error = new Error(`Switch the wallet to chain ${targetChainId} before collecting this release.`);
    error.code = "CHAIN_MISMATCH";
    error.expectedChainId = Number(targetChainId);
    error.currentChainId = currentChainId;
    throw error;
  }
}

export async function readReleaseBalance(provider, releaseAsset, account) {
  const target = releaseAssetIdentity(releaseAsset);
  if (!ethers.isAddress(account)) throw new Error("A wallet address is required.");
  await assertReleaseProvider(provider, target.chainId);
  const data = releaseInterface.encodeFunctionData("balanceOf", [account, target.tokenId]);
  const result = await provider.request({ method: "eth_call", params: [{ to: target.releaseContractAddress, data }, "latest"] });
  return BigInt(releaseInterface.decodeFunctionResult("balanceOf", result)[0]);
}

export async function readReleasePaused(provider, releaseAsset) {
  const target = releaseAssetIdentity(releaseAsset);
  await assertReleaseProvider(provider, target.chainId);
  const data = releaseInterface.encodeFunctionData("paused", []);
  const result = await provider.request({ method: "eth_call", params: [{ to: target.releaseContractAddress, data }, "latest"] });
  return Boolean(releaseInterface.decodeFunctionResult("paused", result)[0]);
}

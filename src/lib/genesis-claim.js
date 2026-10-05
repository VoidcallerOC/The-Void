import { BrowserProvider, Contract, Interface, isAddress, getAddress } from "ethers";
import { readReleaseBalance, assertReleaseProvider } from "./release-asset.js";

const API_ORIGIN = String(import.meta.env?.VITE_API_ORIGIN || "").replace(/\/$/, "");
const CLAIM_INTERFACE = new Interface([
  "function hasClaimed(address claimant) view returns (bool)",
  "function claim((address claimant,address genesisContract,uint256 genesisChainId,bytes32 eligibilityRule,uint256 destinationChainId,address releaseContract,uint256 tokenId,uint256 quantity,uint256 allocation,uint256 nonce,uint256 deadline) voucher,bytes signature)",
]);

async function apiRequest(path, { fetchImpl = fetch, method = "GET", body = undefined } = {}) {
  const response = await fetchImpl(`${API_ORIGIN}/api/claims/${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  let result;
  try { result = await response.json(); } catch { throw new Error("Claim service returned an unreadable response."); }
  if (!response.ok || result?.error) {
    const error = new Error(result?.error?.message || "Claim service is unavailable.");
    error.code = result?.error?.code || "CLAIM_API_ERROR";
    error.status = response.status;
    throw error;
  }
  return result.data;
}

function validateTarget(target) {
  if (!target?.enabled || !isAddress(target.claimContract) || !isAddress(target.releaseContract)) {
    throw new Error("The Genesis claim target is not configured.");
  }
  const chainId = Number(target.destinationChainId);
  const tokenId = String(target.tokenId ?? "");
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || !/^\d+$/.test(tokenId)) {
    throw new Error("The claim target has an invalid chain or token binding.");
  }
  if (getAddress(target.releaseContract).toLowerCase() === "0x7bba0690a43e2ffe9ad553fbda0451177b7b95b6") {
    throw new Error("The legacy Fuji V2 singleton is not a valid Genesis claim target.");
  }
  return { ...target, destinationChainId: chainId, tokenId };
}

export function fetchGenesisClaimConfig(options = {}) {
  return apiRequest("config", options).then(validateTarget);
}

export function checkGenesisEligibility(wallet, options = {}) {
  if (!isAddress(wallet)) throw new Error("A connected claimant wallet is required.");
  return apiRequest("eligibility", { ...options, method: "POST", body: { wallet: getAddress(wallet) } });
}

export function requestGenesisVoucher(wallet, options = {}) {
  if (!isAddress(wallet)) throw new Error("A connected claimant wallet is required.");
  return apiRequest("vouchers", { ...options, method: "POST", body: { wallet: getAddress(wallet) } });
}

export async function readGenesisClaimed(provider, target, wallet) {
  const binding = validateTarget(target);
  await assertReleaseProvider(provider, binding.destinationChainId);
  const data = CLAIM_INTERFACE.encodeFunctionData("hasClaimed", [getAddress(wallet)]);
  const result = await provider.request({ method: "eth_call", params: [{ to: binding.claimContract, data }, "latest"] });
  return Boolean(CLAIM_INTERFACE.decodeFunctionResult("hasClaimed", result)[0]);
}

export async function confirmGenesisClaim({ send, waitForReceipt, verifyOwnership, quantity }) {
  const transaction = await send();
  const receipt = await waitForReceipt(transaction);
  if (!receipt || Number(receipt.status) !== 1) {
    const error = new Error("The claim transaction was not confirmed successfully.");
    error.code = "CLAIM_TRANSACTION_FAILED";
    throw error;
  }
  const balance = await verifyOwnership();
  if (BigInt(balance) < BigInt(quantity)) {
    const error = new Error("The receipt confirmed, but release-token ownership could not be verified.");
    error.code = "POST_CLAIM_OWNERSHIP_UNVERIFIED";
    error.transactionHash = receipt.hash;
    throw error;
  }
  return Object.freeze({ transactionHash: receipt.hash || transaction.hash, receipt, balance: BigInt(balance) });
}

export async function executeGenesisClaim(provider, target, voucher, signature) {
  const binding = validateTarget(target);
  await assertReleaseProvider(provider, binding.destinationChainId);
  if (!voucher || getAddress(voucher.claimant) === "0x0000000000000000000000000000000000000000") {
    throw new Error("The signed voucher has no claimant.");
  }
  if (getAddress(voucher.releaseContract) !== getAddress(binding.releaseContract)
    || String(voucher.destinationChainId) !== String(binding.destinationChainId)
    || String(voucher.tokenId) !== binding.tokenId) {
    const error = new Error("The voucher does not match the configured release target.");
    error.code = "INVALID_RELEASE_BINDING";
    throw error;
  }
  const browserProvider = new BrowserProvider(provider);
  const walletSigner = await browserProvider.getSigner();
  const signerAddress = getAddress(await walletSigner.getAddress());
  if (signerAddress !== getAddress(voucher.claimant)) {
    const error = new Error("The connected wallet does not match this claim voucher.");
    error.code = "CLAIMANT_MISMATCH";
    throw error;
  }
  const contract = new Contract(binding.claimContract, CLAIM_INTERFACE, walletSigner);
  return confirmGenesisClaim({
    send: () => contract.claim(voucher, signature),
    waitForReceipt: (transaction) => transaction.wait(),
    verifyOwnership: () => readReleaseBalance(provider, {
      chainId: binding.destinationChainId,
      releaseContractAddress: binding.releaseContract,
      primarySaleAddress: binding.primarySale,
      tokenId: binding.tokenId,
    }, signerAddress),
    quantity: voucher.quantity,
  });
}

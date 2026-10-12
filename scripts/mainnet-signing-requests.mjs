import { getAddress, keccak256, toQuantity } from "ethers";
import mainnetManifest from "../config/mainnet-release-per-contract.json" with { type: "json" };

// Unsigned contract-creation requests for the owner-controlled mainnet signing flow. A key-less dry
// run builds them; the owner signs each one in Rabby with the defined deployer; the result is then
// verified from chain against the same request. No function here signs or sends anything, and no
// private key is read: a mainnet plan refuses to run while any *PRIVATE_KEY variable is set.
export const MAINNET_CHAIN_ID = 43114;
export const MAINNET_DEPLOYER = getAddress(mainnetManifest.deployerAddress);
export const MAINNET_ARTIST_WALLET = getAddress(mainnetManifest.artistWallet);
export const MAINNET_FEE_RECIPIENT = getAddress(mainnetManifest.platformRecipient);
// Gas limit sent to the wallet, over the node's estimate (percent).
export const GAS_LIMIT_HEADROOM_PERCENT = 120n;

export class SigningRequestError extends Error {}

if (new Set([MAINNET_DEPLOYER, MAINNET_ARTIST_WALLET, MAINNET_FEE_RECIPIENT]).size !== 3) {
  throw new Error("The mainnet manifest must keep the deployer, artist wallet and fee recipient distinct.");
}

/** Refuses any non-empty *PRIVATE_KEY variable: mainnet keys never enter a script environment. */
export function assertNoPrivateKeyInEnv(env, context = "Mainnet planning") {
  const present = Object.keys(env || {}).filter((name) => /PRIVATE_KEY/i.test(name) && String(env[name] ?? "").trim());
  if (present.length) {
    throw new SigningRequestError(`${context} never reads a private key, but ${present.join(", ")} is set. Unset it; the owner signs mainnet deployments in Rabby (deploy/mainnet/OWNER-SIGNING.md).`);
  }
}

/** The defined deployer is fixed. A plan for any other address is refused rather than re-targeted. */
export function assertDefinedDeployer(value, name = "EXPECTED_DEPLOYER_ADDRESS") {
  const text = String(value ?? "").trim();
  if (!text) throw new SigningRequestError(`${name} is required: ${MAINNET_DEPLOYER}.`);
  let address;
  try { address = getAddress(text); } catch { throw new SigningRequestError(`${name} must be an EVM address.`); }
  if (address !== MAINNET_DEPLOYER) throw new SigningRequestError(`${name} must be the defined mainnet deployer ${MAINNET_DEPLOYER}, not ${address}.`);
  return address;
}

/** One unsigned CREATE transaction. `data` is the full creation code plus encoded constructor args. */
export function creationRequest({ step, contract, chainId = MAINNET_CHAIN_ID, from, nonce, data, estimatedGas, predictedAddress }) {
  if (!/^0x([0-9a-fA-F]{2})+$/.test(String(data || ""))) throw new SigningRequestError(`Step ${step}: creation data must be non-empty hex.`);
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new SigningRequestError(`Step ${step}: nonce must be a non-negative integer.`);
  const gas = BigInt(estimatedGas);
  return {
    step,
    contract,
    chainId,
    from: getAddress(from),
    to: null,
    nonce,
    value: "0",
    data: data.toLowerCase(),
    dataHash: keccak256(data),
    gasLimit: ((gas * GAS_LIMIT_HEADROOM_PERCENT) / 100n).toString(),
    predictedAddress: getAddress(predictedAddress),
  };
}

/** The deployment-defining fields of a request (no gas, which is an estimate). Used by the plan binding. */
export function requestBindingFields(request) {
  return {
    step: request.step, contract: request.contract, chainId: request.chainId, from: String(request.from).toLowerCase(), to: request.to ?? null,
    nonce: request.nonce, value: request.value, dataHash: String(request.dataHash).toLowerCase(), predictedAddress: String(request.predictedAddress).toLowerCase(),
  };
}

/** The EIP-1193 eth_sendTransaction parameters handed to Rabby. No `to`: this is a contract creation. */
export function walletTransaction(request) {
  return {
    from: request.from,
    data: request.data,
    value: "0x0",
    gas: toQuantity(BigInt(request.gasLimit)),
    nonce: toQuantity(request.nonce),
    chainId: toQuantity(request.chainId),
  };
}

async function rpcChainId(provider) {
  return BigInt(await provider.send("eth_chainId", []));
}

/** Live, read-only checks immediately before the owner is asked to sign one request. */
export async function assertReadyToSign(provider, request, emptyAddresses = [request.predictedAddress]) {
  const chainId = await rpcChainId(provider);
  if (chainId !== BigInt(request.chainId)) throw new SigningRequestError(`The RPC reports chain ${chainId}, not ${request.chainId}. Nothing was sent to the wallet.`);
  const [latest, pending, code] = await Promise.all([
    provider.getTransactionCount(request.from, "latest"),
    provider.getTransactionCount(request.from, "pending"),
    provider.getCode(request.from),
  ]);
  if (code !== "0x") throw new SigningRequestError(`The deployer ${request.from} has contract code; it must be an externally owned account.`);
  if (latest !== pending) throw new SigningRequestError(`The deployer has pending transactions (latest ${latest}, pending ${pending}). Nothing was sent to the wallet.`);
  if (latest !== request.nonce) throw new SigningRequestError(`The deployer nonce is ${latest}, not the reviewed ${request.nonce}: the predicted address would be wrong. Nothing was sent to the wallet.`);
  for (const target of emptyAddresses) {
    if ((await provider.getCode(target)) !== "0x") throw new SigningRequestError(`${target} already has code. Nothing was sent to the wallet.`);
  }
  return { chainId: Number(chainId), nonce: latest };
}

/**
 * Independently verifies a mined creation transaction against its reviewed request, from the RPC
 * (never from the wallet): chain, sender, nonce, no recipient, zero value, exact creation data,
 * success, and the contract at the predicted address.
 */
export async function verifyCreationTransaction(provider, request, hash, { timeoutMs = 600_000 } = {}) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(hash || ""))) throw new SigningRequestError(`Step ${request.step}: a 32-byte transaction hash is required.`);
  const chainId = await rpcChainId(provider);
  if (chainId !== BigInt(request.chainId)) throw new SigningRequestError(`The RPC reports chain ${chainId}, not ${request.chainId}.`);
  const receipt = await provider.waitForTransaction(hash, 1, timeoutMs);
  if (!receipt) throw new SigningRequestError(`Step ${request.step}: ${hash} was not mined within ${timeoutMs / 1000}s.`);
  const tx = await provider.getTransaction(hash);
  if (!tx) throw new SigningRequestError(`Step ${request.step}: ${hash} is unknown to the RPC.`);
  const problems = [];
  if (tx.chainId !== BigInt(request.chainId)) problems.push(`chainId ${tx.chainId}`);
  if (getAddress(tx.from) !== getAddress(request.from)) problems.push(`sender ${tx.from}`);
  if (tx.nonce !== request.nonce) problems.push(`nonce ${tx.nonce}`);
  if (tx.to !== null) problems.push(`recipient ${tx.to} (expected a contract creation)`);
  if (tx.value !== 0n) problems.push(`value ${tx.value}`);
  if (keccak256(tx.data) !== String(request.dataHash).toLowerCase()) problems.push(`creation data hash ${keccak256(tx.data)}`);
  if (receipt.status !== 1) problems.push(`receipt status ${receipt.status}`);
  const created = receipt.contractAddress ? getAddress(receipt.contractAddress) : null;
  if (created !== getAddress(request.predictedAddress)) problems.push(`created ${created ?? "nothing"}, not ${request.predictedAddress}`);
  const code = created ? await provider.getCode(created) : "0x";
  if (code === "0x") problems.push("no runtime code at the created address");
  if (problems.length) throw new SigningRequestError(`Step ${request.step} (${request.contract}) does not match the reviewed request: ${problems.join("; ")}.`);
  return { step: request.step, contract: request.contract, address: created, transaction: receipt.hash, block: receipt.blockNumber, gasUsed: receipt.gasUsed.toString(), runtimeCodeHash: keccak256(code) };
}

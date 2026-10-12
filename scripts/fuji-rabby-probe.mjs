import { AbiCoder, Interface, getAddress, getCreateAddress, id, keccak256 } from "ethers";
import { creationRequest, runtimeMatchesArtifact } from "./mainnet-signing-requests.mjs";
import { NETWORK_PROFILES } from "./network-profiles.mjs";

// The Fuji Rabby test: one zero-value contract creation of RabbySigningProbe (no funds held, no
// owner, no state-changing function) from the Rabby deployer on Fuji. It proves the browser page and
// Rabby end to end: account, chain, one exact transaction, receipt, and verification from the RPC.
// It deploys nothing the platform uses. Browser-safe: the artifact is passed in.
export const PROBE_KIND = "rabby-probe-fuji";
export const PROBE_CONTRACT = "RabbySigningProbe";
export const PROBE_ARTIFACT_PATH = "out/RabbySigningProbe.sol/RabbySigningProbe.json";
export const PROBE_LABEL_TEXT = "the-void/fuji-rabby-probe/v1";
export const PROBE_LABEL = id(PROBE_LABEL_TEXT);
const PROBE_VIEWS = new Interface(["function label() view returns (bytes32)", "function creator() view returns (address)"]);
const FUJI = NETWORK_PROFILES.fuji;

export const probeCreationData = (artifact) => `${artifact.bytecode.object}${AbiCoder.defaultAbiCoder().encode(["bytes32"], [PROBE_LABEL]).slice(2)}`.toLowerCase();

/** Key-less dry-run plan for the probe at the deployer's live Fuji nonce. */
export async function buildProbePlan(provider, artifact, { now = new Date() } = {}) {
  const chainId = BigInt(await provider.send("eth_chainId", []));
  if (chainId !== BigInt(FUJI.chainId)) throw new Error(`The RPC reports chain ${chainId}, not Fuji ${FUJI.chainId}.`);
  const deployer = FUJI.deployer;
  const [nonce, pending, balance, feeData, block] = await Promise.all([
    provider.getTransactionCount(deployer, "latest"), provider.getTransactionCount(deployer, "pending"),
    provider.getBalance(deployer), provider.getFeeData(), provider.getBlockNumber(),
  ]);
  if (nonce !== pending) throw new Error(`The deployer has pending Fuji transactions (latest ${nonce}, pending ${pending}).`);
  const data = probeCreationData(artifact);
  const predictedAddress = getCreateAddress({ from: deployer, nonce });
  if ((await provider.getCode(predictedAddress)) !== "0x") throw new Error(`${predictedAddress} already has code on Fuji.`);
  const estimatedGas = await provider.estimateGas({ from: deployer, data });
  const request = creationRequest({ step: 1, contract: PROBE_CONTRACT, chainId: FUJI.chainId, from: deployer, nonce, data, estimatedGas, predictedAddress });
  const price = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
  return {
    mode: "DRY_RUN",
    network: "fuji",
    chainId: FUJI.chainId,
    purpose: "TEST ONLY: validates the Rabby owner-signing page on Fuji. Deploys nothing the platform uses.",
    observedAt: { time: now.toISOString(), block },
    deployer: { address: deployer, nonce, balanceWei: balance.toString() },
    probe: { contract: PROBE_CONTRACT, label: PROBE_LABEL, labelText: PROBE_LABEL_TEXT, predictedAddress, initCodeHash: keccak256(artifact.bytecode.object), runtimeCodeHash: keccak256(artifact.deployedBytecode.object) },
    cost: { estimatedGas: estimatedGas.toString(), gasLimit: request.gasLimit, maxFeePerGasWei: price.toString(), maxCostWei: (BigInt(request.gasLimit) * price).toString() },
    signingRequests: [request],
  };
}

/** Reads the mined probe back: label, creator, no balance, and runtime code from the reviewed artifact. */
export async function checkProbeState(provider, plan, address, artifact) {
  const problems = [];
  const call = async (name) => PROBE_VIEWS.decodeFunctionResult(name, await provider.call({ to: address, data: PROBE_VIEWS.encodeFunctionData(name) }))[0];
  const [label, creator, balance, code] = await Promise.all([call("label"), call("creator"), provider.getBalance(address), provider.getCode(address)]);
  if (label !== plan.probe.label) problems.push(`label ${label}`);
  if (getAddress(creator) !== getAddress(plan.deployer.address)) problems.push(`creator ${creator}`);
  if (balance !== 0n) problems.push(`balance ${balance}`);
  if (artifact && !runtimeMatchesArtifact(code, artifact)) problems.push("runtime code is not the reviewed RabbySigningProbe");
  return { problems, facts: { label, creator: getAddress(creator), balanceWei: balance.toString() } };
}

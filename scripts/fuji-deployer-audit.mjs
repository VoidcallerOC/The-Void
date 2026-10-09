// Read-only: enumerate every contract created directly by a deployer EOA on Fuji.
// CREATE addresses are derived from (deployer, nonce) for every nonce the account has
// used; each address with code is dated by binary search on eth_getCode and labelled
// with its marketplace/registry getters. No signing, no broadcast.
//
//   DEPLOYER=0x... node scripts/fuji-deployer-audit.mjs
import { Interface, JsonRpcProvider, getAddress, getCreateAddress, keccak256 } from "ethers";
import fujiV2 from "../config/fuji-release-per-contract-v2.json" with { type: "json" };

const RPC_URL = process.env.FUJI_RPC_URL || fujiV2.rpcUrl;
const DEPLOYER = getAddress(process.env.DEPLOYER || "0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174");
const labels = new Interface([
  "function canonicalToken() view returns (address)",
  "function registry() view returns (address)",
  "function feeRecipient() view returns (address)",
  "function implementation() view returns (address)",
  "function releases() view returns (address)",
  "function nextListingId() view returns (uint256)",
  "function name() view returns (string)",
  "function owner() view returns (address)",
  "function hasRole(bytes32,address) view returns (bool)",
]);
const DEFAULT_ADMIN_ROLE = `0x${"00".repeat(32)}`;

async function read(provider, to, name) {
  try { return labels.decodeFunctionResult(name, await provider.call({ to, data: labels.encodeFunctionData(name) }))[0]; } catch { return undefined; }
}

async function creationBlock(provider, address, tip) {
  let low = 1;
  let high = tip;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if ((await provider.getCode(address, mid)) === "0x") low = mid + 1; else high = mid;
  }
  const block = await provider.getBlock(low);
  return { block: low, timestamp: new Date(block.timestamp * 1000).toISOString() };
}

const provider = new JsonRpcProvider(RPC_URL, 43113, { staticNetwork: true });
const tip = await provider.getBlockNumber();
const nonce = await provider.getTransactionCount(DEPLOYER, "latest");
const contracts = [];
for (let n = 0; n < nonce; n += 1) {
  const address = getCreateAddress({ from: DEPLOYER, nonce: n });
  const code = await provider.getCode(address);
  if (code === "0x") continue;
  const entry = { nonce: n, address, codeBytes: (code.length - 2) / 2, runtimeCodeHash: keccak256(code), ...(await creationBlock(provider, address, tip)) };
  for (const name of ["canonicalToken", "registry", "feeRecipient", "implementation", "releases", "nextListingId", "name"]) {
    const value = await read(provider, address, name);
    if (value !== undefined) entry[name] = typeof value === "bigint" ? value.toString() : value;
  }
  const owner = await read(provider, address, "owner");
  if (owner !== undefined) entry.owner = owner;
  try {
    entry.deployerIsDefaultAdmin = labels.decodeFunctionResult("hasRole", await provider.call({ to: address, data: labels.encodeFunctionData("hasRole", [DEFAULT_ADMIN_ROLE, DEPLOYER]) }))[0];
  } catch { /* no AccessControl */ }
  contracts.push(entry);
}
console.log(JSON.stringify({ probedAt: new Date().toISOString(), deployer: DEPLOYER, nonce, tipBlock: tip, contractsCreated: contracts.length, contracts }, null, 2));
if (process.env.PRINT_CODE) {
  for (const address of process.env.PRINT_CODE.split(",")) console.log(`CODE ${getAddress(address)} ${await provider.getCode(getAddress(address))}`);
}

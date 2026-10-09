// Read-only Fuji marketplace reconciliation probe. It identifies every known
// marketplace-like address by code fingerprint, reads its immutable
// configuration and listing state, and recovers its creation transaction.
// It sends only eth_* reads over JSON-RPC plus one public explorer lookup;
// it never signs or broadcasts. Output is JSON on stdout.
//
//   node scripts/fuji-marketplace-reconciliation-probe.mjs
import { AbiCoder, Interface, JsonRpcProvider, getAddress, keccak256 } from "ethers";
import fujiV2 from "../config/fuji-release-per-contract-v2.json" with { type: "json" };
import fingerprints from "./data/marketplace-fingerprints.json" with { type: "json" };

const RPC_URL = process.env.FUJI_RPC_URL || fujiV2.rpcUrl;
const EXPLORER_API = process.env.FUJI_EXPLORER_API || "https://api.routescan.io/v2/network/testnet/evm/43113/etherscan/api";
const STATUS = ["ACTIVE", "SOLD", "CANCELLED", "EXPIRED"];
const MAX_LISTINGS_SCANNED = 200;

// Every marketplace-like Fuji address found in configuration, git history or run logs.
const CANDIDATES = [
  { address: "0x42B740aA92A6F48380F6D97AD91e332a7921a744", source: "config/fuji-release-per-contract-v2.json, deployments/release-per-contract-fuji.json, Vercel VITE_MARKETPLACE_ADDRESS", deploymentTransaction: "0x3d08466ab91b4f31fdb69aa42b3107d821c7cef5d53effad3e56f2affd8c3861" },
  { address: "0x228734C7a6325f7B6F570EBCAc80239495fdedf0", source: "config/fuji-release-per-contract.json (V1 factory)" },
  { address: "0xa03b4b6e384c1d2718b837cd78e6408754aa0c0b", source: "git 7b1bee8 FUJI_LISTING_TARGET (removed 4bbce80); Vercel VITE_FUJI_LISTING_MARKETPLACE_ADDRESS" },
  { address: "0x982b28352fd612fe934c5e1ad8fea399689190d2", source: "git 606b3aa; API/indexer MARKETPLACE per PRODUCTION-CONTRACT-ADDRESS-DRIFT-AUDIT.md (2026-10-04)" },
  { address: "0xd13f6184f4e3166901c7ed322e8c2c6be5915f92", source: "Render cron crn-dat953e0tbcc73acrepg run 2026-10-04T03:58Z", deploymentTransaction: "0x06efd5a56057da3b846c21c21cf5eba89258721df113b636161addb26837488a" },
  { address: "0xced494f8c5e51053fe631d68c5165856633e7a29", source: "Render cron crn-dat953e0tbcc73acrepg run 2026-10-04T13:51Z", deploymentTransaction: "0xee1eda13d2ce8e51f095d0b43a37c6f736729d48289c1024ff0eca3428752548" },
  { address: "0x1bc4cc82e658856d9bd53793612d97b0b23a6e04", source: "Render cron crn-dat953e0tbcc73acrepg run 2026-10-06T03:14Z", deploymentTransaction: "0x8317e65b923d690576706fbf0a725a4e7e3d6b0a4d97e919e3e376542644a6b1" },
];

const getters = new Interface([
  "function feeRecipient() view returns (address)",
  "function platformFeeBps() view returns (uint256)",
  "function deploymentChainId() view returns (uint256)",
  "function canonicalToken() view returns (address)",
  "function registry() view returns (address)",
  "function nextListingId() view returns (uint256)",
  "function listingStatus(uint256) view returns (uint8)",
]);
const tokenIface = new Interface([
  "function balanceOf(address,uint256) view returns (uint256)",
  "function isApprovedForAll(address,address) view returns (bool)",
]);
const word = (hex, index) => hex.slice(2 + index * 64, 2 + (index + 1) * 64);

// getListing returns (listingId, seller, tokenContract, tokenId, amount, price, createdAt, expiresAt, status)
// in every MusicMarketplace/ReleaseMarketplaceV3 version; decode by word to stay version-agnostic.
async function activeListing(provider, marketplace, id) {
  const data = await provider.call({ to: marketplace, data: `0x107a274a${id.toString(16).padStart(64, "0")}` });
  if (!data || data.length < 2 + 9 * 64) return null;
  const listing = {
    listingId: BigInt(`0x${word(data, 0)}`),
    seller: getAddress(`0x${word(data, 1).slice(24)}`),
    tokenContract: getAddress(`0x${word(data, 2).slice(24)}`),
    tokenId: BigInt(`0x${word(data, 3)}`),
    amount: BigInt(`0x${word(data, 4)}`),
    priceWei: BigInt(`0x${word(data, 5)}`),
    createdAt: new Date(Number(BigInt(`0x${word(data, 6)}`)) * 1000).toISOString(),
    expiresAt: BigInt(`0x${word(data, 7)}`),
  };
  const call = async (name, args) => { try { return tokenIface.decodeFunctionResult(name, await provider.call({ to: listing.tokenContract, data: tokenIface.encodeFunctionData(name, args) }))[0]; } catch { return null; } };
  listing.sellerBalance = await call("balanceOf", [listing.seller, listing.tokenId]);
  listing.sellerApprovedMarketplace = await call("isApprovedForAll", [listing.seller, marketplace]);
  listing.fillableNow = listing.sellerBalance !== null && listing.sellerBalance >= listing.amount && listing.sellerApprovedMarketplace === true
    && (listing.expiresAt === 0n || listing.expiresAt > BigInt(Math.floor(Date.now() / 1000)));
  return listing;
}

// Earliest block with code at the address (binary search), then the transaction in that
// block whose receipt created it. Covers addresses with no recorded deployment transaction.
async function findCreation(provider, address, tipBlock) {
  let low = 1;
  let high = tipBlock;
  if ((await provider.getCode(address, high)) === "0x") return null;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if ((await provider.getCode(address, mid)) === "0x") low = mid + 1; else high = mid;
  }
  const block = await provider.getBlock(low, false);
  for (const hash of block?.transactions || []) {
    const receipt = await provider.getTransactionReceipt(hash);
    if (receipt?.contractAddress && getAddress(receipt.contractAddress) === address) return { transaction: hash, blockNumber: low, method: "binary search on eth_getCode" };
  }
  return { transaction: null, blockNumber: low, method: "binary search on eth_getCode; created by an internal call (no top-level creation receipt in block)" };
}

const registryIface = new Interface(["function implementation() view returns (address)", "function releaseCount() view returns (uint256)"]);

function fingerprint(code, ranges) {
  const bytes = Buffer.from(code.replace(/^0x/, ""), "hex");
  if (bytes.length < 2) return null;
  const metadataLength = bytes.readUInt16BE(bytes.length - 2);
  if (metadataLength + 2 > bytes.length) return null;
  const body = Buffer.from(bytes.subarray(0, bytes.length - 2 - metadataLength));
  for (const [start, length] of ranges) if (start + length <= body.length) body.fill(0, start, start + length);
  return keccak256(body);
}

function identify(code) {
  for (const version of fingerprints.versions) {
    if (fingerprint(code, version.immutableRanges) === version.fingerprint) return { contract: version.contract, sourceCommit: version.sourceCommit, optimizer: version.optimizer, settingsAssumed: version.settingsAssumed };
  }
  return null;
}

async function read(provider, address, name, args = []) {
  try {
    const data = await provider.call({ to: address, data: getters.encodeFunctionData(name, args) });
    const value = getters.decodeFunctionResult(name, data)[0];
    return typeof value === "string" ? getAddress(value) : value;
  } catch { return null; }
}

async function creationTransactions(addresses) {
  try {
    const url = `${EXPLORER_API}?module=contract&action=getcontractcreation&contractaddresses=${addresses.join(",")}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const body = await response.json();
    return Object.fromEntries((Array.isArray(body.result) ? body.result : []).map((row) => [getAddress(row.contractAddress), row.txHash]));
  } catch (error) {
    return { error: error.message };
  }
}

const stringify = (value) => JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);

async function main() {
  const provider = new JsonRpcProvider(RPC_URL, 43113, { staticNetwork: true });
  const chainId = BigInt(await provider.send("eth_chainId", []));
  if (chainId !== 43113n) throw new Error(`Unexpected chain ID ${chainId}`);
  const tipBlock = await provider.getBlockNumber();
  const explorer = await creationTransactions(CANDIDATES.map((c) => getAddress(c.address)));

  const results = [];
  for (const candidate of CANDIDATES) {
    const address = getAddress(candidate.address);
    const code = await provider.getCode(address);
    const identity = code === "0x" ? null : identify(code);
    const config = {
      feeRecipient: await read(provider, address, "feeRecipient"),
      platformFeeBps: await read(provider, address, "platformFeeBps"),
      deploymentChainId: await read(provider, address, "deploymentChainId"),
      canonicalToken: await read(provider, address, "canonicalToken"),
      registry: await read(provider, address, "registry"),
    };
    const nextListingId = await read(provider, address, "nextListingId");
    const statusCounts = {};
    const activeListings = [];
    if (nextListingId !== null) {
      const last = nextListingId - 1n;
      for (let id = 1n; id <= last && id <= BigInt(MAX_LISTINGS_SCANNED); id += 1n) {
        const status = await read(provider, address, "listingStatus", [id]);
        const label = status === null ? "UNREADABLE" : STATUS[Number(status)] || `UNKNOWN_${status}`;
        statusCounts[label] = (statusCounts[label] || 0) + 1;
        if (label === "ACTIVE") activeListings.push(await activeListing(provider, address, id).catch((error) => ({ listingId: id, error: error.message })));
      }
    }
    let registryState = null;
    if (config.registry) {
      registryState = {
        implementation: await (async () => { try { return getAddress(registryIface.decodeFunctionResult("implementation", await provider.call({ to: config.registry, data: registryIface.encodeFunctionData("implementation") }))[0]); } catch { return null; } })(),
        releaseCount: await (async () => { try { return registryIface.decodeFunctionResult("releaseCount", await provider.call({ to: config.registry, data: registryIface.encodeFunctionData("releaseCount") }))[0]; } catch { return null; } })(),
      };
    }
    let deploymentTransaction = candidate.deploymentTransaction || (explorer.error ? null : explorer[address]) || null;
    let source = candidate.deploymentTransaction ? "recorded" : deploymentTransaction ? "explorer getcontractcreation" : null;
    if (!deploymentTransaction && code !== "0x") {
      const found = await findCreation(provider, address, tipBlock).catch((error) => ({ transaction: null, method: `search failed: ${error.message}` }));
      deploymentTransaction = found?.transaction || null;
      source = found?.method || "not found";
    }
    let deployment = { transaction: deploymentTransaction, source: source || "not found" };
    if (deploymentTransaction) {
      const [tx, receipt] = await Promise.all([provider.getTransaction(deploymentTransaction), provider.getTransactionReceipt(deploymentTransaction)]);
      const block = receipt ? await provider.getBlock(receipt.blockNumber) : null;
      const createdHere = receipt?.contractAddress && getAddress(receipt.contractAddress) === address;
      let constructorArgs = null;
      if (tx?.data && identity && createdHere) {
        const types = identity.contract === "MusicMarketplaceV2" ? ["address", "uint256", "address", "address"] : identity.contract === "MusicMarketplace" && identity.sourceCommit !== "0dfb240e90" ? ["address", "uint256"] : ["address", "uint256", "address"];
        try { constructorArgs = AbiCoder.defaultAbiCoder().decode(types, `0x${tx.data.slice(-64 * types.length)}`).map((v) => (typeof v === "string" ? getAddress(v) : v)); } catch { constructorArgs = null; }
      }
      deployment = { ...deployment, status: receipt?.status ?? null, blockNumber: receipt?.blockNumber ?? null, timestamp: block ? new Date(block.timestamp * 1000).toISOString() : null, from: tx?.from ? getAddress(tx.from) : null, createsThisAddress: Boolean(createdHere), constructorArgs };
    }
    results.push({
      address,
      referencedBy: candidate.source,
      codeBytes: (code.length - 2) / 2,
      runtimeCodeHash: code === "0x" ? null : keccak256(code),
      identity: identity || (code === "0x" ? "NO_CODE" : "UNMATCHED"),
      config,
      registryState,
      listings: { nextListingId, created: nextListingId === null ? null : nextListingId - 1n, statusCounts, activeListings },
      nativeBalanceWei: await provider.getBalance(address),
      deployment,
      isCanonicalV3Config: address === getAddress(fujiV2.marketplaceAddress),
    });
  }

  console.log(stringify({ probedAt: new Date().toISOString(), rpc: RPC_URL, chainId, tipBlock, explorerLookupError: explorer.error || null, results }));
}

main().catch((error) => {
  console.error(`Probe failed: ${error.message}`);
  process.exitCode = 1;
});

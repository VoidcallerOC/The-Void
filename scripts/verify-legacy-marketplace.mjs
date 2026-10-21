#!/usr/bin/env node
// Read-only readiness check for the legacy-collection marketplace (Genesis resale). Sends no transactions.
//   node scripts/verify-legacy-marketplace.mjs            # RPC defaults to the public C-Chain endpoint
// Exit 0 only if everything agrees; exit 1 on any mismatch; exit 2 when the marketplace is not deployed yet.
import { Contract, JsonRpcProvider, getAddress } from "ethers";
import { LEGACY_COLLECTION_MARKETPLACE as manifest, legacyMarketplaceActive } from "../config/legacy-collection-marketplace.js";
import { RELEASE_PER_CONTRACT_MANIFESTS } from "../config/release-network.js";
import { checkRoyaltyInvariance } from "./lib/royalty-invariance.mjs";

const rpc = process.env.AVALANCHE_MAINNET_RPC_URL || RELEASE_PER_CONTRACT_MANIFESTS.mainnet.rpcUrl;
const provider = new JsonRpcProvider(rpc, 43114, { staticNetwork: true });
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

const v4 = RELEASE_PER_CONTRACT_MANIFESTS.mainnet;
const v4Market = new Contract(v4.marketplaceAddress, ["function registry() view returns (address)", "function platformFeeBps() view returns (uint256)", "function feeRecipient() view returns (address)"], provider);
const v4Factory = new Contract(v4.factoryAddress, ["function isRelease(address) view returns (bool)"], provider);
check("provider is Avalanche C-Chain 43114", Number((await provider.getNetwork()).chainId) === 43114);
check("V4 marketplace registry is the manifest factory", same(await v4Market.registry(), v4.factoryAddress));
check("V4 marketplace fee is 250 bps", (await v4Market.platformFeeBps()) === 250n);

for (const collection of manifest.collections) {
  const token = new Contract(collection.address, ["function royaltyInfo(uint256,uint256) view returns (address,uint256)", "function operatorFilterRegistry() view returns (address)", "function supportsInterface(bytes4) view returns (bool)"], provider);
  check(`${collection.name}: ERC-1155 and ERC-2981`, (await token.supportsInterface("0xd9b67a26")) && (await token.supportsInterface("0x2a55205a")));
  check(`${collection.name}: not a factory release (V4 correctly refuses it)`, (await v4Factory.isRelease(collection.address)) === false);
  // M-1 vetting aid: the answer must not depend on the gas supplied or on who asks (sampled; evidence, not proof)
  const ids = Array.from({ length: collection.maxTokenId - collection.minTokenId + 1 }, (_, index) => collection.minTokenId + index);
  const invariance = await checkRoyaltyInvariance({ call: ({ to, data, gas, from }) => provider.call({ to, data, from, gasLimit: gas }), token: collection.address, tokenIds: ids });
  check(`${collection.name}: royaltyInfo identical across ${invariance.samples} gas-limit/caller samples (sampled, not proof)`, invariance.ok, invariance.findings.join("; "));
  for (let id = collection.minTokenId; id <= collection.maxTokenId; id += 1) {
    const [receiver, amount] = await token.royaltyInfo(id, 10_000n);
    check(`${collection.name} #${id}: royalty ${amount} bps to the recorded creator within the ${collection.maxRoyaltyBps} bps cap`, same(receiver, collection.expectedRoyaltyReceiver) && amount <= BigInt(collection.maxRoyaltyBps));
  }
}

if (!legacyMarketplaceActive()) {
  console.log("\nNOT DEPLOYED: config/legacy-collection-marketplace.json is deployed:false. Pre-deployment facts above only.");
  process.exit(results.every((r) => r.ok) ? 2 : 1);
}

const market = new Contract(manifest.marketplaceAddress, [
  "function platformFeeBps() view returns (uint256)", "function feeRecipient() view returns (address)", "function deploymentChainId() view returns (uint256)", // feeRecipient must NOT exist
  "function owner() view returns (address)", "function paused() view returns (bool)",
  "function getCollection(address) view returns (tuple(bool enabled, uint16 maxRoyaltyBps, uint256 minTokenId, uint256 maxTokenId))",
  "function previewSettlement(address,uint256,uint256) view returns (uint256,address,uint256,uint256)",
], provider);
check("marketplace has code at the manifest address", (await provider.getCode(manifest.marketplaceAddress)) !== "0x");
check("marketplace chain id is 43114", (await market.deploymentChainId()) === 43114n);
check("marketplace platform fee is 0 bps (Genesis policy)", (await market.platformFeeBps()) === 0n && manifest.platformFeeBps === 0);
check("marketplace has no fee recipient", (await market.feeRecipient().then(() => "present", () => "absent")) === "absent");
check("marketplace owner is the recorded owner", manifest.ownerAddress ? same(await market.owner(), manifest.ownerAddress) : false, manifest.ownerAddress ? "" : "ownerAddress not recorded");
check("marketplace is not paused", (await market.paused()) === false);
for (const collection of manifest.collections) {
  const onChain = await market.getCollection(collection.address);
  check(`${collection.name}: allowlist policy matches the manifest`, onChain.enabled && Number(onChain.maxRoyaltyBps) === collection.maxRoyaltyBps && Number(onChain.minTokenId) === collection.minTokenId && Number(onChain.maxTokenId) === collection.maxTokenId);
  const filterAddress = await new Contract(collection.address, ["function operatorFilterRegistry() view returns (address)"], provider).operatorFilterRegistry().catch(() => null);
  if (filterAddress && getAddress(filterAddress) !== getAddress("0x0000000000000000000000000000000000000000")) {
    check(`${collection.name}: operator filter allows the marketplace`, await new Contract(filterAddress, ["function isOperatorAllowed(address,address) view returns (bool)"], provider).isOperatorAllowed(collection.address, manifest.marketplaceAddress));
  }
  for (let id = collection.minTokenId; id <= collection.maxTokenId; id += 1) {
    const [fee, receiver, royalty, seller] = await market.previewSettlement(collection.address, id, 10n ** 18n).catch(() => [null]);
    check(`${collection.name} #${id}: settles 0 platform / full royalty / rest to the seller`, fee === 0n && royalty + seller === 10n ** 18n && royalty <= (10n ** 18n * BigInt(collection.maxRoyaltyBps)) / 10_000n && same(receiver, collection.expectedRoyaltyReceiver), fee === null ? "preview reverts" : `${fee} / ${royalty} / ${seller} wei per 1 AVAX`);
  }
}
const configured = process.env.VITE_LEGACY_MARKETPLACE_ADDRESS || process.env.INDEXER_LEGACY_MARKETPLACE_ADDRESS;
if (configured) check("environment marketplace address equals the manifest", same(configured, manifest.marketplaceAddress));
process.exit(results.every((r) => r.ok) ? 0 : 1);

// Read-only Fuji probe for release-per-contract capability and marketplace parity.
// It sends only eth_chainId, eth_getCode, eth_call and eth_getTransaction(Receipt);
// it never signs or broadcasts. Output is JSON on stdout.
//
//   node scripts/fuji-release-capability-probe.mjs
//
// Optional env: FUJI_RPC_URL (defaults to the public Avalanche Fuji endpoint),
// EXTRA_MARKETPLACE_TXS (comma-separated deployment tx hashes to account for).
import { Interface, JsonRpcProvider, getAddress, id } from "ethers";
import fujiV2 from "../config/fuji-release-per-contract-v2.json" with { type: "json" };

const RPC_URL = process.env.FUJI_RPC_URL || fujiV2.rpcUrl;
const FUJI_CHAIN_ID = 43113n;

// Selectors that exist only in the album/open-edition VoidRelease1155V4 source (PR #136).
const ALBUM_SIGNATURES = [
  "createAlbum(bytes32)",
  "createAlbumTrack(bytes32,bytes32,uint256,string,address,uint96,bool,uint64)",
  "closeAlbum(bytes32)",
  "albumCreated()",
  "createEditionWithMintEnd(bytes32,bytes32,uint256,string,address,uint96,uint64)",
];

// Fuji MusicMarketplace deployments broadcast by the (now suspended) Render cron
// `crn-dat953e0tbcc73acrepg`, taken from its run logs.
const CRON_MARKETPLACE_TXS = [
  "0x06efd5a56057da3b846c21c21cf5eba89258721df113b636161addb26837488a",
  "0xee1eda13d2ce8e51f095d0b43a37c6f736729d48289c1024ff0eca3428752548",
  "0x8317e65b923d690576706fbf0a725a4e7e3d6b0a4d97e919e3e376542644a6b1",
];

const factoryIface = new Interface([
  "function implementation() view returns (address)",
  "function platformRecipient() view returns (address)",
  "function releaseCount() view returns (uint256)",
  "function releaseAt(uint256) view returns (address)",
  "function primarySaleOf(address) view returns (address)",
  "function isRelease(address) view returns (bool)",
]);
const marketplaceIface = new Interface([
  "function registry() view returns (address)",
  "function platformFeeBps() view returns (uint256)",
  "function feeRecipient() view returns (address)",
  "function deploymentChainId() view returns (uint256)",
]);
const albumIface = new Interface(["function albumCreated() view returns (bool)"]);

const selector = (signature) => id(signature).slice(2, 10);
// Solidity dispatchers compare selectors with PUSH4 (0x63) followed by the 4 bytes.
const hasSelector = (code, signature) => code.toLowerCase().includes(`63${selector(signature)}`);

async function call(provider, to, iface, name, args = []) {
  const data = await provider.call({ to, data: iface.encodeFunctionData(name, args) });
  return iface.decodeFunctionResult(name, data)[0];
}

async function tryCall(provider, to, iface, name, args = []) {
  try { return { ok: true, value: await call(provider, to, iface, name, args) }; }
  catch (error) { return { ok: false, error: error.shortMessage || error.message }; }
}

const stringify = (value) => JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);

async function main() {
  const provider = new JsonRpcProvider(RPC_URL, Number(FUJI_CHAIN_ID), { staticNetwork: true });
  const chainId = BigInt(await provider.send("eth_chainId", []));
  if (chainId !== FUJI_CHAIN_ID) throw new Error(`Unexpected chain ID ${chainId}`);
  const tip = await provider.getBlockNumber();

  const factory = getAddress(fujiV2.factoryAddress);
  const marketplace = getAddress(fujiV2.marketplaceAddress);
  const implementation = getAddress(await call(provider, factory, factoryIface, "implementation"));
  const implementationCode = await provider.getCode(implementation);
  const selectors = Object.fromEntries(ALBUM_SIGNATURES.map((sig) => [sig, hasSelector(implementationCode, sig)]));

  const releaseCount = await call(provider, factory, factoryIface, "releaseCount");
  const releases = [];
  for (let i = 0n; i < releaseCount; i += 1n) {
    const release = getAddress(await call(provider, factory, factoryIface, "releaseAt", [i]));
    releases.push({
      index: i,
      release,
      primarySale: getAddress(await call(provider, factory, factoryIface, "primarySaleOf", [release])),
      isRelease: await call(provider, factory, factoryIface, "isRelease", [release]),
      albumCreated: await tryCall(provider, release, albumIface, "albumCreated"),
    });
  }

  const v3 = {
    address: marketplace,
    codePresent: (await provider.getCode(marketplace)) !== "0x",
    registry: getAddress(await call(provider, marketplace, marketplaceIface, "registry")),
    platformFeeBps: await call(provider, marketplace, marketplaceIface, "platformFeeBps"),
    feeRecipient: getAddress(await call(provider, marketplace, marketplaceIface, "feeRecipient")),
    deploymentChainId: await call(provider, marketplace, marketplaceIface, "deploymentChainId"),
  };
  v3.matchesConfig = v3.registry === factory
    && v3.platformFeeBps === BigInt(fujiV2.marketplaceFeeBps)
    && v3.feeRecipient === getAddress(fujiV2.marketplaceFeeRecipient)
    && v3.deploymentChainId === FUJI_CHAIN_ID;

  const txs = [...CRON_MARKETPLACE_TXS, ...String(process.env.EXTRA_MARKETPLACE_TXS || "").split(",").map((s) => s.trim()).filter(Boolean)];
  const cronMarketplaces = [];
  for (const hash of txs) {
    const [tx, receipt] = await Promise.all([provider.getTransaction(hash), provider.getTransactionReceipt(hash)]);
    const created = receipt?.contractAddress ? getAddress(receipt.contractAddress) : null;
    cronMarketplaces.push({
      transaction: hash,
      status: receipt?.status ?? null,
      blockNumber: receipt?.blockNumber ?? null,
      from: tx?.from ? getAddress(tx.from) : null,
      contractAddress: created,
      codePresent: created ? (await provider.getCode(created)) !== "0x" : false,
      isCanonicalV3: created === marketplace,
      registeredAsRelease: created ? await call(provider, factory, factoryIface, "isRelease", [created]) : false,
    });
  }

  const albumCapable = Object.values(selectors).every(Boolean);
  console.log(stringify({
    probedAt: new Date().toISOString(),
    rpc: RPC_URL,
    chainId,
    tipBlock: tip,
    factory: { address: factory, implementation, implementationMatchesConfig: implementation === getAddress(fujiV2.implementationAddress), releaseCount },
    implementation: { codeBytes: (implementationCode.length - 2) / 2, albumSelectors: selectors, albumCapable },
    releases,
    marketplaceV3: v3,
    cronMarketplaces,
    verdict: {
      albumSinglePathDeployable: albumCapable,
      v3ParityOnChain: v3.matchesConfig,
      cronDeploymentsAreCanonical: cronMarketplaces.every((m) => m.isCanonicalV3),
    },
  }));
}

main().catch((error) => {
  console.error(`Probe failed: ${error.message}`);
  process.exitCode = 1;
});

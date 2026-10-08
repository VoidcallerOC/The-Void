#!/usr/bin/env node
/**
 * Read-only Fuji chain-authority probe.
 * Priority: receipts/logs > contract state > bytecode > manifests > indexer/reports.
 */
import { writeFileSync } from "node:fs";
import { JsonRpcProvider, Contract, Interface, getAddress, keccak256, isHexString } from "ethers";

const RPC = process.env.AVALANCHE_FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc";
const OUT = process.env.CHAIN_AUTHORITY_OUT || "/tmp/fuji-chain-authority-probe.json";

const CLAIMS = {
  legacyV1: {
    address: "0x262B774cf9a1949170B58E2d57F6189980FE757b",
    tx: "0x69eb5de1a6db53578d3995b5af34c0a78f47b27dee1c1a2b7aed6522b14f33f9",
    block: 58428586,
    source: "config/fuji-release.json legacyV1",
  },
  releaseV2: {
    address: "0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6",
    tx: "0x14dd51d90520a901200997b2233c7fb02fa42a6368188a4d879a72354b168c91",
    block: 59015108,
    source: "config/fuji-release.json",
  },
  primarySale: {
    address: "0x51cCD2d5Cd71368917f1EFe3fa43Fab8068E1aBA",
    tx: "0xc7525c83dbfa694578b199ccf41c27d88d967eb9bbfe585916e7197c12dfdbec",
    block: 59015114,
    source: "config/fuji-release.json",
  },
  primarySaleIssuerGrant: {
    tx: "0x47338566334db37d48a9d39d1e7eee145a23f03958a0ee3beb02834ea452decf",
    source: "config/fuji-release.json",
  },
  factoryV2: {
    address: "0xa5CbA0F91cb0A81e0A9Ce89A6722Cbe4eeC93505",
    tx: "0x734bbd165e28c25762e444b693d2e621eb392ee8f613b9d23ae97c2914cb5b0d",
    block: 59082607,
    source: "deployments/release-per-contract-fuji.json",
  },
  implementationV2: {
    address: "0xAe3257a441C5119Ee496330Dd93Deb06ab0eB8b4",
    source: "deployments/release-per-contract-fuji.json",
  },
  marketplaceV3: {
    address: "0x42B740aA92A6F48380F6D97AD91e332a7921a744",
    tx: "0x3d08466ab91b4f31fdb69aa42b3107d821c7cef5d53effad3e56f2affd8c3861",
    block: 59082610,
    source: "deployments/release-per-contract-fuji.json",
  },
  summitCertMalformedTx: {
    tx: "0x69eb5de1a6db53578d3995b5af34c0a78f47b27dee1c2a1b2a7aed6522b14f33f9",
    source: "THE-VOID-SUMMIT-CERTIFICATION.md",
  },
};

const FORGIVE_23_TOKEN =
  "5539478311145551066997171016458124004742133628133122798593311459807321372836";

function isTxHash(value) {
  return typeof value === "string" && isHexString(value, 32);
}

async function safe(fn) {
  try {
    const value = await fn();
    return { ok: true, value: typeof value === "bigint" ? value.toString() : value };
  } catch (error) {
    return { ok: false, error: error.shortMessage || error.message };
  }
}

async function getLogsChunked(provider, filter, chunk = 100000) {
  const logs = [];
  let start = filter.fromBlock;
  const toBlock = filter.toBlock;
  while (start <= toBlock) {
    const end = Math.min(start + chunk - 1, toBlock);
    try {
      logs.push(...(await provider.getLogs({ ...filter, fromBlock: start, toBlock: end })));
    } catch (error) {
      if (chunk <= 5000) throw error;
      const mid = Math.floor((start + end) / 2);
      logs.push(
        ...(await getLogsChunked(provider, { ...filter, fromBlock: start, toBlock: mid }, Math.floor(chunk / 2))),
      );
      logs.push(
        ...(await getLogsChunked(provider, { ...filter, fromBlock: mid + 1, toBlock: end }, Math.floor(chunk / 2))),
      );
    }
    start = end + 1;
  }
  return logs;
}

function b32toAscii(hex) {
  const raw = Buffer.from(hex.slice(2), "hex");
  const end = raw.indexOf(0);
  return raw.slice(0, end === -1 ? raw.length : end).toString("utf8");
}

const provider = new JsonRpcProvider(RPC, 43113);
const network = await provider.getNetwork();
const blockNumber = await provider.getBlockNumber();

const out = {
  probedAt: new Date().toISOString(),
  rpc: RPC,
  chainId: Number(network.chainId),
  blockNumber,
  receipts: {},
  code: {},
  state: {},
  decoded: {},
  steps: [],
  conflicts: [],
};

for (const [name, claim] of Object.entries(CLAIMS)) {
  if (claim.tx) {
    if (!isTxHash(claim.tx)) {
      out.receipts[name] = {
        found: false,
        invalidHash: true,
        claimedTx: claim.tx,
        source: claim.source,
        evidenceTier: 1,
      };
      out.conflicts.push({
        claim: `${name} tx`,
        issue: "Malformed transaction hash (not 32 bytes)",
        source: claim.source,
        authority: "hash validation before RPC",
      });
    } else {
      const receipt = await provider.getTransactionReceipt(claim.tx);
      out.receipts[name] = receipt
        ? {
            found: true,
            status: Number(receipt.status),
            blockNumber: Number(receipt.blockNumber),
            contractAddress: receipt.contractAddress,
            to: receipt.to,
            from: receipt.from,
            claimedBlock: claim.block ?? null,
            blockMatch: claim.block == null ? null : Number(receipt.blockNumber) === claim.block,
            source: claim.source,
            evidenceTier: 1,
          }
        : { found: false, claimedTx: claim.tx, source: claim.source, evidenceTier: 1 };
    }
  }
  if (claim.address) {
    const code = await provider.getCode(claim.address);
    out.code[name] = {
      address: getAddress(claim.address),
      hasCode: code !== "0x" && code.length > 2,
      codeBytes: code === "0x" ? 0 : (code.length - 2) / 2,
      runtimeBytecodeHash: code === "0x" ? null : keccak256(code),
      source: claim.source,
      evidenceTier: 2,
    };
  }
}

const editionIface = new Interface([
  "event EditionCreated(uint256 indexed tokenId, bytes32 indexed releaseId, bytes32 indexed editionId, address artist, uint256 maxSupply, string metadataUri)",
]);
const saleIface = new Interface([
  "event SaleConfigured(uint256 indexed tokenId, address indexed artist, uint256 priceWei, uint256 maxSupply, uint256 perWalletLimit, uint64 startTime, uint64 endTime, bool paused)",
  "event Purchased(uint256 indexed tokenId, address indexed buyer, uint256 qty, uint256 paid, uint256 artistCut, uint256 platformCut)",
]);
const factoryIface = new Interface([
  "event ReleaseCreated(address indexed releaseContract, bytes32 indexed releaseKey, address indexed artist, address primarySale, address provenanceAnchor, address implementation, uint256 index, uint16 version)",
]);

const releaseV2Logs = await getLogsChunked(provider, {
  address: CLAIMS.releaseV2.address,
  fromBlock: CLAIMS.releaseV2.block,
  toBlock: blockNumber,
  topics: [editionIface.getEvent("EditionCreated").topicHash],
});
out.decoded.releaseV2Editions = releaseV2Logs.map((log) => {
  const parsed = editionIface.parseLog({ topics: log.topics, data: log.data });
  return {
    tx: log.transactionHash,
    block: Number(log.blockNumber),
    tokenId: parsed.args.tokenId.toString(),
    releaseIdAscii: b32toAscii(parsed.args.releaseId),
    editionIdAscii: b32toAscii(parsed.args.editionId),
    artist: parsed.args.artist,
    maxSupply: parsed.args.maxSupply.toString(),
    metadataUri: parsed.args.metadataUri,
  };
});

const saleLogs = await getLogsChunked(provider, {
  address: CLAIMS.primarySale.address,
  fromBlock: CLAIMS.primarySale.block,
  toBlock: blockNumber,
});
out.decoded.saleEvents = saleLogs.map((log) => {
  try {
    const parsed = saleIface.parseLog({ topics: log.topics, data: log.data });
    if (parsed.name === "SaleConfigured") {
      return {
        event: parsed.name,
        tx: log.transactionHash,
        block: Number(log.blockNumber),
        tokenId: parsed.args.tokenId.toString(),
        artist: parsed.args.artist,
        priceWei: parsed.args.priceWei.toString(),
        maxSupply: parsed.args.maxSupply.toString(),
        perWalletLimit: parsed.args.perWalletLimit.toString(),
        startTime: Number(parsed.args.startTime),
        endTime: Number(parsed.args.endTime),
        paused: parsed.args.paused,
      };
    }
    return {
      event: parsed.name,
      tx: log.transactionHash,
      block: Number(log.blockNumber),
      tokenId: parsed.args.tokenId.toString(),
      buyer: parsed.args.buyer,
      qty: parsed.args.qty.toString(),
      paid: parsed.args.paid.toString(),
      artistCut: parsed.args.artistCut.toString(),
      platformCut: parsed.args.platformCut.toString(),
    };
  } catch (error) {
    return { tx: log.transactionHash, parseError: error.message, topic0: log.topics[0] };
  }
});

const factoryLogs = await getLogsChunked(provider, {
  address: CLAIMS.factoryV2.address,
  fromBlock: CLAIMS.factoryV2.block,
  toBlock: blockNumber,
  topics: [factoryIface.getEvent("ReleaseCreated").topicHash],
});
out.decoded.factoryReleases = factoryLogs.map((log) => {
  const parsed = factoryIface.parseLog({ topics: log.topics, data: log.data });
  return {
    tx: log.transactionHash,
    block: Number(log.blockNumber),
    releaseContract: parsed.args.releaseContract,
    releaseKey: parsed.args.releaseKey,
    artist: parsed.args.artist,
    primarySale: parsed.args.primarySale,
    provenanceAnchor: parsed.args.provenanceAnchor,
    implementation: parsed.args.implementation,
    index: parsed.args.index.toString(),
    version: Number(parsed.args.version),
  };
});

const sale = new Contract(
  CLAIMS.primarySale.address,
  [
    "function releases() view returns (address)",
    "function platformRecipient() view returns (address)",
    "function platformFeeBps() view returns (uint256)",
    "function sales(uint256) view returns (uint256 priceWei, uint256 maxSupply, uint256 sold, uint256 perWalletLimit, uint64 startTime, uint64 endTime, bool paused, bool configured)",
  ],
  provider,
);
const factory = new Contract(
  CLAIMS.factoryV2.address,
  [
    "function releaseCount() view returns (uint256)",
    "function releaseAt(uint256) view returns (address)",
    "function implementation() view returns (address)",
    "function platformRecipient() view returns (address)",
    "function PLATFORM_FEE_BPS() view returns (uint256)",
    "function primarySaleOf(address) view returns (address)",
    "function artistOf(address) view returns (address)",
  ],
  provider,
);
const marketplace = new Contract(
  CLAIMS.marketplaceV3.address,
  [
    "function registry() view returns (address)",
    "function feeRecipient() view returns (address)",
    "function platformFeeBps() view returns (uint256)",
    "function deploymentChainId() view returns (uint256)",
    "function nextListingId() view returns (uint256)",
  ],
  provider,
);
const release = new Contract(
  CLAIMS.releaseV2.address,
  ["function balanceOf(address,uint256) view returns (uint256)", "function paused() view returns (bool)"],
  provider,
);

out.state.primarySale = {
  releases: await safe(async () => getAddress(await sale.releases())),
  platformRecipient: await safe(async () => getAddress(await sale.platformRecipient())),
  platformFeeBps: await safe(async () => (await sale.platformFeeBps()).toString()),
};
out.state.factoryV2 = {
  releaseCount: await safe(async () => (await factory.releaseCount()).toString()),
  implementation: await safe(async () => getAddress(await factory.implementation())),
  platformRecipient: await safe(async () => getAddress(await factory.platformRecipient())),
  PLATFORM_FEE_BPS: await safe(async () => (await factory.PLATFORM_FEE_BPS()).toString()),
};
out.state.marketplaceV3 = {
  registry: await safe(async () => getAddress(await marketplace.registry())),
  feeRecipient: await safe(async () => getAddress(await marketplace.feeRecipient())),
  platformFeeBps: await safe(async () => (await marketplace.platformFeeBps()).toString()),
  deploymentChainId: await safe(async () => (await marketplace.deploymentChainId()).toString()),
  nextListingId: await safe(async () => (await marketplace.nextListingId()).toString()),
};
out.state.releaseV2Paused = await safe(async () => release.paused());

const forgiveSale = await sale.sales(FORGIVE_23_TOKEN);
out.state.forgiveForget23Sale = {
  tokenId: FORGIVE_23_TOKEN,
  priceWei: forgiveSale.priceWei.toString(),
  maxSupply: forgiveSale.maxSupply.toString(),
  sold: forgiveSale.sold.toString(),
  perWalletLimit: forgiveSale.perWalletLimit.toString(),
  startTime: Number(forgiveSale.startTime),
  endTime: Number(forgiveSale.endTime),
  paused: forgiveSale.paused,
  configured: forgiveSale.configured,
};

out.state.salesByEdition = {};
for (const edition of out.decoded.releaseV2Editions) {
  const saleState = await sale.sales(edition.tokenId);
  out.state.salesByEdition[edition.releaseIdAscii] = {
    tokenId: edition.tokenId,
    editionTx: edition.tx,
    priceWei: saleState.priceWei.toString(),
    sold: saleState.sold.toString(),
    configured: saleState.configured,
    paused: saleState.paused,
    perWalletLimit: saleState.perWalletLimit.toString(),
  };
}

const purchases = out.decoded.saleEvents.filter((event) => event.event === "Purchased");
out.state.ownershipAfterPurchase = [];
for (const purchase of purchases) {
  const balance = await release.balanceOf(purchase.buyer, purchase.tokenId);
  out.state.ownershipAfterPurchase.push({
    tx: purchase.tx,
    buyer: purchase.buyer,
    tokenId: purchase.tokenId,
    balanceOf: balance.toString(),
  });
}

function step(id, claim, status, tier, evidence) {
  out.steps.push({ id, claim, status, evidenceTier: tier, evidence });
}

step("rpc-chain", "Fuji chain ID 43113", out.chainId === 43113 ? "VERIFIED" : "FAILED", 1, {
  chainId: out.chainId,
  blockNumber: out.blockNumber,
});

for (const name of ["legacyV1", "releaseV2", "primarySale", "factoryV2", "marketplaceV3", "primarySaleIssuerGrant"]) {
  const receipt = out.receipts[name];
  step(
    `receipt-${name}`,
    `Successful receipt for ${name}`,
    receipt?.found && receipt.status === 1 ? "VERIFIED" : "UNVERIFIED",
    1,
    receipt,
  );
}

step(
  "summit-cert-tx",
  "Summit certification deployment tx hash",
  out.receipts.summitCertMalformedTx?.invalidHash ? "CONFLICT" : "UNVERIFIED",
  1,
  {
    ...out.receipts.summitCertMalformedTx,
    note: "Malformed hash in THE-VOID-SUMMIT-CERTIFICATION.md; config/fuji-release.json legacy hash verifies",
  },
);

for (const name of ["legacyV1", "releaseV2", "primarySale", "factoryV2", "marketplaceV3", "implementationV2"]) {
  step(
    `bytecode-${name}`,
    `Runtime bytecode present at ${name}`,
    out.code[name]?.hasCode ? "VERIFIED" : "FAILED",
    2,
    out.code[name],
  );
}

step(
  "sale-release-link",
  "Shared primary sale.releases() == release V2",
  out.state.primarySale.releases?.ok &&
    out.state.primarySale.releases.value === getAddress(CLAIMS.releaseV2.address)
    ? "VERIFIED"
    : "FAILED",
  2,
  out.state.primarySale,
);

step(
  "marketplace-registry-link",
  "Marketplace.registry() == factory V2",
  out.state.marketplaceV3.registry?.ok &&
    out.state.marketplaceV3.registry.value === getAddress(CLAIMS.factoryV2.address)
    ? "VERIFIED"
    : "FAILED",
  2,
  out.state.marketplaceV3,
);

step(
  "factory-releases",
  "Factory ReleaseCreated activity",
  out.decoded.factoryReleases.length > 0 ? "VERIFIED" : "UNVERIFIED",
  1,
  { count: out.decoded.factoryReleases.length, events: out.decoded.factoryReleases },
);

step(
  "forgive-23-edition",
  "forgive-forget-23 EditionCreated",
  out.decoded.releaseV2Editions.some((edition) => edition.releaseIdAscii === "forgive-forget-23")
    ? "VERIFIED"
    : "UNVERIFIED",
  1,
  out.decoded.releaseV2Editions.find((edition) => edition.releaseIdAscii === "forgive-forget-23") || null,
);

step(
  "forgive-23-sale-configured",
  "forgive-forget-23 sales(tokenId).configured",
  out.state.forgiveForget23Sale.configured ? "VERIFIED" : "UNVERIFIED",
  2,
  out.state.forgiveForget23Sale,
);

step(
  "forgive-23-purchase",
  "forgive-forget-23 collector Purchased",
  purchases.some((purchase) => purchase.tokenId === FORGIVE_23_TOKEN) ? "VERIFIED" : "UNVERIFIED",
  1,
  {
    sold: out.state.forgiveForget23Sale.sold,
    purchasesForToken: purchases.filter((purchase) => purchase.tokenId === FORGIVE_23_TOKEN),
  },
);

step(
  "any-v2-purchase",
  "At least one V2 primary-sale Purchased + balanceOf",
  purchases.length > 0 && out.state.ownershipAfterPurchase.every((row) => row.balanceOf !== "0")
    ? "VERIFIED"
    : "UNVERIFIED",
  1,
  { purchases, ownershipAfterPurchase: out.state.ownershipAfterPurchase },
);

step(
  "marketplace-listing-activity",
  "Marketplace listing/sale logs",
  out.state.marketplaceV3.nextListingId?.ok && out.state.marketplaceV3.nextListingId.value === "1"
    ? "VERIFIED_ZERO"
    : "PARTIAL",
  2,
  {
    nextListingId: out.state.marketplaceV3.nextListingId,
    note: "nextListingId == 1 means no ListingCreated has advanced the counter",
  },
);

step(
  "operator-e2e-passed",
  "Operator/report claim that full E2E passed",
  "NOT_ACCEPTED_AS_PROOF",
  6,
  { rule: "CHAIN-AUTHORITY.md — tier 6/7 alone is insufficient" },
);

writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ outPath: OUT, chainId: out.chainId, blockNumber: out.blockNumber, steps: out.steps }, null, 2));

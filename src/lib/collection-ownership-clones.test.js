import { describe, expect, it } from "vitest";
import { mapPublishedCatalog, withOwnableDuplicates } from "./catalog-source.js";
import { getCollectorLibrary } from "./collection.js";
import { FUJI_RELEASE_CONFIG } from "./fuji-release.js";
import { buildMarketplaceOwnershipConfig, isCertifiedReleaseCloneEdition } from "./marketplace-ownership.js";
import { collapsePublicCatalog } from "./summit-demo.js";
import { checkCollectionOwnershipRecords } from "./web3.js";

// Real Fuji values: the Forgive & Forget edition on a per-release factory clone, and the same
// wallet's older holding on the legacy shared contract.
const WALLET = "0x6a86efa012feda64b70112022487fee22e67d2fb";
const FACTORY = "0x3e4E0d9187f6fD11bD6d792a7088D0c2dE8E3aC8";
const CLONE = "0xe87410E9a2c703B6BB696D4bFB5f268d3C5BCf65";
const OTHER_CLONE = "0x4b2790791e2ac123cb012d33cc8f1ecbdc9b9bb0";
const CLONE_TOKEN = "25679935302133066722236771263728427871936411831072189551573738559199048803312";
const LEGACY = FUJI_RELEASE_CONFIG.contractAddress;
const LEGACY_TOKEN = "68295446124735607526723992966590672866552040894184280645408531208339092616023";
const word = (value) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;

const artist = { id: "voidcaller", display_name: "VOIDCALLER", slug: "voidcaller" };
const release = (id, overrides = {}) => ({ id, artist_id: "voidcaller", title: "Forgive & Forget", status: "PUBLISHED", ...overrides });
const edition = (id, releaseId, overrides = {}) => ({
  id,
  release_id: releaseId,
  title: "Forgive & Forget",
  status: "PUBLISHED",
  chain_id: FUJI_RELEASE_CONFIG.chainId,
  contract_address: CLONE,
  release_contract_address: CLONE,
  factory_address: FACTORY,
  token_id: CLONE_TOKEN,
  ...overrides,
});

// balances: { "<contract lowercase>:<tokenId>": amount | Error }
function rpcFor(balances) {
  const calls = [];
  const rpc = async (rpcUrl, target, data) => {
    calls.push({ rpcUrl, target: target.toLowerCase(), tokenId: BigInt(`0x${data.slice(2 + 8 + 64)}`).toString() });
    const value = balances[`${target.toLowerCase()}:${BigInt(`0x${data.slice(2 + 8 + 64)}`)}`];
    if (value instanceof Error) throw value;
    return word(value || 0);
  };
  return { rpc, calls };
}

function resolve(rows) {
  const catalog = withOwnableDuplicates(collapsePublicCatalog(mapPublishedCatalog({ artists: [artist], ...rows })));
  return { catalog, config: buildMarketplaceOwnershipConfig(catalog.editions) };
}

describe("My Collection ownership across certified release contracts", () => {
  const cloneRows = { releases: [release("r-clone")], editions: [edition("e-clone", "r-clone")] };

  it("builds the exact (chain, contract, token) tuple for a factory-clone edition without special-casing it", () => {
    const { config } = resolve(cloneRows);
    expect(config.assets).toEqual([{ chainKey: "fuji", chainId: 43113, contract: CLONE.toLowerCase(), tokenId: CLONE_TOKEN }]);
    expect(config.chains.fuji.contract).toBe(LEGACY);
  });

  it("shows a wallet that owns 2 copies on a factory clone, with quantity 2 and the right release/contract/token", async () => {
    const { catalog, config } = resolve(cloneRows);
    const { rpc, calls } = rpcFor({ [`${CLONE.toLowerCase()}:${BigInt(CLONE_TOKEN)}`]: 2 });
    const records = await checkCollectionOwnershipRecords(WALLET, { ...config, rpc });
    const clone = records.find((record) => record.contract === CLONE.toLowerCase());

    expect(clone).toMatchObject({ wallet: WALLET, tokenId: CLONE_TOKEN, amount: 2, chain: { key: "fuji", id: 43113 } });
    expect(calls.find((call) => call.target === CLONE.toLowerCase())).toMatchObject({ rpcUrl: FUJI_RELEASE_CONFIG.rpcUrl, tokenId: CLONE_TOKEN });

    const library = getCollectorLibrary(catalog, records);
    expect(library.tokens).toHaveLength(1);
    expect(library.tokens[0]).toMatchObject({ amount: 2, contract: CLONE.toLowerCase(), tokenId: CLONE_TOKEN });
    expect(library.tokens[0].edition).toMatchObject({ id: "e-clone", releaseId: "r-clone", contractAddress: CLONE, chainId: 43113 });
    expect(library.tokens[0].release.id).toBe("r-clone");
  });

  it("keeps legacy-contract holdings and clone holdings together for one wallet", async () => {
    const { catalog, config } = resolve({
      releases: [release("r-clone", { published_at: "2026-10-13T00:00:00Z" }), release("r-rehearsal", { title: "Fuji Rehearsal A" })],
      editions: [
        edition("e-clone", "r-clone"),
        edition("e-rehearsal", "r-rehearsal", { title: "Fuji Rehearsal A", contract_address: LEGACY, release_contract_address: LEGACY, factory_address: undefined, token_id: LEGACY_TOKEN }),
      ],
    });
    expect(config.chains.fuji.tokenIds).toEqual([LEGACY_TOKEN]);
    const { rpc } = rpcFor({ [`${CLONE.toLowerCase()}:${BigInt(CLONE_TOKEN)}`]: 2, [`${LEGACY.toLowerCase()}:${BigInt(LEGACY_TOKEN)}`]: 1 });
    const records = await checkCollectionOwnershipRecords(WALLET, { ...config, rpc });
    const library = getCollectorLibrary(catalog, records);

    expect(library.tokens.map((token) => [token.edition.id, token.amount]).sort()).toEqual([["e-clone", 2], ["e-rehearsal", 1]]);
  });

  it("does not hide an owned edition when two releases share a title on different contracts", async () => {
    const rows = {
      releases: [
        release("r-new", { published_at: "2026-10-13T00:00:00Z" }),
        release("r-old", { published_at: "2026-10-04T00:00:00Z" }),
      ],
      editions: [
        edition("e-new", "r-new"),
        edition("e-old", "r-old", { contract_address: LEGACY, release_contract_address: LEGACY, factory_address: undefined, token_id: LEGACY_TOKEN }),
      ],
    };
    const collapsed = collapsePublicCatalog(mapPublishedCatalog({ artists: [artist], ...rows }));
    // Discovery still shows one Forgive & Forget...
    expect(collapsed.editions.map((item) => item.id)).toEqual(["e-new"]);
    expect(collapsed.duplicates.editions.map((item) => item.id)).toEqual(["e-old"]);

    // ...but ownership resolves by edition identity, so the hidden edition is queried and shown.
    const { catalog, config } = resolve(rows);
    expect(config.chains.fuji.tokenIds).toEqual([LEGACY_TOKEN]);
    const { rpc } = rpcFor({ [`${CLONE.toLowerCase()}:${BigInt(CLONE_TOKEN)}`]: 2, [`${LEGACY.toLowerCase()}:${BigInt(LEGACY_TOKEN)}`]: 1 });
    const library = getCollectorLibrary(catalog, await checkCollectionOwnershipRecords(WALLET, { ...config, rpc }));
    expect(library.tokens.map((token) => [token.edition.id, token.amount]).sort()).toEqual([["e-new", 2], ["e-old", 1]]);
  });

  it("keeps same-token-ID editions on different clones distinct by contract", async () => {
    const { catalog, config } = resolve({
      releases: [release("r-a", { published_at: "2026-10-13T00:00:00Z" }), release("r-b", { published_at: "2026-10-10T00:00:00Z" })],
      editions: [edition("e-a", "r-a"), edition("e-b", "r-b", { contract_address: OTHER_CLONE, release_contract_address: OTHER_CLONE })],
    });
    expect(config.assets.map((asset) => asset.contract).sort()).toEqual([CLONE.toLowerCase(), OTHER_CLONE].sort());
    const { rpc } = rpcFor({ [`${CLONE.toLowerCase()}:${BigInt(CLONE_TOKEN)}`]: 2 });
    const library = getCollectorLibrary(catalog, await checkCollectionOwnershipRecords(WALLET, { ...config, rpc }));
    expect(library.tokens.map((token) => [token.edition.id, token.amount])).toEqual([["e-a", 2]]);
  });

  it("omits zero balances and survives failed balance reads", async () => {
    const { config } = resolve({
      releases: [release("r-a", { published_at: "2026-10-13T00:00:00Z" }), release("r-b", { title: "Other", published_at: "2026-10-10T00:00:00Z" })],
      editions: [edition("e-a", "r-a"), edition("e-b", "r-b", { title: "Other", contract_address: OTHER_CLONE, release_contract_address: OTHER_CLONE })],
    });
    const zero = await checkCollectionOwnershipRecords(WALLET, { ...config, rpc: rpcFor({}).rpc });
    expect(zero.filter((record) => record.chain.key === "fuji")).toEqual([]);

    const failing = rpcFor({ [`${CLONE.toLowerCase()}:${BigInt(CLONE_TOKEN)}`]: new Error("rpc down"), [`${OTHER_CLONE}:${BigInt(CLONE_TOKEN)}`]: 3 });
    const records = await checkCollectionOwnershipRecords(WALLET, { ...config, rpc: failing.rpc });
    expect(records.filter((record) => record.chain.key === "fuji").map((record) => [record.contract, record.amount])).toEqual([[OTHER_CLONE, 3]]);
  });

  it("never queries editions on another chain, on an unknown factory, or that are unverified or malformed", () => {
    const bad = [
      edition("wrong-chain", "r-clone", { chain_id: 43114 }),
      edition("unknown-factory", "r-clone", { factory_address: "0x1111111111111111111111111111111111111111" }),
      edition("no-factory", "r-clone", { factory_address: undefined, contract_address: OTHER_CLONE, release_contract_address: OTHER_CLONE }),
      edition("mismatched-release", "r-clone", { contract_address: OTHER_CLONE, release_contract_address: CLONE }),
      edition("bad-address", "r-clone", { contract_address: "0xnot-an-address", release_contract_address: "0xnot-an-address" }),
      edition("draft", "r-clone", { status: "DRAFT" }),
      edition("bad-token", "r-clone", { token_id: "12abc" }),
    ];
    const mapped = mapPublishedCatalog({ artists: [artist], releases: [release("r-clone")], editions: bad });
    // The malformed token ID belongs to an otherwise certified edition; it is dropped per token.
    expect(mapped.editions.map(isCertifiedReleaseCloneEdition)).toEqual([false, false, false, false, false, false, true]);
    expect(buildMarketplaceOwnershipConfig(mapped.editions).assets).toEqual([]);
  });

  it("ignores malformed, unknown-chain and already-read tuples and never calls the RPC for them", async () => {
    const { rpc, calls } = rpcFor({});
    await checkCollectionOwnershipRecords(WALLET, {
      chains: { fuji: { key: "fuji", id: 43113, name: "Fuji", rpc: "https://rpc.example", contract: LEGACY, tokenIds: [LEGACY_TOKEN] } },
      assets: [
        { chainKey: "fuji", contract: LEGACY, tokenId: LEGACY_TOKEN },
        { chainKey: "nowhere", contract: CLONE, tokenId: CLONE_TOKEN },
        { chainKey: "fuji", contract: "0xbad", tokenId: CLONE_TOKEN },
        { chainKey: "fuji", contract: CLONE, tokenId: "-1" },
        { chainKey: "fuji", contract: CLONE, tokenId: CLONE_TOKEN },
        { chainKey: "fuji", contract: CLONE, tokenId: CLONE_TOKEN },
      ],
      rpc,
    });
    expect(calls.map((call) => `${call.target}:${call.tokenId}`).sort()).toEqual([`${CLONE.toLowerCase()}:${CLONE_TOKEN}`, `${LEGACY.toLowerCase()}:${LEGACY_TOKEN}`].sort());
  });

  it("returns no records without a wallet", async () => {
    expect(await checkCollectionOwnershipRecords("", { ...resolve(cloneRows).config, rpc: rpcFor({}).rpc })).toEqual([]);
  });
});

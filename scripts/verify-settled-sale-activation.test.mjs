import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import { haveSettledArtifact, settledRuntime } from "../src/lib/test-fixtures/settled-sale.js";
import { ISSUER_ROLE } from "../src/lib/sale-authorization.js";
import { MAINNET_DEFAULTS, RELEASE_ROLE_GRANTED, RELEASE_ROLE_REVOKED, parseArgs, rpcProvider, scanIssuerHolders, verifyActivation } from "./verify-settled-sale-activation.mjs";

const RELEASE = ethers.getAddress(MAINNET_DEFAULTS.release);
const OLD_SALE = ethers.getAddress(MAINNET_DEFAULTS.oldSale);
const SALE = ethers.getAddress("0x1111111111111111111111111111111111111111");
const FACTORY = ethers.getAddress("0x262b774cf9a1949170b58e2d57f6189980fe757b");
const MARKET = ethers.getAddress("0x0e77116142844478a55eed2ab79de9f93770f8f5");
const ARTIST = ethers.getAddress("0x284c09a7cc187e096cbbdc88d99defe6df32180a");
const PLATFORM = ethers.getAddress("0xb65c575cae01574296fab6e620b9a15cc0121ce4");
const ROGUE = ethers.getAddress("0x2222222222222222222222222222222222222222");
const KEY = `0x${"ab".repeat(32)}`;
const coder = ethers.AbiCoder.defaultAbiCoder();
const iface = new ethers.Interface([
  "function releases() view returns (address)", "function platformRecipient() view returns (address)", "function PLATFORM_FEE_BPS() view returns (uint256)", "function owner() view returns (address)",
  "function hasRole(bytes32,address) view returns (bool)", "function isRelease(address) view returns (bool)", "function primarySaleOf(address) view returns (address)",
  "function balances(address) view returns (uint256)", "function registry() view returns (address)", "function releaseKey() view returns (bytes32)",
]);
const roleLog = (topic, account, block, logIndex = 0) => ({ topics: [topic, ISSUER_ROLE, ethers.zeroPadValue(account, 32), ethers.zeroPadValue(ARTIST, 32)], blockNumber: ethers.toQuantity(block), logIndex: ethers.toQuantity(logIndex) });
const grant = (account, block, i) => roleLog(RELEASE_ROLE_GRANTED, account, block, i);
const revoke = (account, block, i) => roleLog(RELEASE_ROLE_REVOKED, account, block, i);

function chain({ saleCode = settledRuntime({ release: RELEASE, platform: PLATFORM }), issuers = new Set([SALE]), logs = null, heldOld = ethers.parseEther("0.25"), chainId = "0xa86a", head = 450 } = {}) {
  const roleLogs = logs ?? [grant(ARTIST, 100, 0), grant(OLD_SALE, 100, 1), revoke(ARTIST, 100, 2), grant(SALE, 200, 0), revoke(OLD_SALE, 200, 1)];
  const requests = [];
  return {
    requests,
    request: async ({ method, params }) => {
      requests.push(method);
      if (method === "eth_chainId") return chainId;
      if (method === "eth_blockNumber") return ethers.toQuantity(head);
      if (method === "eth_getCode") return params[0].toLowerCase() === SALE.toLowerCase() ? saleCode : "0x";
      if (method === "eth_getBalance") return ethers.toQuantity(heldOld);
      if (method === "eth_getLogs") {
        const from = Number(params[0].fromBlock); const to = Number(params[0].toBlock);
        return roleLogs.filter((entry) => Number(entry.blockNumber) >= from && Number(entry.blockNumber) <= to);
      }
      if (method !== "eth_call") throw new Error(`unexpected ${method}`);
      const { to, data } = params[0];
      const parsed = iface.parseTransaction({ data });
      const t = to.toLowerCase();
      const out = (type, value) => coder.encode([type], [value]);
      switch (parsed.name) {
        case "releases": return out("address", RELEASE);
        case "platformRecipient": return out("address", PLATFORM);
        case "PLATFORM_FEE_BPS": return out("uint256", 250n);
        case "owner": throw Object.assign(new Error("execution reverted"), { code: 3 });
        case "hasRole": return out("bool", issuers.has(ethers.getAddress(parsed.args[1])));
        case "isRelease": return out("bool", true);
        case "primarySaleOf": return out("address", OLD_SALE);
        case "balances": return out("uint256", t === OLD_SALE.toLowerCase() ? (parsed.args[0] === ARTIST ? ethers.parseEther("0.24375") : ethers.parseEther("0.00625")) : 0n);
        case "registry": return out("address", FACTORY);
        case "releaseKey": return out("bytes32", KEY);
        default: throw new Error(`unexpected call ${parsed.name}`);
      }
    },
  };
}
const options = { chainId: 43114, sale: SALE, release: RELEASE, factory: FACTORY, oldSale: OLD_SALE, artist: ARTIST, platformRecipient: PLATFORM, marketplace: MARKET, fromBlock: 0, chunk: 100, concurrency: 4 };
const named = (result, fragment) => result.checks.find((check) => check.name.includes(fragment));

describe("parseArgs", () => {
  it("applies the mainnet defaults and manifest values, and parses overrides", () => {
    const parsed = parseArgs(["--rpc", "http://x", "--sale", SALE, "--chunk", "50"], { factoryAddress: FACTORY, marketplaceAddress: MARKET, platformRecipient: PLATFORM, artistWallet: ARTIST });
    expect(parsed).toMatchObject({ rpc: "http://x", sale: SALE, chunk: 50, chainId: 43114, fromBlock: 97932485, factory: FACTORY, platformRecipient: PLATFORM, oldSale: MAINNET_DEFAULTS.oldSale });
    expect(() => parseArgs(["--nope", "1"])).toThrow(/Unknown argument/);
    expect(() => parseArgs(["--rpc"])).toThrow(/needs a value/);
  });
});

describe("scanIssuerHolders", () => {
  it("replays grants and revokes in order across chunks", async () => {
    const provider = chain({ logs: [grant(ARTIST, 5, 0), grant(OLD_SALE, 120, 0), revoke(ARTIST, 150, 0), grant(SALE, 210, 0), revoke(OLD_SALE, 210, 1), grant(ROGUE, 399, 0)] });
    const scan = await scanIssuerHolders(provider, { release: RELEASE, fromBlock: 0, toBlock: 450, chunk: 100, concurrency: 3 });
    expect(scan.holders.sort()).toEqual([ROGUE, SALE].sort());
    expect(scan.ranges).toBe(5);
    expect(scan.events).toBe(6);
  });
});

describe.skipIf(!haveSettledArtifact)("verifyActivation", () => {
  it("passes when the reviewed sale is the only minter and every credit is intact", async () => {
    const result = await verifyActivation(chain(), options);
    expect(result.checks.filter((check) => !check.pass)).toEqual([]);
    expect(result.pass).toBe(true);
    expect(named(result, "ONLY ISSUER_ROLE holder").detail).toMatch(/holders: 0x1111/);
  });
  it("fails and names a rogue minter that holds ISSUER_ROLE", async () => {
    const result = await verifyActivation(chain({ logs: [grant(SALE, 200, 0), grant(ROGUE, 300, 0)] }), options);
    expect(result.pass).toBe(false);
    expect(named(result, "ONLY ISSUER_ROLE holder")).toMatchObject({ pass: false });
    expect(named(result, "ONLY ISSUER_ROLE holder").detail).toContain(ROGUE);
  });
  it("fails when the old sale can still mint or the artist became an issuer", async () => {
    const result = await verifyActivation(chain({ issuers: new Set([SALE, OLD_SALE, ARTIST]) }), options);
    expect(named(result, "old factory-made sale")).toMatchObject({ pass: false });
    expect(named(result, "artist wallet does not hold")).toMatchObject({ pass: false });
  });
  it("fails when the sale address has no code, without crashing", async () => {
    const result = await verifyActivation(chain({ saleCode: "0x" }), options);
    expect(result.pass).toBe(false);
    expect(named(result, "sale has contract code")).toMatchObject({ pass: false });
    expect(named(result, "sale has contract code").detail).toMatch(/no contract code/);
  });
  it("fails when the deployed code is not the reviewed code", async () => {
    const bytes = ethers.getBytes(settledRuntime({ release: RELEASE, platform: PLATFORM }));
    bytes[500] ^= 0xff;
    const result = await verifyActivation(chain({ saleCode: ethers.hexlify(bytes) }), options);
    expect(result.pass).toBe(false);
    expect(named(result, "reviewed VoidPrimarySaleSettled")).toMatchObject({ pass: false });
  });
  it("fails when the old sale no longer holds its credits", async () => {
    const result = await verifyActivation(chain({ heldOld: ethers.parseEther("0.1") }), options);
    expect(named(result, "nothing lost")).toMatchObject({ pass: false });
  });
  it("fails on the wrong chain", async () => {
    const result = await verifyActivation(chain({ chainId: "0xa869" }), options);
    expect(named(result, "chain id is 43114")).toMatchObject({ pass: false });
  });
});

describe("rpcProvider", () => {
  const reply = (status, text) => ({ status, text: async () => text });
  it("retries rate limits and HTML error pages, then returns the result", async () => {
    const answers = [reply(429, "slow down"), reply(200, "<!doctype html><title>busy</title>"), reply(200, JSON.stringify({ result: "0x1" }))];
    const provider = rpcProvider("http://x", { fetchImpl: async () => answers.shift(), baseDelayMs: 1 });
    expect(await provider.request({ method: "eth_chainId" })).toBe("0x1");
    expect(answers).toHaveLength(0);
  });
  it("throws a real RPC error (a revert) without retrying", async () => {
    let calls = 0;
    const provider = rpcProvider("http://x", { fetchImpl: async () => { calls += 1; return reply(200, JSON.stringify({ error: { code: 3, message: "execution reverted" } })); }, baseDelayMs: 1 });
    await expect(provider.request({ method: "eth_call" })).rejects.toThrow("execution reverted");
    expect(calls).toBe(1);
  });
  it("gives up after the retry budget", async () => {
    const provider = rpcProvider("http://x", { fetchImpl: async () => reply(503, "down"), retries: 2, baseDelayMs: 1 });
    await expect(provider.request({ method: "eth_chainId" })).rejects.toThrow(/HTTP 503/);
  });
});

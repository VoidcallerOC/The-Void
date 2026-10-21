import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Interface, getAddress } from "ethers";
import { LEGACY_COLLECTION_MARKETPLACE } from "../config/legacy-collection-marketplace.js";
import { RELEASE_PER_CONTRACT_MANIFESTS } from "../config/release-network.js";
import { buildDeploymentPlan, main, validateOwnerSafe } from "./prepare-legacy-marketplace-deployment.mjs";

const SAFE = new Interface(["function getThreshold() view returns (uint256)", "function getOwners() view returns (address[])", "function VERSION() view returns (string)"]);
const SAFE_ADDRESS = getAddress("0x1111111111111111111111111111111111111111");
const SIGNERS = [getAddress("0x2222222222222222222222222222222222222222"), getAddress("0x3333333333333333333333333333333333333333"), getAddress("0x4444444444444444444444444444444444444444")];
const mainnet = RELEASE_PER_CONTRACT_MANIFESTS.mainnet;

function rpcFor({ chainId = 43114, code = "0x6080", threshold = 2n, owners = SIGNERS, isSafe = true } = {}) {
  return {
    chainId: async () => BigInt(chainId),
    getCode: async () => code,
    call: async (_to, data) => {
      if (!isSafe) throw new Error("execution reverted");
      const name = SAFE.parseTransaction({ data }).name;
      return SAFE.encodeFunctionResult(name, { getThreshold: [threshold], getOwners: [owners], VERSION: ["1.4.1"] }[name]);
    },
  };
}
const check = (address, rpc = rpcFor(), extra = {}) => validateOwnerSafe({ address, rpc, ...extra });

describe("owner Safe validation (address validity only)", () => {
  it("is BLOCKED, not failed or guessed, when no address is supplied", async () => {
    for (const missing of [undefined, "", "   "]) {
      const result = await check(missing);
      expect(result).toMatchObject({ ok: false, blocked: true });
    }
  });

  it("accepts a Safe-shaped contract on the intended chain and reports its threshold and signers", async () => {
    const result = await check(SAFE_ADDRESS);
    expect(result).toMatchObject({ ok: true, blocked: false, problems: [], info: { owner: SAFE_ADDRESS, chainId: 43114, threshold: 2, version: "1.4.1" } });
    expect(result.info.signers).toEqual(SIGNERS);
  });

  it("rejects malformed, zero and role-colliding owners (deployer, fee recipient, factory, V4 marketplace, Genesis)", async () => {
    expect((await check("0x1234")).ok).toBe(false);
    expect((await check("0x0000000000000000000000000000000000000000")).problems.join(" ")).toMatch(/zero address/);
    for (const colliding of [mainnet.deployerAddress, mainnet.marketplaceFeeRecipient, mainnet.factoryAddress, mainnet.marketplaceAddress, LEGACY_COLLECTION_MARKETPLACE.collections[0].address]) {
      const result = await check(colliding.toLowerCase());
      expect(result.ok).toBe(false);
      expect(result.problems.join(" ")).toMatch(/may not be/);
    }
    expect((await check(SAFE_ADDRESS, rpcFor(), { extraForbidden: [SAFE_ADDRESS] })).ok).toBe(false);
  });

  it("rejects the wrong chain, an EOA, and a contract that is not a Safe", async () => {
    expect((await check(SAFE_ADDRESS, rpcFor({ chainId: 43113 }))).problems.join(" ")).toMatch(/chain 43113/);
    expect((await check(SAFE_ADDRESS, rpcFor({ code: "0x" }))).problems.join(" ")).toMatch(/no contract code/);
    expect((await check(SAFE_ADDRESS, rpcFor({ isSafe: false }))).problems.join(" ")).toMatch(/does not look like a Safe/);
    expect((await check(SAFE_ADDRESS, rpcFor({ threshold: 5n }))).problems.join(" ")).toMatch(/inconsistent/);
  });

  it("warns, without failing, about a single-signer threshold or the deployer being a signer", async () => {
    const single = await check(SAFE_ADDRESS, rpcFor({ threshold: 1n }));
    expect(single.ok).toBe(true);
    expect(single.warnings.join(" ")).toMatch(/threshold is below 2/);
    const withDeployer = await check(SAFE_ADDRESS, rpcFor({ owners: [getAddress(mainnet.deployerAddress), ...SIGNERS] }));
    expect(withDeployer.ok).toBe(true);
    expect(withDeployer.warnings.join(" ")).toMatch(/deployer wallet is one of the Safe's signers/);
  });
});

describe("deployment plan (dry run)", () => {
  it("encodes exactly the confirmed candidate scope and never broadcasts", () => {
    const plan = buildDeploymentPlan({ owner: SAFE_ADDRESS });
    expect(plan.broadcast).toBe(false);
    expect(plan.chainId).toBe(43114);
    // Genesis policy: the constructor takes only the owner; there is no fee or fee recipient to configure.
    expect(plan.constructor).toEqual({ owner: SAFE_ADDRESS });
    expect(plan.constructorArgsEncoded).toBe(`0x${SAFE_ADDRESS.slice(2).toLowerCase().padStart(64, "0")}`);
    expect(plan.economics.platformFeeBps).toBe(0);
    const call = new Interface(["function allowCollection(address,uint16,uint256,uint256)"]).decodeFunctionData("allowCollection", plan.postDeploy[0].calldata);
    expect([call[0], Number(call[1]), Number(call[2]), Number(call[3])]).toEqual([getAddress("0xD1B4367dd9f235f9ee61878019d66E31511E98eE"), 500, 0, 3]);
    expect(plan.manifestAfterVerification.deployed).toBe(true); // a description of the later, separately approved edit
  });

  it("leaves the owner unset (null) until one is supplied and never substitutes the deployer", () => {
    const plan = buildDeploymentPlan({ owner: null });
    expect(plan.constructor.owner).toBeNull();
    expect(plan.constructorArgsEncoded).toBeNull();
    expect(JSON.stringify(plan).toLowerCase()).not.toContain(mainnet.deployerAddress.toLowerCase());
  });

  it("refuses a manifest that records any platform fee", () => {
    expect(() => buildDeploymentPlan({ manifest: { ...LEGACY_COLLECTION_MARKETPLACE, platformFeeBps: 250 }, owner: SAFE_ADDRESS })).toThrow(/no platform fee/);
  });

  it("refuses a multi-collection allowlist: the candidate is Genesis only", () => {
    const twin = { ...LEGACY_COLLECTION_MARKETPLACE, collections: [...LEGACY_COLLECTION_MARKETPLACE.collections, LEGACY_COLLECTION_MARKETPLACE.collections[0]] };
    expect(() => buildDeploymentPlan({ manifest: twin, owner: SAFE_ADDRESS })).toThrow(/exactly one collection/);
  });

  it("main() exits BLOCKED (3) without a Safe and touches no signer, key or transaction API", async () => {
    const lines = [];
    expect(await main({}, (line) => lines.push(line))).toBe(3);
    expect(lines.join("\n")).toMatch(/BLOCKED/);
    const source = readFileSync(new URL("./prepare-legacy-marketplace-deployment.mjs", import.meta.url), "utf8");
    expect(source).not.toMatch(/PRIVATE_KEY|new Wallet|sendTransaction|eth_sendRawTransaction|getSigner|signTransaction|broadcast\(/);
  });
});

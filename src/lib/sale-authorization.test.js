import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import { haveSettledArtifact, settledRuntime as settledRuntimeFor } from "./test-fixtures/settled-sale.js";
import { ISSUER_ROLE, SETTLED_SALE_IMMUTABLE_RANGES, SETTLED_SALE_RUNTIME_CODE_HASH, maskedRuntimeHash, verifyAuthorizedSale } from "./sale-authorization.js";

const ARTIFACT = new URL("../../out/VoidPrimarySaleSettled.sol/VoidPrimarySaleSettled.json", import.meta.url);
const haveArtifact = haveSettledArtifact;
const SALE = ethers.getAddress("0x1111111111111111111111111111111111111111");
const OLD_SALE = ethers.getAddress("0x6ae84a51f100f10f0535a514555043ae9edf9aa3");
const RELEASE = ethers.getAddress("0x9aa6165b493ac50d0f8cdee2fd48a3c5155fd103");
const FACTORY = ethers.getAddress("0x262b774cf9a1949170b58e2d57f6189980fe757b");
const PLATFORM = ethers.getAddress("0xb65c575cae01574296fab6e620b9a15cc0121ce4");
const ROGUE = ethers.getAddress("0x2222222222222222222222222222222222222222");
const coder = ethers.AbiCoder.defaultAbiCoder();
const iface = new ethers.Interface([
  "function releases() view returns (address)", "function platformRecipient() view returns (address)", "function PLATFORM_FEE_BPS() view returns (uint256)", "function owner() view returns (address)",
  "function hasRole(bytes32,address) view returns (bool)", "function isRelease(address) view returns (bool)", "function primarySaleOf(address) view returns (address)",
]);

const settledRuntime = ({ release = RELEASE, platform = PLATFORM } = {}) => settledRuntimeFor({ release, platform });

function chainFixture({ code = {}, chain = "0xa86a", reverts = new Set(), values = {} } = {}) {
  return {
    request: async ({ method, params }) => {
      if (method === "eth_chainId") return chain;
      if (method === "eth_getCode") return code[String(params[0]).toLowerCase()] ?? "0x";
      if (method !== "eth_call") throw new Error(`unexpected ${method}`);
      const { to, data } = params[0];
      const parsed = iface.parseTransaction({ data });
      if (reverts.has(`${to.toLowerCase()}:${parsed.name}`)) throw Object.assign(new Error("execution reverted"), { code: 3 });
      const key = `${to.toLowerCase()}:${parsed.name}`;
      const out = values[key];
      if (out === undefined) throw Object.assign(new Error(`unexpected call ${key}`), { code: 3 });
      return coder.encode([parsed.fragment.outputs[0].type], [out]);
    },
  };
}
const k = (to, name) => `${to.toLowerCase()}:${name}`;
const LEGACY_CODE = `0x6080${"60".repeat(200)}a264697066735822${"11".repeat(32)}64736f6c63430008180033`;

describe("maskedRuntimeHash", () => {
  it("ignores the immutable ranges and the metadata trailer", () => {
    const a = ethers.hexlify(ethers.concat(["0x6000", "0x" + "aa".repeat(32), "0x6001", "0xa264ab", "0x0003"]));
    const b = ethers.hexlify(ethers.concat(["0x6000", "0x" + "bb".repeat(32), "0x6001", "0xa264cd", "0x0003"]));
    expect(maskedRuntimeHash(a, [[2, 32]])).toBe(maskedRuntimeHash(b, [[2, 32]]));
    expect(maskedRuntimeHash(a, [])).not.toBe(maskedRuntimeHash(b, []));
  });
  it("rejects code shorter than the reviewed ranges", () => {
    expect(() => maskedRuntimeHash("0x600160020003", [[100, 32]])).toThrow(/shorter/);
  });
});

describe.skipIf(!haveArtifact)("reviewed settled-sale profile", () => {
  it("the committed hash and ranges equal the compiled artifact's", () => {
    const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8"));
    const ranges = Object.values(artifact.deployedBytecode.immutableReferences).flat().map(({ start, length }) => [start, length]).sort((x, y) => x[0] - y[0]);
    expect(SETTLED_SALE_IMMUTABLE_RANGES.map((r) => [...r])).toEqual(ranges);
    expect(maskedRuntimeHash(artifact.deployedBytecode.object, ranges)).toBe(SETTLED_SALE_RUNTIME_CODE_HASH);
  });
  it("any deployment of the reviewed code (different immutables) hashes the same", () => {
    expect(maskedRuntimeHash(settledRuntime())).toBe(SETTLED_SALE_RUNTIME_CODE_HASH);
    expect(maskedRuntimeHash(settledRuntime({ release: ROGUE, platform: ROGUE }))).toBe(SETTLED_SALE_RUNTIME_CODE_HASH);
  });
});

describe("verifyAuthorizedSale", () => {
  const settledValues = (over = {}) => ({
    [k(SALE, "releases")]: RELEASE, [k(SALE, "platformRecipient")]: PLATFORM, [k(SALE, "PLATFORM_FEE_BPS")]: 250n,
    [k(RELEASE, "hasRole")]: true, [k(FACTORY, "isRelease")]: true, ...over,
  });
  const reverts = new Set([k(SALE, "owner")]);
  const args = { sale: SALE, release: RELEASE, factory: FACTORY, expectedPlatformRecipient: PLATFORM, chainId: 43114 };

  describe.skipIf(!haveArtifact)("settled satellite sale", () => {
    it("authorizes the reviewed sale bound to the release, the platform wallet and 250 bps", async () => {
      const result = await verifyAuthorizedSale(chainFixture({ code: { [SALE.toLowerCase()]: settledRuntime() }, reverts, values: settledValues() }), args);
      expect(result).toMatchObject({ authorized: true, kind: "settled-satellite", problems: [] });
      expect(result.details.codeHash).toBe(SETTLED_SALE_RUNTIME_CODE_HASH);
    });
    it("refuses a sale that pays a different recipient", async () => {
      const result = await verifyAuthorizedSale(chainFixture({ code: { [SALE.toLowerCase()]: settledRuntime({ platform: ROGUE }) }, reverts, values: settledValues({ [k(SALE, "platformRecipient")]: ROGUE }) }), args);
      expect(result.authorized).toBe(false);
      expect(result.problems.join(" ")).toMatch(/not the platform wallet/);
    });
    it("refuses a sale bound to another release", async () => {
      const result = await verifyAuthorizedSale(chainFixture({ code: { [SALE.toLowerCase()]: settledRuntime() }, reverts, values: settledValues({ [k(SALE, "releases")]: ROGUE }) }), args);
      expect(result.authorized).toBe(false);
      expect(result.problems.join(" ")).toMatch(/bound to/);
    });
    it("refuses a sale the release has not authorized to mint", async () => {
      const result = await verifyAuthorizedSale(chainFixture({ code: { [SALE.toLowerCase()]: settledRuntime() }, reverts, values: settledValues({ [k(RELEASE, "hasRole")]: false }) }), args);
      expect(result.authorized).toBe(false);
      expect(result.problems.join(" ")).toMatch(/no ISSUER_ROLE/);
    });
    it("refuses a sale that has an owner", async () => {
      const result = await verifyAuthorizedSale(chainFixture({ code: { [SALE.toLowerCase()]: settledRuntime() }, values: settledValues({ [k(SALE, "owner")]: ROGUE }) }), args);
      expect(result.authorized).toBe(false);
      expect(result.problems.join(" ")).toMatch(/has an owner/);
    });
    it("refuses a different fee", async () => {
      const result = await verifyAuthorizedSale(chainFixture({ code: { [SALE.toLowerCase()]: settledRuntime() }, reverts, values: settledValues({ [k(SALE, "PLATFORM_FEE_BPS")]: 0n }) }), args);
      expect(result.authorized).toBe(false);
      expect(result.problems.join(" ")).toMatch(/0 basis points, not 250/);
    });
    it("refuses code that differs from the reviewed sale even when every read looks right", async () => {
      const tampered = ethers.getBytes(settledRuntime());
      tampered[500] ^= 0xff;
      const result = await verifyAuthorizedSale(chainFixture({ code: { [SALE.toLowerCase()]: ethers.hexlify(tampered) }, reverts, values: { ...settledValues(), [k(FACTORY, "primarySaleOf")]: OLD_SALE } }), args);
      expect(result.authorized).toBe(false);
      expect(result.kind).toBeNull();
      expect(result.problems.join(" ")).toMatch(/not the reviewed settled sale/);
    });
  });

  it("authorizes the legacy sale only when the factory registered it for the release", async () => {
    const ok = await verifyAuthorizedSale(chainFixture({ code: { [OLD_SALE.toLowerCase()]: LEGACY_CODE }, values: { [k(OLD_SALE, "releases")]: RELEASE, [k(OLD_SALE, "platformRecipient")]: PLATFORM, [k(FACTORY, "primarySaleOf")]: OLD_SALE } }), { ...args, sale: OLD_SALE });
    expect(ok).toMatchObject({ authorized: true, kind: "factory-registered-legacy" });
    const notRegistered = await verifyAuthorizedSale(chainFixture({ code: { [SALE.toLowerCase()]: LEGACY_CODE }, values: { [k(SALE, "releases")]: RELEASE, [k(SALE, "platformRecipient")]: PLATFORM, [k(FACTORY, "primarySaleOf")]: OLD_SALE } }), args);
    expect(notRegistered.authorized).toBe(false);
    expect(notRegistered.problems.join(" ")).toMatch(/factory registers/);
  });
  it("refuses unknown code with no factory to vouch for it", async () => {
    const result = await verifyAuthorizedSale(chainFixture({ code: { [SALE.toLowerCase()]: LEGACY_CODE }, values: { [k(SALE, "releases")]: RELEASE, [k(SALE, "platformRecipient")]: PLATFORM } }), { ...args, factory: "" });
    expect(result.authorized).toBe(false);
  });
  it("refuses an address with no contract code and a wrong chain", async () => {
    const empty = await verifyAuthorizedSale(chainFixture({ code: {} }), args);
    expect(empty).toMatchObject({ authorized: false, kind: null });
    expect(empty.problems.join(" ")).toMatch(/no contract code/);
    const wrongChain = await verifyAuthorizedSale(chainFixture({ code: { [OLD_SALE.toLowerCase()]: LEGACY_CODE }, chain: "0xa869", values: { [k(OLD_SALE, "releases")]: RELEASE, [k(OLD_SALE, "platformRecipient")]: PLATFORM, [k(FACTORY, "primarySaleOf")]: OLD_SALE } }), { ...args, sale: OLD_SALE });
    expect(wrongChain.authorized).toBe(false);
    expect(wrongChain.problems.join(" ")).toMatch(/on chain 43113/);
  });
  it("exposes the ISSUER role hash", () => { expect(ISSUER_ROLE).toBe(ethers.keccak256(ethers.toUtf8Bytes("ISSUER_ROLE"))); });
});

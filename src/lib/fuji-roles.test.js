import { ethers } from "ethers";
import { describe, expect, it, vi } from "vitest";
// The send path only ever targets the configured granter, so the test config carries one.
vi.mock("../../config/fuji-release.json", async (importOriginal) => {
  const actual = await importOriginal();
  return { default: { ...actual.default, roleGranterAddress: "0x3333333333333333333333333333333333333333" } };
});
const { FUJI_RELEASE_CONFIG, FUJI_ROLES, canMutateFujiPublishingRoles, encodeFujiGrantRole, grantPublishingRoles, readFujiRole } = await import("./fuji-release.js");

const GRANTER = "0x3333333333333333333333333333333333333333";
const REVIEWER = "0x4444444444444444444444444444444444444444";
const granterIface = new ethers.Interface(["function isReviewer(address) view returns (bool)", "function grantPublishingRoles(address)", "error SelfGrant(address reviewer)"]);

// Release contract + VoidRoleGranter; REVIEWER is never a release admin.
function granterProvider({ listed = true, grantRevert = null } = {}) {
  const sent = [];
  const request = vi.fn(async ({ method, params }) => {
    if (method === "eth_chainId") return FUJI_RELEASE_CONFIG.chainHexId;
    if (method === "eth_call") {
      const { to, data, from } = params[0];
      if (to.toLowerCase() === GRANTER.toLowerCase()) {
        if (data.startsWith(granterIface.getFunction("isReviewer").selector)) return ethers.AbiCoder.defaultAbiCoder().encode(["bool"], [listed]);
        if (grantRevert) throw Object.assign(new Error("execution reverted"), { data: grantRevert });
        expect(from).toBe(REVIEWER);
        return "0x";
      }
      return ethers.AbiCoder.defaultAbiCoder().encode(["bool"], [false]);
    }
    if (method === "eth_sendTransaction") { sent.push(params[0]); return `0x${String(sent.length).padStart(64, "0")}`; }
    if (method === "eth_getTransactionReceipt") return { status: "0x1", blockNumber: "0x1", logs: [] };
    throw new Error(`unexpected ${method}`);
  });
  return { provider: { request }, sent };
}

const ADMIN = "0x1111111111111111111111111111111111111111";
const ARTIST = "0x2222222222222222222222222222222222222222";
const roleIface = new ethers.Interface(["function hasRole(bytes32,address) view returns (bool)", "function grantRole(bytes32,address)"]);

function fakeProvider({ adminIsAdmin = true, artistRoles = {} } = {}) {
  const sent = [];
  const request = vi.fn(async ({ method, params }) => {
    if (method === "eth_chainId") return FUJI_RELEASE_CONFIG.chainHexId;
    if (method === "eth_call") {
      const [role, account] = roleIface.decodeFunctionData("hasRole", params[0].data);
      const held = account.toLowerCase() === ADMIN.toLowerCase() ? (role === FUJI_ROLES.DEFAULT_ADMIN_ROLE && adminIsAdmin) : Boolean(artistRoles[role]);
      return ethers.AbiCoder.defaultAbiCoder().encode(["bool"], [held]);
    }
    if (method === "eth_sendTransaction") { sent.push(params[0]); return `0x${String(sent.length).padStart(64, "0")}`; }
    if (method === "eth_getTransactionReceipt") return { status: "0x1", blockNumber: "0x1", logs: [] };
    throw new Error(`unexpected ${method}`);
  });
  return { provider: { request }, sent };
}


describe("who may grant or revoke Fuji publishing roles", () => {
  it("requires DEFAULT_ADMIN_ROLE on the certified Fuji release and nothing less", async () => {
    expect(FUJI_RELEASE_CONFIG.contractAddress).toBe("0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6");
    expect(FUJI_ROLES.DEFAULT_ADMIN_ROLE).toBe(`0x${"00".repeat(32)}`);
    expect(canMutateFujiPublishingRoles(true)).toBe(true);
    expect(canMutateFujiPublishingRoles(false)).toBe(false);
    expect(canMutateFujiPublishingRoles(undefined)).toBe(false);
    expect(canMutateFujiPublishingRoles(null)).toBe(false);

    const calls = [];
    const provider = {
      request: vi.fn(async ({ method, params }) => {
        if (method === "eth_chainId") return FUJI_RELEASE_CONFIG.chainHexId;
        if (method === "eth_call") {
          calls.push(params[0]);
          return ethers.AbiCoder.defaultAbiCoder().encode(["bool"], [true]);
        }
        throw new Error(`unexpected ${method}`);
      }),
    };
    await expect(readFujiRole(provider, FUJI_ROLES.DEFAULT_ADMIN_ROLE, ADMIN)).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe("0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6");
    const [role, account] = roleIface.decodeFunctionData("hasRole", calls[0].data);
    expect(role).toBe(FUJI_ROLES.DEFAULT_ADMIN_ROLE);
    expect(account).toBe(ethers.getAddress(ADMIN));
  });
});

describe("granting Fuji publishing roles", () => {
  it("encodes grantRole for the artist wallet", () => {
    const data = encodeFujiGrantRole(FUJI_ROLES.ARTIST_ROLE, ARTIST);
    expect(roleIface.decodeFunctionData("grantRole", data)).toEqual([FUJI_ROLES.ARTIST_ROLE, ethers.getAddress(ARTIST)]);
    expect(() => encodeFujiGrantRole(FUJI_ROLES.ARTIST_ROLE, "nope")).toThrow(/invalid/);
  });

  it("grants only the missing roles, from an admin wallet, to the certified contract", async () => {
    const { provider, sent } = fakeProvider({ artistRoles: { [FUJI_ROLES.ARTIST_ROLE]: true } });
    const results = await grantPublishingRoles({ provider, from: ADMIN, account: ARTIST });
    expect(results).toEqual([{ role: "ARTIST_ROLE", alreadyHeld: true }, expect.objectContaining({ role: "ISSUER_ROLE", hash: expect.any(String) })]);
    expect(sent).toHaveLength(1);
    expect(sent[0].to.toLowerCase()).toBe(FUJI_RELEASE_CONFIG.contractAddress.toLowerCase());
    expect(roleIface.decodeFunctionData("grantRole", sent[0].data)[0]).toBe(FUJI_ROLES.ISSUER_ROLE);
  });

  it("refuses to send anything from a wallet that is not the contract admin", async () => {
    const { provider, sent } = fakeProvider({ adminIsAdmin: false });
    await expect(grantPublishingRoles({ provider, from: ADMIN, account: ARTIST, granterAddress: "" })).rejects.toThrow(/not an admin/);
    expect(sent).toHaveLength(0);
  });

  it("lets a listed reviewer grant both roles through the role granter, with no admin role", async () => {
    const { provider, sent } = granterProvider();
    const results = await grantPublishingRoles({ provider, from: REVIEWER, account: ARTIST, granterAddress: GRANTER });
    expect(results).toEqual([expect.objectContaining({ role: "ARTIST_ROLE + ISSUER_ROLE", hash: expect.any(String) })]);
    expect(sent).toHaveLength(1);
    expect(sent[0].to.toLowerCase()).toBe(GRANTER.toLowerCase());
    expect(granterIface.decodeFunctionData("grantPublishingRoles", sent[0].data)[0]).toBe(ethers.getAddress(ARTIST));
  });

  it("refuses a wallet that is neither admin nor a listed reviewer", async () => {
    const { provider, sent } = granterProvider({ listed: false });
    await expect(grantPublishingRoles({ provider, from: REVIEWER, account: ARTIST, granterAddress: GRANTER })).rejects.toThrow(/neither a reviewer/);
    expect(sent).toHaveLength(0);
  });

  it("names a self-grant and sends nothing", async () => {
    const { provider, sent } = granterProvider({ grantRevert: granterIface.encodeErrorResult("SelfGrant", [REVIEWER]) });
    await expect(grantPublishingRoles({ provider, from: REVIEWER, account: ARTIST, granterAddress: GRANTER })).rejects.toThrow(/own wallet/);
    expect(sent).toHaveLength(0);
  });

  it("explains when the role granter is not deployed yet", async () => {
    const { provider } = granterProvider();
    await expect(grantPublishingRoles({ provider, from: REVIEWER, account: ARTIST, granterAddress: "" })).rejects.toThrow(/not deployed yet/);
  });
});

import { ethers } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { FUJI_RELEASE_CONFIG, FUJI_ROLES, encodeFujiGrantRole, grantPublishingRoles } from "./fuji-release.js";

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
    await expect(grantPublishingRoles({ provider, from: ADMIN, account: ARTIST })).rejects.toThrow(/not an admin/);
    expect(sent).toHaveLength(0);
  });
});

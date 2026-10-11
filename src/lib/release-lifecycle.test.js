import { describe, expect, it, vi } from "vitest";
import { ethers } from "ethers";
import { ALBUM_TYPE_LOCKED_MESSAGE, STANDALONE_EDITIONS_EXIST_MESSAGE, editionSlugFromTitle, readReleaseLifecycle, releaseEditionTokenId, releaseTypeChangeBlocker } from "./release-lifecycle.js";

const CLONE = "0x4b2790791e2ac123cb012d33cc8f1ecbdc9b9bb0";
const iface = new ethers.Interface(["function albumCreated() view returns (bool)", "function hasStandaloneEditions() view returns (bool)", "function maxSupplyOf(uint256) view returns (uint256)", "error EditionNotFound(uint256 tokenId)"]);
const coder = ethers.AbiCoder.defaultAbiCoder();
const reverted = (data) => Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION", data });

function chain({ albumCreated = false, standaloneFlag = null, minted = [], tokenRevert = null } = {}) {
  return vi.fn(async ({ method, params }) => {
    expect(method).toBe("eth_call");
    const data = params[0].data;
    if (data === iface.encodeFunctionData("albumCreated")) return coder.encode(["bool"], [albumCreated]);
    if (data === iface.encodeFunctionData("hasStandaloneEditions")) {
      if (standaloneFlag === null) throw reverted("0x");
      return coder.encode(["bool"], [standaloneFlag]);
    }
    const [tokenId] = iface.decodeFunctionData("maxSupplyOf", data);
    if (tokenRevert) throw tokenRevert;
    if (minted.includes(tokenId)) return coder.encode(["uint256"], [10]);
    throw reverted(iface.encodeErrorResult("EditionNotFound", [tokenId]));
  });
}

describe("release lifecycle (D3)", () => {
  it("derives the same edition slug and token ID as the server and the release clone", () => {
    expect(editionSlugFromTitle("Forgive & Forget")).toBe("forgive-forget");
    // Token ID of forgive-forget on the Fuji V4 clone, recorded in SYSTEM-CHAIN-CERTIFICATION.md.
    expect(releaseEditionTokenId("forgive-forget")).toBe(25679935302133066722236771263728427871936411831072189551573738559199048803312n);
  });

  it("detects a mined edition on a V4 clone that has no guard getter", async () => {
    const minted = releaseEditionTokenId("forgive-forget");
    const state = await readReleaseLifecycle(chain({ minted: [minted] }), CLONE, { tokenIds: [minted, releaseEditionTokenId("never-made")] });
    expect(state).toEqual({ albumCreated: false, standaloneFlag: null, existingTokenIds: [minted], hasEditions: true });
  });

  it("trusts the V5 guard flag even when no edition rows are known", async () => {
    await expect(readReleaseLifecycle(chain({ standaloneFlag: true }), CLONE)).resolves.toMatchObject({ standaloneFlag: true, hasEditions: true });
    await expect(readReleaseLifecycle(chain({ standaloneFlag: false }), CLONE)).resolves.toMatchObject({ standaloneFlag: false, hasEditions: false });
  });

  it("treats an empty reply from the album getter as a pre-album clone", async () => {
    const request = vi.fn(async ({ params }) => (params[0].data === iface.encodeFunctionData("albumCreated") ? "0x" : (() => { throw reverted("0x"); })()));
    await expect(readReleaseLifecycle(request, CLONE)).resolves.toMatchObject({ albumCreated: false, standaloneFlag: null, hasEditions: false });
  });

  it("fails closed on transport errors and on an unexpected edition revert", async () => {
    await expect(readReleaseLifecycle(vi.fn(async () => { throw new Error("Fuji RPC unavailable"); }), CLONE)).rejects.toThrow(/unavailable/);
    const odd = chain({ tokenRevert: reverted("0x") });
    await expect(readReleaseLifecycle(odd, CLONE, { tokenIds: [1n] })).rejects.toThrow(/reverted/);
    await expect(readReleaseLifecycle(chain(), "0x0000000000000000000000000000000000000000")).rejects.toThrow(/invalid/);
  });

  it("refuses ALBUM after standalone editions and locks an active album", () => {
    expect(releaseTypeChangeBlocker({ toType: "ALBUM", lifecycle: { albumCreated: false, hasEditions: true } })).toEqual({ code: "STANDALONE_EDITIONS_EXIST", message: STANDALONE_EDITIONS_EXIST_MESSAGE });
    expect(releaseTypeChangeBlocker({ toType: "ALBUM", lifecycle: { albumCreated: false, hasEditions: false } })).toBeNull();
    expect(releaseTypeChangeBlocker({ toType: "EP", lifecycle: { albumCreated: false, hasEditions: true } })).toBeNull();
    expect(releaseTypeChangeBlocker({ toType: "SINGLE", lifecycle: { albumCreated: true, hasEditions: true } })).toEqual({ code: "ALBUM_TYPE_LOCKED", message: ALBUM_TYPE_LOCKED_MESSAGE });
    // An album already active on-chain may still be labelled ALBUM.
    expect(releaseTypeChangeBlocker({ toType: "ALBUM", lifecycle: { albumCreated: true, hasEditions: true } })).toBeNull();
    // The guidance points to a new album release; earlier music is never blocked from it.
    expect(STANDALONE_EDITIONS_EXIST_MESSAGE).toMatch(/new Album release/);
  });
});

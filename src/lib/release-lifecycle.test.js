import { describe, expect, it, vi } from "vitest";
import { ethers } from "ethers";
// Recorded test factories, as a manifest would list them: Factory V3 (version 3, V5 clones), a future
// version 4 nobody has reviewed for lifecycle support, and a contradictory version 3 entry.
const { V3_FACTORY, FUTURE_FACTORY, V3_NOT_ALBUM_FACTORY } = vi.hoisted(() => ({ V3_FACTORY: "0x00000000000000000000000000000000000000f3", FUTURE_FACTORY: "0x00000000000000000000000000000000000000f4", V3_NOT_ALBUM_FACTORY: "0x00000000000000000000000000000000000000f5" }));
vi.mock("../../config/release-network.js", async (importOriginal) => {
  const original = await importOriginal();
  const extra = { [V3_FACTORY]: { releaseVersion: 3, albumCapable: true }, [FUTURE_FACTORY]: { releaseVersion: 4, albumCapable: true }, [V3_NOT_ALBUM_FACTORY]: { releaseVersion: 3, albumCapable: false } };
  return { ...original, releaseDeploymentForFactory: (address) => { const entry = extra[String(address).toLowerCase()]; return entry ? { factoryAddress: String(address).toLowerCase(), ...entry } : original.releaseDeploymentForFactory(address); } };
});
import { ALBUM_NOT_SUPPORTED_MESSAGE, ALBUM_TYPE_LOCKED_MESSAGE, STANDALONE_EDITIONS_EXIST_MESSAGE, editionSlugFromTitle, lifecycleExpectations, lifecycleExpectationsForFactory, readReleaseLifecycle, releaseEditionTokenId, releaseTypeChangeBlocker } from "./release-lifecycle.js";

const CLONE = "0x4b2790791e2ac123cb012d33cc8f1ecbdc9b9bb0";
const iface = new ethers.Interface(["function albumCreated() view returns (bool)", "function hasStandaloneEditions() view returns (bool)", "function maxSupplyOf(uint256) view returns (uint256)", "error EditionNotFound(uint256 tokenId)"]);
const coder = ethers.AbiCoder.defaultAbiCoder();
const reverted = (data) => Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION", data });
const V4 = Object.freeze({ albumCreated: true, hasStandaloneEditions: false });
const V5 = Object.freeze({ albumCreated: true, hasStandaloneEditions: true });
const PRE_ALBUM = Object.freeze({ albumCreated: false, hasStandaloneEditions: false });

function chain({ albumCreated = false, standaloneFlag = null, minted = [], tokenRevert = null } = {}) {
  return vi.fn(async ({ method, params }) => {
    expect(method).toBe("eth_call");
    const data = params[0].data;
    if (data === iface.encodeFunctionData("albumCreated")) return coder.encode(["bool"], [albumCreated]);
    if (data === iface.encodeFunctionData("hasStandaloneEditions")) {
      if (standaloneFlag === null) throw new Error("hasStandaloneEditions() is not expected on this clone");
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

  it("takes the expected getters from trusted deployment metadata, never from errors", () => {
    expect(lifecycleExpectations({ implementationVersion: 3, factoryAddress: V3_FACTORY })).toEqual(V5);
    expect(lifecycleExpectationsForFactory(V3_FACTORY)).toEqual(V5);
    // A version number never vouches for a contract: version 3 from an unrecorded factory, or from a
    // recorded factory of another version, is not recognised.
    expect(lifecycleExpectations({ implementationVersion: 3, factoryAddress: "0x00000000000000000000000000000000000000aa" })).toBeNull();
    expect(lifecycleExpectations({ implementationVersion: 3, factoryAddress: "0x3e4E0d9187f6fD11bD6d792a7088D0c2dE8E3aC8" })).toBeNull();
    expect(lifecycleExpectations({ implementationVersion: 2, factoryAddress: V3_FACTORY })).toBeNull();
    // A recorded factory with a matching but unreviewed future version is not a V5: its lifecycle
    // interface is unknown, so nothing is trusted. A contradictory version 3 entry is not trusted either.
    expect(lifecycleExpectations({ implementationVersion: 4, factoryAddress: FUTURE_FACTORY })).toBeNull();
    expect(lifecycleExpectationsForFactory(FUTURE_FACTORY)).toBeNull();
    expect(lifecycleExpectations({ implementationVersion: 3, factoryAddress: V3_NOT_ALBUM_FACTORY })).toBeNull();
    expect(lifecycleExpectations({ implementationVersion: 2, factoryAddress: "0x3e4E0d9187f6fD11bD6d792a7088D0c2dE8E3aC8" })).toEqual(V4);
    expect(lifecycleExpectations({ implementationVersion: 2, factoryAddress: "0xa5CbA0F91cb0A81e0A9Ce89A6722Cbe4eeC93505" })).toEqual(PRE_ALBUM);
    expect(lifecycleExpectationsForFactory("0x3e4e0d9187f6fd11bd6d792a7088d0c2de8e3ac8")).toEqual(V4);
    // Unknown factory, version mismatch or missing version: not recognised, so callers fail closed.
    expect(lifecycleExpectations({ implementationVersion: 2, factoryAddress: "0x00000000000000000000000000000000000000aa" })).toBeNull();
    expect(lifecycleExpectations({ implementationVersion: 1, factoryAddress: "0x3e4E0d9187f6fD11bD6d792a7088D0c2dE8E3aC8" })).toBeNull();
    expect(lifecycleExpectations({ implementationVersion: undefined, factoryAddress: "0x3e4E0d9187f6fD11bD6d792a7088D0c2dE8E3aC8" })).toBeNull();
    expect(lifecycleExpectationsForFactory("0x00000000000000000000000000000000000000aa")).toBeNull();
  });

  it("detects a mined edition on a V4 clone without calling the V5-only getter", async () => {
    const minted = releaseEditionTokenId("forgive-forget");
    const request = chain({ minted: [minted] });
    const state = await readReleaseLifecycle(request, CLONE, { tokenIds: [minted, releaseEditionTokenId("never-made")], expect: V4 });
    expect(state).toEqual({ albumCapable: true, albumCreated: false, standaloneFlag: null, existingTokenIds: [minted], hasEditions: true });
    expect(request.mock.calls.map(([payload]) => payload.params[0].data)).not.toContain(iface.encodeFunctionData("hasStandaloneEditions"));
  });

  it("trusts the V5 guard flag even when no edition rows are known", async () => {
    await expect(readReleaseLifecycle(chain({ standaloneFlag: true }), CLONE, { expect: V5 })).resolves.toMatchObject({ standaloneFlag: true, hasEditions: true });
    await expect(readReleaseLifecycle(chain({ standaloneFlag: false }), CLONE, { expect: V5 })).resolves.toMatchObject({ standaloneFlag: false, hasEditions: false });
  });

  it("does not call album getters on a pre-album clone", async () => {
    const request = chain();
    await expect(readReleaseLifecycle(request, CLONE, { expect: PRE_ALBUM })).resolves.toMatchObject({ albumCapable: false, albumCreated: false, standaloneFlag: null, hasEditions: false });
    expect(request).not.toHaveBeenCalled();
  });

  it("fails closed when an expected getter errors, reverts without data, or returns nothing", async () => {
    // ethers reports a rate limit on eth_call as CALL_EXCEPTION with null data: not evidence of a missing getter.
    const rateLimited = vi.fn(async () => { throw Object.assign(new Error("missing revert data"), { code: "CALL_EXCEPTION", data: null }); });
    await expect(readReleaseLifecycle(rateLimited, CLONE, { expect: V4 })).rejects.toThrow(/missing revert data/);
    await expect(readReleaseLifecycle(vi.fn(async () => "0x"), CLONE, { expect: V4 })).rejects.toThrow(/no data for albumCreated/);
    const flagFails = vi.fn(async ({ params }) => { if (params[0].data === iface.encodeFunctionData("hasStandaloneEditions")) throw reverted("0x"); return coder.encode(["bool"], [false]); });
    await expect(readReleaseLifecycle(flagFails, CLONE, { expect: V5 })).rejects.toThrow(/reverted/);
  });

  it("fails closed on transport errors, unexpected edition reverts and unrecognised implementations", async () => {
    await expect(readReleaseLifecycle(vi.fn(async () => { throw new Error("Fuji RPC unavailable"); }), CLONE, { expect: V4 })).rejects.toThrow(/unavailable/);
    const odd = chain({ tokenRevert: reverted("0x") });
    await expect(readReleaseLifecycle(odd, CLONE, { tokenIds: [1n], expect: V4 })).rejects.toThrow(/reverted/);
    await expect(readReleaseLifecycle(chain(), "0x0000000000000000000000000000000000000000", { expect: V4 })).rejects.toThrow(/invalid/);
    await expect(readReleaseLifecycle(chain(), CLONE, { expect: null })).rejects.toThrow(/not recognised/);
    await expect(readReleaseLifecycle(chain(), CLONE)).rejects.toThrow(/not recognised/);
  });

  it("refuses ALBUM after standalone editions and locks an active album", () => {
    expect(releaseTypeChangeBlocker({ toType: "ALBUM", lifecycle: { albumCreated: false, hasEditions: true } })).toEqual({ code: "STANDALONE_EDITIONS_EXIST", message: STANDALONE_EDITIONS_EXIST_MESSAGE });
    expect(releaseTypeChangeBlocker({ toType: "ALBUM", lifecycle: { albumCreated: false, hasEditions: false } })).toBeNull();
    // A pre-album clone can never become an album, even with no editions.
    expect(releaseTypeChangeBlocker({ toType: "ALBUM", lifecycle: { albumCapable: false, albumCreated: false, hasEditions: false } })).toEqual({ code: "ALBUM_NOT_SUPPORTED", message: ALBUM_NOT_SUPPORTED_MESSAGE });
    expect(releaseTypeChangeBlocker({ toType: "EP", lifecycle: { albumCapable: false, albumCreated: false, hasEditions: true } })).toBeNull();
    expect(releaseTypeChangeBlocker({ toType: "EP", lifecycle: { albumCreated: false, hasEditions: true } })).toBeNull();
    expect(releaseTypeChangeBlocker({ toType: "SINGLE", lifecycle: { albumCreated: true, hasEditions: true } })).toEqual({ code: "ALBUM_TYPE_LOCKED", message: ALBUM_TYPE_LOCKED_MESSAGE });
    // An album already active on-chain may still be labelled ALBUM.
    expect(releaseTypeChangeBlocker({ toType: "ALBUM", lifecycle: { albumCreated: true, hasEditions: true } })).toBeNull();
    // The guidance points to a new album release; earlier music is never blocked from it.
    expect(STANDALONE_EDITIONS_EXIST_MESSAGE).toMatch(/new Album release/);
  });
});

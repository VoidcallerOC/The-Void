import { describe, expect, it, vi } from "vitest";
import { ethers } from "ethers";

// 7a: after a new factory is activated, a release prepared on the earlier factory must still be
// created and verified on that earlier factory, as the server keeps it there. The manifest below is
// the post-activation shape: a Factory V3 (version 3) is active and the deployed album-capable
// Factory V2 (version 2) is historical.
const { V3_FACTORY, V2_FACTORY } = vi.hoisted(() => ({ V3_FACTORY: "0x00000000000000000000000000000000000000F3", V2_FACTORY: "0x3e4E0d9187f6fD11bD6d792a7088D0c2dE8E3aC8" }));
vi.mock("../../config/release-network.js", async (importOriginal) => {
  const original = await importOriginal();
  const active = { ...original.FUJI_RELEASE_PER_CONTRACT_V2, factoryAddress: V3_FACTORY, releaseVersion: 3, provisioningEnabled: true, deploymentAuthorized: true };
  const deployments = [
    { factoryAddress: V3_FACTORY, chainId: 43113, releaseVersion: 3, albumCapable: true },
    { factoryAddress: V2_FACTORY, chainId: 43113, releaseVersion: 2, albumCapable: true },
  ];
  return { ...original, FUJI_RELEASE_PER_CONTRACT_V2: active, releaseDeploymentForFactory: (address) => deployments.find((entry) => String(entry.factoryAddress).toLowerCase() === String(address || "").toLowerCase()) || null };
});
import { releaseFactoryForPrepared, submitArtistReleaseCreation, verifyArtistReleaseCreation } from "./fuji-release.js";

const ARTIST = "0x1111111111111111111111111111111111111111";
const CLONE = "0x2222222222222222222222222222222222222222";
const SALE = "0x3333333333333333333333333333333333333333";
const IMPLEMENTATION = "0x4444444444444444444444444444444444444444";
const APP_ID = `0x${"12".repeat(32)}`;
const HASH = `0x${"ab".repeat(32)}`;
const factoryIface = new ethers.Interface([
  "function createRelease(bytes32 applicationReleaseId,bytes32 releaseKey,string name,string symbol,string contractURI) returns (address,address,address)",
  "function releaseContractOf(bytes32 releaseKey) view returns(address)",
  "event ReleaseCreated(address indexed releaseContract,bytes32 indexed releaseKey,address indexed artist,address primarySale,address provenanceAnchor,address implementation,uint256 index,uint16 version)",
]);
const cloneIface = new ethers.Interface(["function owner() view returns(address)", "function releaseKey() view returns(bytes32)", "function name() view returns(string)", "function symbol() view returns(string)", "function contractURI() view returns(string)"]);

// The prepared payload as the server returns it: the release key commits to the recorded factory.
function prepared(factoryAddress, overrides = {}) {
  const releaseKey = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256", "address", "bytes32", "address"], ["the-void:studio-release:v2", 43113n, ethers.getAddress(factoryAddress), APP_ID, ARTIST]));
  return { chainId: 43113, factoryAddress: factoryAddress.toLowerCase(), applicationReleaseId: APP_ID, releaseKey, artistWallet: ARTIST.toLowerCase(), name: "Release", symbol: "REL", contractURI: "", ...overrides };
}

// A Fuji chain where `factoryAddress` emitted ReleaseCreated at `version` for the prepared release.
function chain({ factoryAddress, version, expected }) {
  const sent = [];
  const event = factoryIface.encodeEventLog("ReleaseCreated", [CLONE, expected.releaseKey, ARTIST, SALE, CLONE, IMPLEMENTATION, 7n, version]);
  const clone = { owner: ARTIST, releaseKey: expected.releaseKey, name: expected.name, symbol: expected.symbol, contractURI: expected.contractURI };
  const request = vi.fn(async ({ method, params }) => {
    if (method === "eth_chainId") return "0xa869";
    if (method === "eth_sendTransaction") { sent.push(params[0]); return HASH; }
    if (method === "eth_getTransactionReceipt") return { status: "0x1", logs: [{ address: factoryAddress, topics: event.topics, data: event.data }] };
    if (method === "eth_call") {
      const [{ to, data }] = params;
      if (to.toLowerCase() === CLONE.toLowerCase()) {
        const fragment = cloneIface.parseTransaction({ data }).name;
        return cloneIface.encodeFunctionResult(fragment, [clone[fragment]]);
      }
      if (data.startsWith(factoryIface.getFunction("releaseContractOf").selector)) return factoryIface.encodeFunctionResult("releaseContractOf", [to.toLowerCase() === factoryAddress.toLowerCase() ? CLONE : ethers.ZeroAddress]);
      return "0x";
    }
    throw new Error(`unexpected ${method}`);
  });
  return { provider: { request }, sent };
}

describe("7a: Studio release creation uses the prepared factory, not only the active one", () => {
  it("creates and verifies a release prepared on the historical factory on that factory, after V3 is active", async () => {
    const expected = prepared(V2_FACTORY);
    const { provider, sent } = chain({ factoryAddress: V2_FACTORY, version: 2, expected });
    const submitted = await submitArtistReleaseCreation({ provider, from: ARTIST, payload: expected });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(ethers.getAddress(V2_FACTORY));
    expect(submitted.factoryAddress).toBe(ethers.getAddress(V2_FACTORY));
    const verified = await verifyArtistReleaseCreation(provider, { transactionHash: HASH, expected });
    expect(verified).toMatchObject({ factoryAddress: ethers.getAddress(V2_FACTORY), releaseContractAddress: ethers.getAddress(CLONE), version: 2 });
  });

  it("creates and verifies a release prepared on the active Factory V3 there, expecting version 3", async () => {
    const expected = prepared(V3_FACTORY);
    const { provider, sent } = chain({ factoryAddress: V3_FACTORY, version: 3, expected });
    await submitArtistReleaseCreation({ provider, from: ARTIST, payload: expected });
    expect(sent[0].to).toBe(ethers.getAddress(V3_FACTORY));
    await expect(verifyArtistReleaseCreation(provider, { transactionHash: HASH, expected })).resolves.toMatchObject({ factoryAddress: ethers.getAddress(V3_FACTORY), version: 3 });
  });

  it("refuses verification when the prepared factory emitted a different version than it is recorded with", async () => {
    const expected = prepared(V2_FACTORY);
    const { provider } = chain({ factoryAddress: V2_FACTORY, version: 3, expected });
    await expect(verifyArtistReleaseCreation(provider, { transactionHash: HASH, expected })).rejects.toThrow(/Factory version/);
  });

  it("refuses verification when only the active factory, not the prepared one, emitted the event", async () => {
    const expected = prepared(V2_FACTORY);
    const { provider } = chain({ factoryAddress: V3_FACTORY, version: 3, expected });
    await expect(verifyArtistReleaseCreation(provider, { transactionHash: HASH, expected })).rejects.toThrow(/exact ReleaseCreated event/);
  });

  it("refuses an unrecorded factory, a missing factory, another chain, or a key not bound to the prepared factory before any wallet prompt", async () => {
    for (const payload of [prepared("0x00000000000000000000000000000000000000aa"), { ...prepared(V2_FACTORY), factoryAddress: undefined }, prepared(V2_FACTORY, { chainId: 43114 })]) {
      const { provider, sent } = chain({ factoryAddress: V2_FACTORY, version: 2, expected: prepared(V2_FACTORY) });
      await expect(submitArtistReleaseCreation({ provider, from: ARTIST, payload })).rejects.toThrow(/not a recorded release deployment/);
      expect(sent).toHaveLength(0);
      expect(() => releaseFactoryForPrepared(payload)).toThrow(/not a recorded release deployment/);
    }
    // A key derived for the active factory does not verify a release prepared on the historical one.
    const mismatched = { ...prepared(V2_FACTORY), releaseKey: prepared(V3_FACTORY).releaseKey };
    const { provider } = chain({ factoryAddress: V2_FACTORY, version: 2, expected: mismatched });
    await expect(verifyArtistReleaseCreation(provider, { transactionHash: HASH, expected: mismatched })).rejects.toThrow(/does not commit/);
  });
});

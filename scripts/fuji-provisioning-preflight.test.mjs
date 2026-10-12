import { describe, expect, it } from "vitest";
import { ZeroAddress, getAddress, id, keccak256, toUtf8Bytes } from "ethers";
import fujiV2 from "../config/fuji-release-per-contract-v2.json" with { type: "json" };
import { REQUESTS, factoryIface, preflightRequest, runPreflight, studioReleaseKey } from "./fuji-provisioning-preflight.mjs";

const FACTORY = getAddress(fujiV2.factoryAddress);
const IMPLEMENTATION = getAddress(fujiV2.implementationAddress);
const ARTIST = "0x284C09a7CC187E096cbbdc88d99DEFE6df32180a";
const FULFILLED = REQUESTS.find((request) => request.requestId === "cd5fe948-137e-430a-ae5c-162c8a2923f2");
const RECORDED = getAddress(FULFILLED.fulfillment.releaseContract);
const OTHER = "0x000000000000000000000000000000000000bEEF";
const selectorCode = (...signatures) => `0x${signatures.map((signature) => `63${id(signature).slice(2, 10)}`).join("")}`;
const FACTORY_CODE = selectorCode("createRelease(bytes32,bytes32,string,string,string)");
const IMPLEMENTATION_CODE = selectorCode("createAlbum(bytes32)", "createAlbumTrack(bytes32,bytes32,uint256,string,address,uint96,bool,uint64)", "closeAlbum(bytes32)", "albumCreated()", "createEditionWithMintEnd(bytes32,bytes32,uint256,string,address,uint96,uint64)", "approveExpandedRelease(bytes32,uint256,uint256)");

/** A pending request built with the same formulas Studio uses, so its integrity checks pass. */
function pendingRequest(overrides = {}) {
  const applicationReleaseRecordId = "release-test-pending-0001";
  const applicationReleaseId = keccak256(toUtf8Bytes(applicationReleaseRecordId));
  const expectedParameters = {
    chainId: 43113,
    factoryAddress: FACTORY.toLowerCase(),
    applicationReleaseId,
    applicationReleaseRecordId,
    releaseKey: studioReleaseKey(FACTORY, applicationReleaseId, ARTIST),
    artistWallet: ARTIST.toLowerCase(),
    name: "Pending Test Release",
    symbol: "PENDING",
    contractURI: "",
    ...overrides,
  };
  return { requestId: "pending-test", status: "pending", authorizationDigest: keccak256(toUtf8Bytes(JSON.stringify(expectedParameters))), expectedParameters };
}

const revert = (name, args) => Object.assign(new Error("execution reverted"), { data: factoryIface.encodeErrorResult(name, args) });

/** In-memory Fuji: the factory binds `bound` keys to clones; createRelease of a bound key reverts as the contract does. */
function chain({ bound = {}, fulfillment = {}, simulate, balance = 10n ** 18n } = {}) {
  const tx = FULFILLED.fulfillment.transactionHash;
  const createData = factoryIface.encodeFunctionData("createRelease", [
    FULFILLED.expectedParameters.applicationReleaseId, FULFILLED.expectedParameters.releaseKey,
    FULFILLED.expectedParameters.name, FULFILLED.expectedParameters.symbol, FULFILLED.expectedParameters.contractURI,
  ]);
  const event = factoryIface.encodeEventLog("ReleaseCreated", [
    fulfillment.eventRelease ?? RECORDED, FULFILLED.expectedParameters.releaseKey, ARTIST, OTHER, OTHER, IMPLEMENTATION, 0n, 2n,
  ]);
  return {
    send: async (method) => (method === "eth_chainId" ? "0xa869" : null),
    getBlockNumber: async () => 1,
    getCode: async (address) => (getAddress(address) === FACTORY ? FACTORY_CODE : getAddress(address) === IMPLEMENTATION ? IMPLEMENTATION_CODE : "0x"),
    getTransactionReceipt: async (hash) => (hash === tx ? { status: fulfillment.status ?? 1, blockNumber: FULFILLED.fulfillment.blockNumber, to: FACTORY, from: ARTIST, logs: [{ address: FACTORY, ...event }] } : null),
    getTransaction: async (hash) => (hash === tx ? { data: fulfillment.data ?? createData } : null),
    estimateGas: async () => 2_000_000n,
    getFeeData: async () => ({ maxFeePerGas: 30_000_000_000n }),
    getBalance: async () => balance,
    call: async ({ data }) => {
      const parsed = factoryIface.parseTransaction({ data });
      const key = (value) => bound[value] ?? ZeroAddress;
      switch (parsed.name) {
        case "implementation": return factoryIface.encodeFunctionResult("implementation", [IMPLEMENTATION]);
        case "releaseCount": return factoryIface.encodeFunctionResult("releaseCount", [BigInt(Object.keys(bound).length)]);
        case "releaseContractOf": return factoryIface.encodeFunctionResult("releaseContractOf", [key(parsed.args[0])]);
        case "releasesOf": return factoryIface.encodeFunctionResult("releasesOf", [Object.values(bound)]);
        case "createRelease":
          if (simulate) return simulate(parsed);
          if (key(parsed.args[1]) !== ZeroAddress) throw revert("ReleaseAlreadyExists", [parsed.args[1], key(parsed.args[1])]);
          return factoryIface.encodeFunctionResult("createRelease", [OTHER, OTHER, OTHER]);
        default: throw new Error(`unexpected call ${parsed.name}`);
      }
    },
  };
}
const fulfilledChain = (options = {}) => chain({ bound: { [FULFILLED.expectedParameters.releaseKey]: options.boundTo ?? RECORDED }, ...options });

describe("Fuji provisioning preflight", () => {
  it("records the -a-3 request as fulfilled with its creation transaction, and declares no pending request", () => {
    expect(REQUESTS.every((request) => ["pending", "fulfilled"].includes(request.status))).toBe(true);
    expect(FULFILLED.status).toBe("fulfilled");
    expect(FULFILLED.fulfillment).toEqual({ transactionHash: "0x7ca0dc94ff7b69234bb2a07d4e29ba1e6a8a46f2cb21327f0cd1cd89f748d711", blockNumber: 59273699, releaseContract: "0xBf753E65e4A10a3074ea6889F25D840A04B04CB9" });
  });

  it("passes a fulfilled request only when the chain shows exactly the recorded creation and refuses a repeat", async () => {
    const result = await preflightRequest(FULFILLED, fulfilledChain());
    expect(result.checks).toMatchObject({ digestMatches: true, applicationReleaseIdMatches: true, releaseKeyMatchesOnChainFormula: true, releaseKeyBoundToRecordedRelease: true, fulfillmentReceiptSucceeded: true, fulfillmentCalldataMatches: true, fulfillmentEventMatches: true, duplicateCreationRefused: true });
    expect(result.ok).toBe(true);
    expect(result.checks).not.toHaveProperty("simulationSucceeds");
  });

  it("fails a fulfilled request whose key is bound to another clone, or whose evidence does not match", async () => {
    expect((await preflightRequest(FULFILLED, fulfilledChain({ boundTo: OTHER }))).checks.releaseKeyBoundToRecordedRelease).toBe(false);
    expect((await preflightRequest(FULFILLED, chain())).ok).toBe(false); // key unbound: never created
    expect((await preflightRequest(FULFILLED, fulfilledChain({ fulfillment: { status: 0 } }))).checks.fulfillmentReceiptSucceeded).toBe(false);
    expect((await preflightRequest(FULFILLED, fulfilledChain({ fulfillment: { data: "0xdeadbeef" } }))).checks.fulfillmentCalldataMatches).toBe(false);
    expect((await preflightRequest(FULFILLED, fulfilledChain({ fulfillment: { eventRelease: OTHER } }))).checks.fulfillmentEventMatches).toBe(false);
  });

  it("fails a fulfilled request if a repeat succeeds or reverts for any other reason", async () => {
    const succeeds = await preflightRequest(FULFILLED, fulfilledChain({ simulate: () => factoryIface.encodeFunctionResult("createRelease", [OTHER, OTHER, OTHER]) }));
    expect(succeeds.checks.duplicateCreationRefused).toBe(false);
    expect(succeeds.ok).toBe(false);
    const otherRevert = await preflightRequest(FULFILLED, fulfilledChain({ simulate: () => { throw revert("InvalidReleaseKey", []); } }));
    expect(otherRevert.checks.duplicateCreationRefused).toBe(false);
    const wrongClone = await preflightRequest(FULFILLED, fulfilledChain({ simulate: (parsed) => { throw revert("ReleaseAlreadyExists", [parsed.args[1], OTHER]); } }));
    expect(wrongClone.checks.duplicateCreationRefused).toBe(false);
  });

  it("gives a genuinely pending request full validation: unused key, successful simulation, gas and funding", async () => {
    const result = await preflightRequest(pendingRequest(), chain());
    expect(result.checks).toEqual({
      digestMatches: true, applicationReleaseIdMatches: true, releaseKeyMatchesOnChainFormula: true, chainIdIs43113: true, factoryHasCode: true, factoryHasCreateRelease: true,
      factoryMatchesConfig: true, implementationMatchesConfig: true, implementationAlbumCapable: true, releaseKeyUnused: true, simulationSucceeds: true, artistCanPayGas: true,
    });
    expect(result.ok).toBe(true);
  });

  it("still fails a pending request whose key is already used (the original ReleaseAlreadyExists failure)", async () => {
    const request = pendingRequest();
    const result = await preflightRequest(request, chain({ bound: { [request.expectedParameters.releaseKey]: OTHER } }));
    expect(result.checks.releaseKeyUnused).toBe(false);
    expect(result.checks.simulationSucceeds).toBe(false);
    expect(result.simulationRevert).toMatch(/^ReleaseAlreadyExists\(/);
    expect(result.ok).toBe(false);
  });

  it("fails a pending request on a tampered digest, an unfunded artist, or an unexpected revert", async () => {
    expect((await preflightRequest({ ...pendingRequest(), authorizationDigest: keccak256("0x01") }, chain())).checks.digestMatches).toBe(false);
    expect((await preflightRequest(pendingRequest(), chain({ balance: 0n }))).checks.artistCanPayGas).toBe(false);
    const reverted = await preflightRequest(pendingRequest(), chain({ simulate: () => { throw revert("CloneFailed", []); } }));
    expect(reverted.checks.simulationSucceeds).toBe(false);
    expect(reverted.ok).toBe(false);
  });

  it("fails an unknown lifecycle status and an empty request list", async () => {
    expect((await preflightRequest({ ...FULFILLED, status: "cancelled" }, fulfilledChain())).ok).toBe(false);
    expect((await runPreflight([], chain())).ok).toBe(false);
    const mixed = await runPreflight([FULFILLED, pendingRequest()], fulfilledChain());
    expect(mixed).toMatchObject({ pendingRequests: 1, ok: true });
  });
});

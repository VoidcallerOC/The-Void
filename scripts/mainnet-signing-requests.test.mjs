import { describe, expect, it } from "vitest";
import { getCreateAddress, keccak256 } from "ethers";
import { MAINNET_ARTIST_WALLET, MAINNET_DEPLOYER, MAINNET_FEE_RECIPIENT, assertDefinedDeployer, assertNoPrivateKeyInEnv, assertReadyToSign, creationRequest, requestBindingFields, runtimeMatchesArtifact, verifyCreationTransaction, walletTransaction } from "./mainnet-signing-requests.mjs";
import { ARTIST, DEPLOYER, RECIPIENT, fakeChain } from "../test/helpers/mainnet-fake-chain.mjs";

const DATA = "0x6001600155";
const request = (overrides = {}) => creationRequest({ step: 1, contract: "VoidReleaseFactoryV2Royalty", from: DEPLOYER, nonce: 0, data: DATA, estimatedGas: 1_000_000n, predictedAddress: getCreateAddress({ from: DEPLOYER, nonce: 0 }), ...overrides });

describe("mainnet wallet roles", () => {
  it("fixes the defined deployer, artist and fee recipient as three distinct addresses", () => {
    expect(MAINNET_DEPLOYER).toBe("0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174");
    expect(MAINNET_ARTIST_WALLET).toBe("0x284C09a7CC187E096cbbdc88d99DEFE6df32180a");
    expect(MAINNET_FEE_RECIPIENT).toBe("0xb65C575CaE01574296Fab6E620B9A15cC0121ce4");
  });

  it("accepts only the defined deployer", () => {
    expect(assertDefinedDeployer(DEPLOYER.toLowerCase())).toBe(DEPLOYER);
    for (const other of [ARTIST, RECIPIENT, "0x00000000000000000000000000000000000000A1"]) expect(() => assertDefinedDeployer(other)).toThrow(/defined mainnet deployer/);
    expect(() => assertDefinedDeployer("")).toThrow(/required/);
    expect(() => assertDefinedDeployer("not-an-address")).toThrow(/EVM address/);
  });

  it("refuses any non-empty private-key variable without echoing its value", () => {
    const value = `0x${"33".repeat(32)}`;
    let message = "";
    try { assertNoPrivateKeyInEnv({ SOME_PRIVATE_KEY: value }); } catch (error) { message = error.message; }
    expect(message).toMatch(/SOME_PRIVATE_KEY is set/);
    expect(message).not.toContain(value);
    expect(() => assertNoPrivateKeyInEnv({ DEPLOYER_PRIVATE_KEY: " " })).not.toThrow();
    expect(() => assertNoPrivateKeyInEnv({ PATH: "/usr/bin" })).not.toThrow();
  });
});

describe("unsigned creation requests", () => {
  it("describes a zero-value contract creation from the deployer with the exact data hash", () => {
    expect(request()).toEqual({ step: 1, contract: "VoidReleaseFactoryV2Royalty", chainId: 43114, from: DEPLOYER, to: null, nonce: 0, value: "0", data: DATA, dataHash: keccak256(DATA), gasLimit: "1200000", predictedAddress: getCreateAddress({ from: DEPLOYER, nonce: 0 }) });
    expect(() => request({ data: "0x" })).toThrow(/non-empty hex/);
    expect(() => request({ nonce: -1 })).toThrow(/nonce/);
  });

  it("hands Rabby a creation transaction with no recipient, the reviewed nonce, gas and chain", () => {
    expect(walletTransaction(request())).toEqual({ from: DEPLOYER, data: DATA, value: "0x0", gas: "0x124f80", nonce: "0x0", chainId: "0xa86a" });
    expect(walletTransaction(request())).not.toHaveProperty("to");
  });

  it("binds everything that decides what is signed, but not the gas estimate", () => {
    const fields = requestBindingFields(request());
    expect(fields).toEqual({ step: 1, contract: "VoidReleaseFactoryV2Royalty", chainId: 43114, from: DEPLOYER.toLowerCase(), to: null, nonce: 0, value: "0", dataHash: keccak256(DATA), predictedAddress: getCreateAddress({ from: DEPLOYER, nonce: 0 }).toLowerCase() });
  });
});

describe("live checks before signing", () => {
  it("passes on C-Chain at the reviewed nonce with nothing pending and the targets empty", async () => {
    await expect(assertReadyToSign(fakeChain(), request())).resolves.toEqual({ chainId: 43114, nonce: 0 });
  });

  it.each([
    ["another chain", fakeChain({ chainId: 43113n }), /chain 43113/],
    ["a moved nonce", fakeChain({ nonce: 1 }), /nonce is 1, not the reviewed 0/],
    ["a pending transaction", fakeChain({ pendingNonce: 1 }), /pending transactions/],
    ["code at the predicted address", fakeChain({ code: { [getCreateAddress({ from: DEPLOYER, nonce: 0 })]: "0x60" } }), /already has code/],
    ["a deployer with code", fakeChain({ code: { [DEPLOYER]: "0x60" } }), /externally owned/],
  ])("refuses %s", async (_name, chain, message) => {
    await expect(assertReadyToSign(chain, request())).rejects.toThrow(message);
  });
});

describe("verifying a mined creation transaction", () => {
  it("returns the created address, block and runtime code hash", async () => {
    const chain = fakeChain();
    const hash = chain.mine(request());
    await expect(verifyCreationTransaction(chain, request(), hash)).resolves.toMatchObject({ address: request().predictedAddress, transaction: hash, block: 101, runtimeCodeHash: keccak256("0x6001") });
  });

  it("names every deviation at once", async () => {
    const chain = fakeChain();
    const hash = chain.mine(request(), { tx: { chainId: 1n, from: ARTIST, nonce: 9, value: 5n, data: "0x60" } });
    await expect(verifyCreationTransaction(chain, request(), hash)).rejects.toThrow(/chainId 1; sender .*; nonce 9; value 5; creation data hash/);
  });
});

describe("runtime code against the reviewed artifact", () => {
  // 8 bytes of code with one 4-byte immutable at offset 2 (zeroed in the artifact, filled at deployment).
  const artifact = { deployedBytecode: { object: "0x6080000000005b00", immutableReferences: { 7: [{ start: 2, length: 4 }] } } };
  it("ignores only the compiler-listed immutable bytes", () => {
    expect(runtimeMatchesArtifact("0x6080deadbeef5b00", artifact)).toBe(true);
    expect(runtimeMatchesArtifact("0x6080deadbeef5b01", artifact)).toBe(false);
    expect(runtimeMatchesArtifact("0x6081000000005b00", artifact)).toBe(false);
    expect(runtimeMatchesArtifact("0x6080deadbeef5b0000", artifact)).toBe(false);
    expect(runtimeMatchesArtifact("0x", artifact)).toBe(false);
    expect(runtimeMatchesArtifact("0x6080000000005b00", { deployedBytecode: { object: "0x6080000000005b00" } })).toBe(true);
  });
});

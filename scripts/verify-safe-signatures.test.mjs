import { describe, expect, it } from "vitest";
import { Wallet, getAddress } from "ethers";
import { SAFE_TX_TYPES, buildSafeCreation, buildSafeSelfTest, safeSetupIface, safeTxHash, safeTypedData } from "./authority-rotation-plan.mjs";
import { verifySafeSignatures } from "./verify-safe-signatures.mjs";

// Ephemeral keys generated per test run; nothing is stored or reused.
const owners = [Wallet.createRandom(), Wallet.createRandom(), Wallet.createRandom()];
const outsider = Wallet.createRandom();
const SAFE = getAddress("0x00000000000000000000000000000000000000a1");
const sign = (w, safe, tx, chainId = 43113) => w.signTypedData({ chainId, verifyingContract: safe }, SAFE_TX_TYPES, tx);

describe("Safe signing-path helpers", () => {
  it("S-0 is a value-0, empty-data CALL from the Safe to itself, blocked until the Safe and nonce exist", () => {
    expect(buildSafeSelfTest({}).status).toBe("BLOCKED");
    expect(buildSafeSelfTest({ safe: SAFE }).blockedOn).toEqual(["SAFE_NONCE"]);
    const s0 = buildSafeSelfTest({ safe: SAFE, safeNonce: 0 });
    expect(s0.safeTx).toMatchObject({ to: SAFE, value: "0", data: "0x", operation: 0, nonce: "0" });
    expect(s0.safeTxHash).toBe(safeTxHash({ safe: SAFE, tx: s0.safeTx }));
    expect(s0.typedData.domain).toEqual({ chainId: 43113, verifyingContract: SAFE });
    expect(s0.typedData.types.EIP712Domain).toBeDefined();
  });

  it("accepts two owner EIP-712 signatures for chain 43113 and orders them for execTransaction", () => {
    const { safeTx } = buildSafeSelfTest({ safe: SAFE, safeNonce: 0 });
    return Promise.all([sign(owners[2], SAFE, safeTx), sign(owners[0], SAFE, safeTx)]).then((signatures) => {
      const r = verifySafeSignatures({ safe: SAFE, chainId: 43113, owners: owners.map((w) => w.address), threshold: 2, tx: safeTx, signatures });
      expect(r.ok).toBe(true);
      const ordered = [owners[0], owners[2]].map((w) => w.address).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
      expect(r.signers.map((s) => s.signer).sort()).toEqual([...ordered].sort());
      expect(r.signaturesForExecTransaction.length).toBe(2 + 130 * 2);
    });
  });

  it("fails closed on wrong chain, wrong Safe, non-owners, one signature and a duplicate", async () => {
    const { safeTx } = buildSafeSelfTest({ safe: SAFE, safeNonce: 0 });
    const ownersList = owners.map((w) => w.address);
    const wrongChain = await Promise.all([sign(owners[0], SAFE, safeTx, 43114), sign(owners[1], SAFE, safeTx, 43114)]);
    expect(verifySafeSignatures({ safe: SAFE, chainId: 43113, owners: ownersList, threshold: 2, tx: safeTx, signatures: wrongChain }).ok).toBe(false);
    expect(verifySafeSignatures({ safe: SAFE, chainId: 43114, owners: ownersList, threshold: 2, tx: safeTx, signatures: wrongChain }).problems[0]).toMatch(/43113/);
    const otherSafe = await Promise.all([sign(owners[0], getAddress("0x00000000000000000000000000000000000000b2"), safeTx), sign(owners[1], getAddress("0x00000000000000000000000000000000000000b2"), safeTx)]);
    expect(verifySafeSignatures({ safe: SAFE, chainId: 43113, owners: ownersList, threshold: 2, tx: safeTx, signatures: otherSafe }).ok).toBe(false);
    const withOutsider = await Promise.all([sign(owners[0], SAFE, safeTx), sign(outsider, SAFE, safeTx)]);
    expect(verifySafeSignatures({ safe: SAFE, chainId: 43113, owners: ownersList, threshold: 2, tx: safeTx, signatures: withOutsider }).ok).toBe(false);
    const one = [await sign(owners[0], SAFE, safeTx)];
    expect(verifySafeSignatures({ safe: SAFE, chainId: 43113, owners: ownersList, threshold: 2, tx: safeTx, signatures: one }).ok).toBe(false);
    expect(verifySafeSignatures({ safe: SAFE, chainId: 43113, owners: ownersList, threshold: 2, tx: safeTx, signatures: [one[0], one[0]] }).ok).toBe(false);
  });

  it("encodes the 2-of-3 Safe creation only with three distinct, independent owners and a salt", () => {
    expect(buildSafeCreation({}).status).toBe("BLOCKED");
    const ownersList = owners.map((w) => w.address);
    expect(() => buildSafeCreation({ owners: [ownersList[0], ownersList[0], ownersList[1]], saltNonce: 1 })).toThrow(/distinct/);
    expect(() => buildSafeCreation({ owners: ownersList, saltNonce: 1, backup: ownersList[1] })).toThrow(/not be a Safe owner/);
    expect(() => buildSafeCreation({ owners: [ownersList[0], ownersList[1], "0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174"], saltNonce: 1 })).toThrow(/differ/);
    const c = buildSafeCreation({ owners: ownersList, saltNonce: 7, backup: outsider.address });
    const outer = safeSetupIface.parseTransaction({ data: c.calldata });
    expect(outer.name).toBe("createProxyWithNonce");
    const setup = safeSetupIface.parseTransaction({ data: outer.args[1] });
    expect(setup.args.owners).toEqual(ownersList);
    expect(setup.args.threshold).toBe(2n);
    expect(setup.args.to).toBe("0x0000000000000000000000000000000000000000");
    expect(setup.args.fallbackHandler).toBe("0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99");
    expect(c.to).toBe("0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67");
    expect(safeTypedData({ safe: SAFE, tx: buildSafeSelfTest({ safe: SAFE, safeNonce: 0 }).safeTx }).primaryType).toBe("SafeTx");
  });
});

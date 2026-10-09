import { describe, expect, it } from "vitest";
import { ZeroAddress, getAddress } from "ethers";
import { KNOWN_SAFE_CONTRACTS, buildReplayCreation, encodeInitializer, factoryIface, parseSafeSetup, predictSafeAddress, resolveSafeSetup, setupIface } from "./safe-counterfactual.mjs";
import { safeTxHash, safeTypedDataHashes } from "./authority-rotation-plan.mjs";

// Placeholder owners and a stand-in proxy creation code: the CREATE2 formula is
// tested here; the live factories' bytecode is validated read-only in CI.
const OWNERS = ["0x0000000000000000000000000000000000000A01", "0x0000000000000000000000000000000000000A02", "0x0000000000000000000000000000000000000A03"].map(getAddress);
const PCC = "0x608060405234801561001057600080fd5b50";
const V = KNOWN_SAFE_CONTRACTS["1.4.1"];

function syntheticExport(saltNonce = "1712345678901") {
  const base = { owners: OWNERS, threshold: 2, to: ZeroAddress, data: "0x", paymentToken: ZeroAddress, payment: "0", paymentReceiver: ZeroAddress, saltNonce };
  const initializer = encodeInitializer(base, getAddress(V.fallbackHandler));
  const address = predictSafeAddress({ factory: V.factory, singleton: V.singletonL2, initializer, saltNonce, proxyCreationCode: PCC });
  return { address, export: { data: { undeployedSafes: { 43114: { [address]: { props: { safeAccountConfig: { owners: OWNERS, threshold: 2, fallbackHandler: V.fallbackHandler }, safeDeploymentConfig: { saltNonce, safeVersion: "1.4.1" } } } } } } } };
}

describe("counterfactual Safe replay helpers", () => {
  it("reports missing inputs instead of guessing", () => {
    expect(parseSafeSetup({ address: OWNERS[0] })).toEqual({ complete: false, missing: ["owners", "threshold", "saltNonce", "factory (or safeVersion 1.3.0 / 1.4.1)", "singleton (or safeVersion)"] });
  });

  it("recovers the exact setup from a Safe{Wallet}-style export only when it recomputes to the address", () => {
    const { address, export: exp } = syntheticExport();
    const setup = parseSafeSetup(exp, { address });
    expect(setup.complete).toBe(true);
    expect(setup.owners).toEqual(OWNERS);
    const matches = resolveSafeSetup(setup, { proxyCreationCode: PCC, targetChainId: 43113 });
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ singleton: getAddress(V.singletonL2), fallbackHandler: getAddress(V.fallbackHandler), mode: "createProxyWithNonce", sameAddressOnEveryChain: true, targetAddress: address });
    // A single wrong owner or salt digit produces no match.
    const wrongOwner = { ...setup, owners: [OWNERS[0], OWNERS[1], getAddress("0x0000000000000000000000000000000000000A04")] };
    expect(resolveSafeSetup(wrongOwner, { proxyCreationCode: PCC, targetChainId: 43113 })).toEqual([]);
    expect(resolveSafeSetup({ ...setup, saltNonce: "1712345678902" }, { proxyCreationCode: PCC, targetChainId: 43113 })).toEqual([]);
  });

  it("chain-specific salts give a different address per chain; plain salts do not", () => {
    const init = encodeInitializer({ owners: OWNERS, threshold: 2, to: ZeroAddress, data: "0x", paymentToken: ZeroAddress, payment: "0", paymentReceiver: ZeroAddress }, ZeroAddress);
    const p = (cs, chainId) => predictSafeAddress({ factory: V.factory, singleton: V.singleton, initializer: init, saltNonce: 7, proxyCreationCode: PCC, chainSpecific: cs, chainId });
    expect(p(false, 43113)).toBe(p(false, 43114));
    expect(p(true, 43113)).not.toBe(p(true, 43114));
  });

  it("encodes the Fuji creation with exactly the recovered owners, threshold and salt", () => {
    const { address, export: exp } = syntheticExport();
    const setup = parseSafeSetup(exp, { address });
    const [m] = resolveSafeSetup(setup, { proxyCreationCode: PCC, targetChainId: 43113 });
    const tx = buildReplayCreation(setup, m, { chainId: 43113 });
    expect(tx).toMatchObject({ chainId: 43113, to: V.factory, value: "0", expectedAddress: address });
    const outer = factoryIface.parseTransaction({ data: tx.data });
    expect(outer.name).toBe("createProxyWithNonce");
    expect(outer.args[0]).toBe(getAddress(V.singletonL2));
    expect(outer.args[2]).toBe(1712345678901n);
    const inner = setupIface.parseTransaction({ data: outer.args[1] });
    expect(inner.args.owners).toEqual(OWNERS);
    expect(inner.args.threshold).toBe(2n);
  });

  it("gives the Ledger-visible domain and message hashes that compose to the safeTxHash", () => {
    const safe = getAddress("0x00000000000000000000000000000000000000a1");
    const tx = { to: safe, value: "0", data: "0x", operation: 0, safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: ZeroAddress, refundReceiver: ZeroAddress, nonce: "0" };
    const h = safeTypedDataHashes({ safe, tx });
    expect(h.safeTxHash).toBe(safeTxHash({ safe, tx }));
    expect(h.domainSeparator).toMatch(/^0x[0-9a-f]{64}$/);
    expect(h.messageHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

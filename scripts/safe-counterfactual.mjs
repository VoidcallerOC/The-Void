// Offline helpers for an undeployed ("not activated") Safe: rebuild its exact setup,
// recompute its CREATE2 address, and encode the factory call that would deploy the
// identical Safe on another chain. No keys, no network, no signing.
//
// A Safe address is CREATE2(factory, salt, keccak(proxyCreationCode ‖ uint256(singleton)))
// with salt = keccak(keccak(initializer) ‖ saltNonce) for createProxyWithNonce, or
// keccak(keccak(initializer) ‖ saltNonce ‖ chainId) for createChainSpecificProxyWithNonce
// (Safe 1.3.0 and 1.4.1 SafeProxyFactory source). The address therefore cannot be
// inverted to recover owners, but a candidate setup is proven exact when it recomputes
// to the same address. A non-chain-specific deployment yields the same address on every
// chain where the factory, singleton and proxy creation code are identical.
import { Interface, ZeroAddress, getAddress, getCreate2Address, isAddress, keccak256, solidityPacked } from "ethers";

// Canonical deployments (safe-global/safe-deployments). Presence and bytecode on each
// chain are verified live by scripts/safe-replay-check.mjs, never assumed.
export const KNOWN_SAFE_CONTRACTS = Object.freeze({
  "1.4.1": {
    factory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
    singleton: "0x41675C099F32341bf84BFc5382aF534df5C7461a",
    singletonL2: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
    fallbackHandler: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99",
  },
  "1.3.0": {
    factory: "0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2",
    singleton: "0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552",
    singletonL2: "0x3E5c63644E683549055b9Be8653de26E0B4CD36E",
    fallbackHandler: "0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4",
  },
});

export const factoryIface = new Interface([
  "function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
  "function createChainSpecificProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
  "function proxyCreationCode() pure returns (bytes)",
]);
export const setupIface = new Interface([
  "function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
]);

const addr = (v, name) => {
  if (!isAddress(String(v || ""))) throw new Error(`${name} must be an address.`);
  return getAddress(String(v).toLowerCase());
};

/**
 * Normalises either a manual setup object or a Safe{Wallet} data export into one
 * setup. Every field the address depends on is required; nothing is defaulted, so a
 * missing value is reported instead of guessed.
 */
export function parseSafeSetup(input, { address = null, sourceChainId = null } = {}) {
  let raw = input;
  // Safe{Wallet} export: { data: { undeployedSafes: { [chainId]: { [address]: { props: {...} } } } } }
  const undeployed = input?.data?.undeployedSafes || input?.undeployedSafes;
  if (undeployed) {
    const chains = sourceChainId ? [String(sourceChainId)] : Object.keys(undeployed);
    const hits = [];
    for (const c of chains) for (const [a, entry] of Object.entries(undeployed[c] || {})) if (!address || a.toLowerCase() === String(address).toLowerCase()) hits.push({ chainId: Number(c), address: a, props: entry?.props || entry });
    if (hits.length !== 1) throw new Error(`Expected exactly one undeployed Safe in the export${address ? ` for ${address}` : ""}; found ${hits.length}.`);
    const { safeAccountConfig: acc = {}, safeDeploymentConfig: dep = {} } = hits[0].props;
    raw = { address: hits[0].address, sourceChainId: hits[0].chainId, ...acc, saltNonce: dep.saltNonce, safeVersion: dep.safeVersion, deploymentType: dep.deploymentType, factory: hits[0].props.factoryAddress, singleton: hits[0].props.masterCopy };
  }
  const missing = ["address", "owners", "threshold", "saltNonce"].filter((k) => raw?.[k] === undefined || raw?.[k] === null || raw?.[k] === "");
  const version = raw?.safeVersion ? String(raw.safeVersion) : null;
  const known = version ? KNOWN_SAFE_CONTRACTS[version] : null;
  if (!raw?.factory && !known) missing.push("factory (or safeVersion 1.3.0 / 1.4.1)");
  if (!raw?.singleton && !known) missing.push("singleton (or safeVersion)");
  if (missing.length) return { complete: false, missing };
  const owners = raw.owners.map((o, i) => addr(o, `owner ${i + 1}`));
  if (new Set(owners).size !== owners.length) throw new Error("Owners must be distinct.");
  const threshold = Number(raw.threshold);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > owners.length) throw new Error("Threshold must be between 1 and the number of owners.");
  const singletonCandidates = raw.singleton ? [addr(raw.singleton, "singleton")] : [known.singleton, known.singletonL2].map(getAddress);
  return {
    complete: true,
    address: addr(raw.address, "address"),
    sourceChainId: raw.sourceChainId ?? sourceChainId ?? null,
    safeVersion: version,
    factory: addr(raw.factory || known.factory, "factory"),
    singletonCandidates,
    owners, threshold,
    to: raw.to ? addr(raw.to, "to") : ZeroAddress,
    data: raw.data || "0x",
    // Fallback handler: explicit value, else the version's canonical handler is tried
    // alongside "none" — the address check decides, nothing is assumed.
    fallbackHandlerCandidates: raw.fallbackHandler !== undefined ? [raw.fallbackHandler ? addr(raw.fallbackHandler, "fallbackHandler") : ZeroAddress] : [...(known ? [getAddress(known.fallbackHandler)] : []), ZeroAddress],
    paymentToken: raw.paymentToken ? addr(raw.paymentToken, "paymentToken") : ZeroAddress,
    payment: String(raw.payment ?? "0"),
    paymentReceiver: raw.paymentReceiver ? addr(raw.paymentReceiver, "paymentReceiver") : ZeroAddress,
    saltNonce: BigInt(raw.saltNonce).toString(),
  };
}

export function encodeInitializer(s, fallbackHandler) {
  return setupIface.encodeFunctionData("setup", [s.owners, s.threshold, s.to, s.data, fallbackHandler, s.paymentToken, s.payment, s.paymentReceiver]);
}

export function predictSafeAddress({ factory, singleton, initializer, saltNonce, proxyCreationCode, chainSpecific = false, chainId = null }) {
  const initHash = keccak256(initializer);
  const salt = chainSpecific
    ? keccak256(solidityPacked(["bytes32", "uint256", "uint256"], [initHash, BigInt(saltNonce), BigInt(chainId)]))
    : keccak256(solidityPacked(["bytes32", "uint256"], [initHash, BigInt(saltNonce)]));
  const deploymentCode = solidityPacked(["bytes", "uint256"], [proxyCreationCode, BigInt(singleton)]);
  return getAddress(getCreate2Address(getAddress(factory), salt, keccak256(deploymentCode)));
}

/**
 * Tries every singleton / fallback-handler / salt-mode combination the setup allows and
 * returns the ones that recompute to the Safe's address. Exactly one match means the
 * owners, threshold and every other setup field are proven exact.
 */
export function resolveSafeSetup(setup, { proxyCreationCode, targetChainId }) {
  const matches = [];
  for (const singleton of setup.singletonCandidates) for (const fallbackHandler of setup.fallbackHandlerCandidates) {
    const initializer = encodeInitializer(setup, fallbackHandler);
    const plain = predictSafeAddress({ factory: setup.factory, singleton, initializer, saltNonce: setup.saltNonce, proxyCreationCode });
    if (plain === setup.address) matches.push({ singleton, fallbackHandler, initializer, mode: "createProxyWithNonce", sameAddressOnEveryChain: true, targetAddress: plain });
    if (setup.sourceChainId) {
      const cs = predictSafeAddress({ factory: setup.factory, singleton, initializer, saltNonce: setup.saltNonce, proxyCreationCode, chainSpecific: true, chainId: setup.sourceChainId });
      if (cs === setup.address) matches.push({ singleton, fallbackHandler, initializer, mode: "createChainSpecificProxyWithNonce", sameAddressOnEveryChain: false, targetAddress: predictSafeAddress({ factory: setup.factory, singleton, initializer, saltNonce: setup.saltNonce, proxyCreationCode, chainSpecific: true, chainId: targetChainId }) });
    }
  }
  return matches;
}

export function buildReplayCreation(setup, match, { chainId }) {
  const fn = match.mode;
  return {
    chainId, to: setup.factory, value: "0",
    data: factoryIface.encodeFunctionData(fn, [match.singleton, match.initializer, BigInt(setup.saltNonce)]),
    function: `${fn}(address,bytes,uint256)`,
    decoded: { singleton: match.singleton, owners: setup.owners, threshold: setup.threshold, to: setup.to, data: setup.data, fallbackHandler: match.fallbackHandler, paymentToken: setup.paymentToken, payment: setup.payment, paymentReceiver: setup.paymentReceiver, saltNonce: setup.saltNonce },
    expectedAddress: match.targetAddress,
    note: "Any funded account may submit this; no owner signature is involved. The Safe's owners and threshold are fixed by the initializer.",
  };
}


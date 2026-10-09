// Read-only check: can the owner's undeployed (counterfactual) Safe be deployed on
// Fuji with the identical owners, threshold and address? No signing, no broadcast;
// only eth_getCode, eth_call and eth_estimateGas against public RPCs.
//
//   [SAFE_SETUP_FILE=setup.json] [SAFE_TARGET=0x...] node scripts/safe-replay-check.mjs
//
// Always: compares the Safe 1.3.0 / 1.4.1 factory, singletons, fallback handlers and
// each factory's proxyCreationCode between Fuji (43113) and C-Chain (43114), and
// validates the offline address predictor against each live factory with eth_call
// (createProxyWithNonce and, for 1.4.1, createChainSpecificProxyWithNonce) using a
// synthetic setup whose owners are placeholders that are never deployed.
// With SAFE_SETUP_FILE (a manual setup or a Safe{Wallet} data export): resolves the
// exact setup that recomputes to SAFE_TARGET, re-checks every contract it references
// on both chains, simulates the Fuji creation with eth_call, and prints the unsigned
// Fuji creation transaction.
import { readFile } from "node:fs/promises";
import { JsonRpcProvider, ZeroAddress, getAddress, keccak256 } from "ethers";
import { KNOWN_SAFE_CONTRACTS, buildReplayCreation, encodeInitializer, factoryIface, parseSafeSetup, predictSafeAddress, resolveSafeSetup } from "./safe-counterfactual.mjs";
import { ARTIST_WALLET_0x284C, OLD_AUTHORITY } from "./authority-rotation-plan.mjs";

const CHAINS = {
  43113: new JsonRpcProvider(process.env.FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc", 43113, { staticNetwork: true }),
  43114: new JsonRpcProvider(process.env.MAINNET_RPC_URL || "https://api.avax.network/ext/bc/C/rpc", 43114, { staticNetwork: true }),
};
const codeHash = async (chainId, a) => { const c = await CHAINS[chainId].getCode(a); return c === "0x" ? null : keccak256(c); };
const proxyCode = async (chainId, factory) => factoryIface.decodeFunctionResult("proxyCreationCode", await CHAINS[chainId].call({ to: factory, data: factoryIface.encodeFunctionData("proxyCreationCode") }))[0];
async function simulate(chainId, to, data) {
  try { return { ok: true, address: getAddress(factoryIface.decodeFunctionResult("createProxyWithNonce", await CHAINS[chainId].call({ to, data }))[0]) }; } catch (error) { return { ok: false, reason: String(error?.shortMessage || error?.message || error).slice(0, 120) }; }
}

async function parity(addresses) {
  const out = {};
  for (const [label, a] of Object.entries(addresses)) {
    const [f, m] = await Promise.all([codeHash(43113, a), codeHash(43114, a)]);
    out[label] = { address: a, fujiCode: Boolean(f), cChainCode: Boolean(m), identical: Boolean(f) && f === m };
  }
  return out;
}

async function selfTest() {
  const out = {};
  for (const [version, c] of Object.entries(KNOWN_SAFE_CONTRACTS)) {
    const contracts = await parity({ factory: c.factory, singleton: c.singleton, singletonL2: c.singletonL2, fallbackHandler: c.fallbackHandler });
    const [pf, pm] = await Promise.all([proxyCode(43113, c.factory), proxyCode(43114, c.factory)]);
    // Placeholder owners: only used inside eth_call, never deployed or proposed.
    const synthetic = { owners: ["0x0000000000000000000000000000000000000A01", "0x0000000000000000000000000000000000000A02", "0x0000000000000000000000000000000000000A03"].map(getAddress), threshold: 2, to: ZeroAddress, data: "0x", paymentToken: ZeroAddress, payment: "0", paymentReceiver: ZeroAddress, saltNonce: "424242" };
    const initializer = encodeInitializer(synthetic, getAddress(c.fallbackHandler));
    const checks = {};
    for (const chainId of [43113, 43114]) {
      const pcc = chainId === 43113 ? pf : pm;
      const plainPred = predictSafeAddress({ factory: c.factory, singleton: c.singletonL2, initializer, saltNonce: synthetic.saltNonce, proxyCreationCode: pcc });
      const plainLive = await simulate(chainId, c.factory, factoryIface.encodeFunctionData("createProxyWithNonce", [c.singletonL2, initializer, BigInt(synthetic.saltNonce)]));
      checks[chainId] = { createProxyWithNonce: { predicted: plainPred, factoryEthCall: plainLive.address || plainLive.reason, match: plainLive.ok && plainLive.address === plainPred } };
      if (version === "1.4.1") {
        const csPred = predictSafeAddress({ factory: c.factory, singleton: c.singletonL2, initializer, saltNonce: synthetic.saltNonce, proxyCreationCode: pcc, chainSpecific: true, chainId });
        const csLive = await simulate(chainId, c.factory, factoryIface.encodeFunctionData("createChainSpecificProxyWithNonce", [c.singletonL2, initializer, BigInt(synthetic.saltNonce)]));
        checks[chainId].createChainSpecificProxyWithNonce = { predicted: csPred, factoryEthCall: csLive.address || csLive.reason, match: csLive.ok && csLive.address === csPred };
      }
    }
    out[version] = { contracts, proxyCreationCodeIdentical: pf === pm, proxyCreationCodeHash: keccak256(pf), predictorVsLiveFactory: checks, sameAddressBothChains: checks[43113].createProxyWithNonce.predicted === checks[43114].createProxyWithNonce.predicted };
  }
  return out;
}

async function checkSetup(file, target) {
  const input = JSON.parse(await readFile(file, "utf8"));
  const setup = parseSafeSetup(input, { address: target, sourceChainId: input?.sourceChainId ?? 43114 });
  if (!setup.complete) return { complete: false, missing: setup.missing };
  const forbidden = [OLD_AUTHORITY, ARTIST_WALLET_0x284C].map(getAddress);
  const result = { address: setup.address, owners: setup.owners, threshold: setup.threshold, ownerFlags: setup.owners.map((o) => ({ owner: o, forbidden: forbidden.includes(o) })) };
  const [pf, pm] = await Promise.all([proxyCode(43113, setup.factory), proxyCode(43114, setup.factory)]);
  result.proxyCreationCodeIdentical = pf === pm;
  const matches = resolveSafeSetup(setup, { proxyCreationCode: pm, targetChainId: 43113 });
  result.matches = matches.map((m) => ({ singleton: m.singleton, fallbackHandler: m.fallbackHandler, mode: m.mode, fujiAddress: m.targetAddress, sameAddressOnFuji: m.targetAddress === setup.address }));
  if (matches.length !== 1) return { ...result, verdict: matches.length ? "AMBIGUOUS: more than one setup matches" : "NO MATCH: these parameters do not produce the Safe address; owners/threshold/salt are not confirmed" };
  const m = matches[0];
  const referenced = { factory: setup.factory, singleton: m.singleton, ...(m.fallbackHandler !== ZeroAddress ? { fallbackHandler: m.fallbackHandler } : {}), ...(setup.to !== ZeroAddress ? { setupDelegateTarget: setup.to } : {}), ...(setup.paymentToken !== ZeroAddress ? { paymentToken: setup.paymentToken } : {}) };
  result.referencedContracts = await parity(referenced);
  result.ownersAreEOAsOnFuji = Object.fromEntries(await Promise.all(setup.owners.map(async (o) => [o, (await CHAINS[43113].getCode(o)) === "0x"])));
  result.fujiTargetHasCode = (await CHAINS[43113].getCode(m.targetAddress)) !== "0x";
  result.cChainTargetHasCode = (await CHAINS[43114].getCode(setup.address)) !== "0x";
  const tx = buildReplayCreation(setup, m, { chainId: 43113 });
  result.fujiEthCall = await simulate(43113, tx.to, tx.data);
  try { result.fujiGasEstimate = (await CHAINS[43113].estimateGas({ to: tx.to, data: tx.data })).toString(); } catch (error) { result.fujiGasEstimate = `unavailable: ${String(error?.shortMessage || error).slice(0, 80)}`; }
  result.unsignedFujiCreation = tx;
  const ok = result.proxyCreationCodeIdentical && Object.values(result.referencedContracts).every((c) => c.identical) && !result.fujiTargetHasCode && result.fujiEthCall.ok && result.fujiEthCall.address === m.targetAddress && result.ownerFlags.every((f) => !f.forbidden);
  return { ...result, verdict: ok ? `READY FOR OWNER REVIEW: deploys the identical ${setup.threshold}-of-${setup.owners.length} Safe at ${m.targetAddress} on Fuji` : "BLOCKED: see the failed field above" };
}

async function main() {
  const out = { probedAt: new Date().toISOString(), chainIds: { fuji: Number(await CHAINS[43113].send("eth_chainId", [])), cChain: Number(await CHAINS[43114].send("eth_chainId", [])) }, selfTest: await selfTest() };
  const target = process.env.SAFE_TARGET ? getAddress(String(process.env.SAFE_TARGET).trim()) : null;
  if (target) out.target = { address: target, fujiCode: (await CHAINS[43113].getCode(target)) !== "0x", cChainCode: (await CHAINS[43114].getCode(target)) !== "0x" };
  out.setup = process.env.SAFE_SETUP_FILE ? await checkSetup(process.env.SAFE_SETUP_FILE, target) : { complete: false, missing: ["SAFE_SETUP_FILE: owners, threshold, saltNonce, safeVersion/singleton, fallbackHandler, to/data (from the Safe{Wallet} data export)"] };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((error) => { console.error(error); process.exit(1); });

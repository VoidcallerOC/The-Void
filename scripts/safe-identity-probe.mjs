// Read-only identity check of one Safe address on Avalanche Fuji (43113) and
// Avalanche C-Chain (43114). No signing, no broadcast.
//
//   SAFE_CANDIDATE=0x... node scripts/safe-identity-probe.mjs
//
// For each chain: chain id, code presence and hash, proxy master copy (slot 0),
// VERSION, owners (and whether each owner is an EOA on that chain), threshold,
// nonce, modules, guard, fallback handler, balance, and current role membership on
// the Fuji P0 release. On a chain with code it also looks up the creation
// transaction (public explorer API) and decodes the factory call, which shows
// whether the identical Safe could exist at the same address on the other chain.
import { Interface, JsonRpcProvider, getAddress, keccak256 } from "ethers";
import { ARTIST_WALLET_0x284C, OLD_AUTHORITY, ROLES, releaseIface } from "./authority-rotation-plan.mjs";

const SAFE = getAddress(String(process.env.SAFE_CANDIDATE || "").trim());
const CHAINS = [
  { name: "Avalanche Fuji", chainId: 43113, rpc: process.env.FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc", routescan: "testnet" },
  { name: "Avalanche C-Chain", chainId: 43114, rpc: process.env.MAINNET_RPC_URL || "https://api.avax.network/ext/bc/C/rpc", routescan: "mainnet" },
];
const P0_RELEASE_FUJI = "0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6";
const KNOWN_SINGLETONS = {
  "0x41675C099F32341bf84BFc5382aF534df5C7461a": "Safe 1.4.1",
  "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762": "SafeL2 1.4.1",
  "0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552": "Safe 1.3.0",
  "0x3E5c63644E683549055b9Be8653de26E0B4CD36E": "SafeL2 1.3.0",
  "0x69f4D1788e39c87893C980c06EdF4b7f686e2938": "Safe 1.3.0 (eip155)",
  "0xfb1bffC9d739B8D520DaF37dF666da4C687191EA": "SafeL2 1.3.0 (eip155)",
};
const GUARD_SLOT = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";
const FALLBACK_HANDLER_SLOT = "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5";
const SENTINEL = "0x0000000000000000000000000000000000000001";

const safeIface = new Interface([
  "function VERSION() view returns (string)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)",
]);
const factoryIface = new Interface([
  "function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
  "function createChainSpecificProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce)",
  "function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
]);
const addr = (word) => getAddress(`0x${word.slice(26)}`);

async function creationInfo(chain) {
  try {
    const url = `https://api.routescan.io/v2/network/${chain.routescan}/evm/${chain.chainId}/etherscan/api?module=contract&action=getcontractcreation&contractaddresses=${SAFE}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const body = await res.json();
    const row = Array.isArray(body?.result) ? body.result[0] : null;
    if (!row?.txHash) return { source: "routescan", httpStatus: res.status, found: false };
    return { source: "routescan", found: true, txHash: row.txHash, creator: row.contractCreator ? getAddress(row.contractCreator) : null };
  } catch (error) { return { source: "routescan", error: String(error?.message || error).slice(0, 120) }; }
}

function decodeCreation(input) {
  let parsed = null;
  try { parsed = factoryIface.parseTransaction({ data: input }); } catch { /* not a direct factory call */ }
  if (!parsed || !parsed.name.startsWith("create")) return { decoded: false, selector: input.slice(0, 10), note: "not a direct SafeProxyFactory call (e.g. relayed or batched); creation parameters not decoded" };
  const [singleton, initializer, saltNonce] = parsed.args;
  let setup = null;
  try { setup = factoryIface.parseTransaction({ data: initializer }); } catch { /* non-standard initializer */ }
  return {
    decoded: true, factoryFunction: parsed.signature, chainSpecific: parsed.name === "createChainSpecificProxyWithNonce",
    singleton: getAddress(singleton), singletonLabel: KNOWN_SINGLETONS[getAddress(singleton)] || "unknown", saltNonce: saltNonce.toString(),
    setup: setup ? { owners: setup.args.owners.map(getAddress), threshold: setup.args.threshold.toString(), to: setup.args.to, fallbackHandler: setup.args.fallbackHandler, paymentToken: setup.args.paymentToken, payment: setup.args.payment.toString(), paymentReceiver: setup.args.paymentReceiver } : null,
    initializerHash: keccak256(initializer),
  };
}

async function inspect(chain) {
  const provider = new JsonRpcProvider(chain.rpc, chain.chainId, { staticNetwork: true });
  const out = { network: chain.name, expectedChainId: chain.chainId, rpcChainId: Number(BigInt(await provider.send("eth_chainId", []))), tipBlock: await provider.getBlockNumber() };
  const code = await provider.getCode(SAFE);
  Object.assign(out, { codePresent: code !== "0x", codeBytes: (code.length - 2) / 2, codeHash: code !== "0x" ? keccak256(code) : null, balanceWei: (await provider.getBalance(SAFE)).toString(), txCount: await provider.getTransactionCount(SAFE) });
  if (!out.codePresent) return out;
  const call = async (fn, args = []) => safeIface.decodeFunctionResult(fn, await provider.call({ to: SAFE, data: safeIface.encodeFunctionData(fn, args) }));
  try {
    out.masterCopy = addr(await provider.getStorage(SAFE, 0));
    out.masterCopyLabel = KNOWN_SINGLETONS[out.masterCopy] || "unknown";
    out.version = (await call("VERSION"))[0];
    out.owners = (await call("getOwners"))[0].map(getAddress);
    out.threshold = Number((await call("getThreshold"))[0]);
    out.nonce = (await call("nonce"))[0].toString();
    out.modules = (await call("getModulesPaginated", [SENTINEL, 10]))[0].map(getAddress);
    out.guard = addr(await provider.getStorage(SAFE, GUARD_SLOT));
    out.fallbackHandler = addr(await provider.getStorage(SAFE, FALLBACK_HANDLER_SLOT));
    out.ownerChecks = await Promise.all(out.owners.map(async (o) => ({ owner: o, isEOA: (await provider.getCode(o)) === "0x", nonce: await provider.getTransactionCount(o), isOldKey: o === getAddress(OLD_AUTHORITY), is0x284C: o === getAddress(ARTIST_WALLET_0x284C) })));
    out.isSafe = true;
  } catch (error) { out.isSafe = false; out.readError = String(error?.shortMessage || error?.message || error).slice(0, 160); }
  out.creation = await creationInfo(chain);
  if (out.creation?.txHash) {
    const tx = await provider.getTransaction(out.creation.txHash);
    if (tx) Object.assign(out.creation, { to: tx.to ? getAddress(tx.to) : null, from: getAddress(tx.from), blockNumber: tx.blockNumber, decoded: decodeCreation(tx.data) });
  }
  return out;
}

async function main() {
  const out = { probedAt: new Date().toISOString(), safe: SAFE, chains: [] };
  for (const chain of CHAINS) {
    try { out.chains.push(await inspect(chain)); } catch (error) { out.chains.push({ network: chain.name, error: String(error?.message || error).slice(0, 160) }); }
  }
  // Role membership on the Fuji P0 release (should be false before P0 step 1).
  try {
    const fuji = new JsonRpcProvider(CHAINS[0].rpc, 43113, { staticNetwork: true });
    out.fujiP0ReleaseRoles = Object.fromEntries(await Promise.all(Object.entries(ROLES).map(async ([name, hash]) => [name, releaseIface.decodeFunctionResult("hasRole", await fuji.call({ to: P0_RELEASE_FUJI, data: releaseIface.encodeFunctionData("hasRole", [hash, SAFE]) }))[0]])));
  } catch (error) { out.fujiP0ReleaseRolesError = String(error?.message || error).slice(0, 120); }
  console.log(JSON.stringify(out, null, 2));
}

main().catch((error) => { console.error(error); process.exit(1); });

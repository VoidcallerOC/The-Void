// Read-only readiness check for using a Safe as the Fuji release admin (owner
// decision R1) and an independent backup admin (R2). No signing, no broadcast.
//
//   [SAFE_AUTHORITY=0x.. BACKUP_ADMIN=0x..] node scripts/safe-readiness-probe.mjs
//
// 1. Canonical Safe v1.4.1 contracts: code present on Fuji and byte-identical to
//    Avalanche C-Chain.
// 2. Official Safe{Wallet} service support for chain 43113 (config + transaction
//    service). Absence means the web app cannot be assumed to create, propose,
//    sign or execute on Fuji.
// 3. The offline SafeTx EIP-712 hash used by the package equals the live Safe
//    singleton's own getTransactionHash().
// 4. With SAFE_AUTHORITY / BACKUP_ADMIN: proxy master copy, VERSION, owners,
//    threshold, modules, guard, fallback handler, nonce, independence from the old
//    key / 0x284C / each other, and current role membership on the P0 release.
import { Interface, JsonRpcProvider, ZeroAddress, getAddress, keccak256 } from "ethers";
import { ARTIST_WALLET_0x284C, OLD_AUTHORITY, RELEASES, ROLES, releaseIface, safeTxHash, validateAuthorities } from "./authority-rotation-plan.mjs";

const FUJI_RPC = process.env.FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc";
const MAINNET_RPC = process.env.MAINNET_RPC_URL || "https://api.avax.network/ext/bc/C/rpc";
const P0_RELEASE = RELEASES.find((r) => r.priority === "P0").address;
// safe-global/safe-deployments v1.4.1 canonical addresses.
export const SAFE_141 = Object.freeze({
  SafeProxyFactory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
  Safe: "0x41675C099F32341bf84BFc5382aF534df5C7461a",
  SafeL2: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
  CompatibilityFallbackHandler: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99",
  MultiSend: "0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526",
  MultiSendCallOnly: "0x9641d764fc13c8B624c04430C7356C1C7C8102e2",
  SignMessageLib: "0xd53cd0aB83D845Ac265BE939c57F53AD838012c9",
  CreateCall: "0x9b35Af71d77eaf8d7e40252370304687390A1A52",
  SimulateTxAccessor: "0x3d4BA2E0884aa488718476ca2FB8Efc291A46199",
});
const SAFE_SERVICES = [
  "https://safe-client.safe.global/v1/chains/43113",
  "https://safe-config.safe.global/api/v1/chains/43113/",
  "https://safe-client.safe.global/v1/chains/43114",
];
const GUARD_SLOT = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";
const FALLBACK_HANDLER_SLOT = "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5";
const SENTINEL = "0x0000000000000000000000000000000000000001";

const safeIface = new Interface([
  "function VERSION() view returns (string)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
]);

const fuji = new JsonRpcProvider(FUJI_RPC, 43113, { staticNetwork: true });
const mainnet = new JsonRpcProvider(MAINNET_RPC, 43114, { staticNetwork: true });
const call = async (provider, to, fn, args = []) => safeIface.decodeFunctionResult(fn, await provider.call({ to, data: safeIface.encodeFunctionData(fn, args) }));
const addr = (word) => getAddress(`0x${word.slice(26)}`);

async function services() {
  const out = {};
  for (const url of SAFE_SERVICES) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) });
      const body = res.ok ? await res.json() : null;
      out[url] = { httpStatus: res.status, chainName: body?.chainName ?? null, isTestnet: body?.isTestnet ?? null, l2: body?.l2 ?? null, transactionService: body?.transactionService ?? null };
      if (body?.transactionService) {
        try {
          const about = await fetch(`${body.transactionService.replace(/\/$/, "")}/api/v1/about/`, { signal: AbortSignal.timeout(15000) });
          out[url].transactionServiceAboutStatus = about.status;
        } catch (error) { out[url].transactionServiceAboutError = String(error?.message || error).slice(0, 120); }
      }
    } catch (error) { out[url] = { error: String(error?.message || error).slice(0, 160) }; }
  }
  return out;
}

async function inspectSafe(address, { forbidden }) {
  const code = await fuji.getCode(address);
  const r = { address, codePresent: code !== "0x" };
  if (!r.codePresent) return { ...r, isSafe: false };
  try {
    r.masterCopy = addr(await fuji.getStorage(address, 0));
    r.masterCopyCanonical141 = [SAFE_141.Safe, SAFE_141.SafeL2].map(getAddress).includes(r.masterCopy);
    r.version = (await call(fuji, address, "VERSION"))[0];
    r.owners = (await call(fuji, address, "getOwners"))[0].map(getAddress);
    r.threshold = Number((await call(fuji, address, "getThreshold"))[0]);
    r.nonce = (await call(fuji, address, "nonce"))[0].toString();
    const [modules] = await call(fuji, address, "getModulesPaginated", [SENTINEL, 10]);
    r.modules = modules.map(getAddress);
    r.guard = addr(await fuji.getStorage(address, GUARD_SLOT));
    r.fallbackHandler = addr(await fuji.getStorage(address, FALLBACK_HANDLER_SLOT));
    r.ownersAreEOAs = Object.fromEntries(await Promise.all(r.owners.map(async (o) => [o, (await fuji.getCode(o)) === "0x"])));
    r.checks = {
      canonicalMasterCopy: r.masterCopyCanonical141,
      version141: r.version === "1.4.1",
      thresholdAtLeast2: r.threshold >= 2,
      survivesOneLostKey: r.owners.length > r.threshold,
      noModules: r.modules.length === 0,
      noGuard: r.guard === ZeroAddress,
      fallbackHandlerCanonicalOrNone: [ZeroAddress, getAddress(SAFE_141.CompatibilityFallbackHandler)].includes(r.fallbackHandler),
      noForbiddenOwner: r.owners.every((o) => !forbidden.includes(o)),
    };
    r.isSafe = true;
  } catch (error) { r.isSafe = false; r.error = String(error?.shortMessage || error?.message || error).slice(0, 160); }
  return r;
}

async function main() {
  const out = { probedAt: new Date().toISOString(), fujiTip: await fuji.getBlockNumber(), canonicalContracts: {}, services: await services() };
  for (const [name, a] of Object.entries(SAFE_141)) {
    const [f, m] = await Promise.all([fuji.getCode(a), mainnet.getCode(a)]);
    out.canonicalContracts[name] = { address: a, fujiCode: f !== "0x", mainnetCode: m !== "0x", identicalToCChain: f !== "0x" && keccak256(f) === keccak256(m), fujiCodeHash: f !== "0x" ? keccak256(f) : null };
  }
  // The package's offline SafeTx hash must equal the deployed singleton's computation.
  const tx = { to: P0_RELEASE, value: "0", data: releaseIface.encodeFunctionData("revokeRole", [ROLES.DEFAULT_ADMIN_ROLE, OLD_AUTHORITY]), operation: 0, safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: ZeroAddress, refundReceiver: ZeroAddress, nonce: "7" };
  for (const singleton of [SAFE_141.Safe, SAFE_141.SafeL2]) {
    const live = (await call(fuji, singleton, "getTransactionHash", [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, tx.nonce]))[0];
    out[`safeTxHashCrossCheck_${singleton}`] = { live, offline: safeTxHash({ safe: getAddress(singleton), tx }), match: live === safeTxHash({ safe: getAddress(singleton), tx }) };
  }

  const { safe, backup } = validateAuthorities({ safe: process.env.SAFE_AUTHORITY, backup: process.env.BACKUP_ADMIN });
  out.supplied = { safe, backup };
  if (safe || backup) {
    const forbidden = [OLD_AUTHORITY, ARTIST_WALLET_0x284C, ...(backup ? [backup] : [])].map(getAddress);
    if (safe) out.safe = await inspectSafe(safe, { forbidden });
    if (backup) {
      const backupIsSafe = (await fuji.getCode(backup)) !== "0x";
      out.backup = backupIsSafe
        ? { kind: "contract", ...(await inspectSafe(backup, { forbidden: [OLD_AUTHORITY, ARTIST_WALLET_0x284C, ...(safe ? [safe] : [])].map(getAddress) })) }
        : { kind: "EOA", address: backup, nonce: await fuji.getTransactionCount(backup), balanceWei: (await fuji.getBalance(backup)).toString() };
      out.backup.notASafeOwner = !out.safe?.owners?.includes(backup);
      if (out.backup.owners && out.safe?.owners) out.backup.sharesNoOwnerWithSafe = out.backup.owners.every((o) => !out.safe.owners.includes(o));
    }
    out.p0RoleMembership = {};
    for (const [name, a] of Object.entries({ safe, backup })) {
      if (!a) continue;
      out.p0RoleMembership[name] = {};
      for (const [role, hash] of Object.entries(ROLES)) out.p0RoleMembership[name][role] = releaseIface.decodeFunctionResult("hasRole", await fuji.call({ to: P0_RELEASE, data: releaseIface.encodeFunctionData("hasRole", [hash, a]) }))[0];
    }
  }
  console.log(JSON.stringify(out, null, 2));
}

main().catch((error) => { console.error(error); process.exit(1); });

// Read-only pre-signing check of the deployer-authority rotation against live Fuji
// state. Every check is an eth_call / eth_estimateGas simulation: nothing is
// signed, nothing is broadcast and no state changes.
//
//   node scripts/authority-rotation-simulate.mjs
//
// What it proves (live): each rotation entry point exists and accepts the current
// authority; an unprivileged caller is rejected; whether the legacy sales can
// transfer ownership at all; that nothing on-chain stops the last admin from
// revoking itself; the sale state and pending balances of editions whose proceeds
// route to the old key; gas for each old-key step.
// What it cannot prove: steps signed by the replacement authority run against
// state that does not exist yet, so they are simulated from the current admin
// (same onlyRole(DEFAULT_ADMIN_ROLE) gate in source) and labelled as such.
import { Interface, JsonRpcProvider, getAddress } from "ethers";
import { OLD_AUTHORITY, ROLES, RELEASES, OWNABLES, releaseIface, ownableIface } from "./authority-rotation-plan.mjs";

const FUJI_RPC = process.env.FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc";
// Simulation-only stand-ins. Neither is a proposed replacement authority.
const PROBE_GRANTEE = "0x00000000000000000000000000000000000000A1";
const UNPRIVILEGED = "0x000000000000000000000000000000000000dEaD";
const ARTIST_WALLET = "0x284C09a7CC187E096cbbdc88d99DEFE6df32180a";

const saleIface = new Interface([
  "function sales(uint256) view returns (uint256 priceWei, uint256 maxSupply, uint256 sold, uint256 perWalletLimit, uint64 startTime, uint64 endTime, bool paused, bool configured)",
  "function balances(address) view returns (uint256)",
  "function platformFeeBps() view returns (uint256)",
  "function releases() view returns (address)",
  "function configureSale(uint256 tokenId, uint256 priceWei, uint256 maxSupply, uint256 perWalletLimit, uint64 startTime, uint64 endTime, bool paused)",
]);
const editionIface = new Interface([
  "event EditionCreated(uint256 indexed tokenId, bytes32 indexed releaseId, bytes32 indexed editionId, address artist, uint256 maxSupply, string metadataUri)",
  "function artistOf(uint256) view returns (address)",
  "function payoutOf(uint256) view returns (address)",
]);
// Privileged surface checked in the deployed dispatcher (PUSH4 + selector).
const PRIVILEGED = ["pause()", "unpause()", "mint(address,uint256,uint256,bytes)", "mintBatch(address,uint256[],uint256[],bytes)", "createEdition(bytes32,bytes32,uint256,string)", "createEdition(bytes32,bytes32,uint256,string,address,uint96)", "configureSale(uint256,uint256,uint256,uint256,uint64,uint64,bool)", "withdraw()", "transferOwnership(address)", "setPlatformFeeBps(uint256)", "grantRole(bytes32,address)", "revokeRole(bytes32,address)", "renounceRole(bytes32)"];
// Editions whose artistOf/payoutOf is OLD_AUTHORITY (authority inventory, live).
const OLD_KEY_EDITIONS = {
  "0xcc26cd6D6dc25654652D1FBB64dB5F61E20F60F1": [
    "32973968306772830434393710851061790601314118564265222743771059411608976358491",
    "23685155712394957401511510495110946071855190423032439714405816634523406427325",
    "9404686040103260377530222232027412559186112217689961434973498871367969795642",
    "33778802922810732976408591241428358474475553907731009337085064305512658576739",
    "86336109522257422783953313092869910591261689395232051112421244253165221467155",
    "69621777096996404494569967715110965261109496187347335164928263396549073080909",
  ],
};

const provider = new JsonRpcProvider(FUJI_RPC, 43113, { staticNetwork: true });
const selectorOf = (sig) => new Interface([`function ${sig}`]).getFunction(sig.split("(")[0]).selector;

async function simulate(from, to, data) {
  try {
    await provider.call({ from, to, data });
    let gas = null;
    try { gas = (await provider.estimateGas({ from, to, data })).toString(); } catch { /* call ok, estimate not essential */ }
    return { ok: true, gas };
  } catch (error) {
    const revertData = error?.data || error?.info?.error?.data || null;
    return { ok: false, revertSelector: typeof revertData === "string" ? revertData.slice(0, 10) : null, reason: error?.shortMessage || String(error?.message || error).slice(0, 160) };
  }
}

async function main() {
  const old = getAddress(OLD_AUTHORITY);
  const tip = await provider.getBlockNumber();
  const feeData = await provider.getFeeData();
  const out = { probedAt: new Date().toISOString(), tipBlock: tip, gasPriceWei: feeData.gasPrice?.toString() ?? null, oldAuthority: old, oldBalanceWei: (await provider.getBalance(old)).toString(), oldNonce: await provider.getTransactionCount(old), releases: [], ownables: [], sales: [] };

  for (const c of RELEASES) {
    const code = (await provider.getCode(c.address)).toLowerCase();
    const r = { address: c.address, label: c.label, privilegedSelectorsPresent: Object.fromEntries(PRIVILEGED.map((s) => [s, code.includes(`63${selectorOf(s).slice(2)}`)])) };
    r.grantFromOld = await simulate(old, c.address, releaseIface.encodeFunctionData("grantRole", [ROLES.DEFAULT_ADMIN_ROLE, PROBE_GRANTEE]));
    r.grantFromUnprivileged = await simulate(UNPRIVILEGED, c.address, releaseIface.encodeFunctionData("grantRole", [ROLES.DEFAULT_ADMIN_ROLE, PROBE_GRANTEE]));
    r.grantFromArtistWallet = await simulate(ARTIST_WALLET, c.address, releaseIface.encodeFunctionData("grantRole", [ROLES.DEFAULT_ADMIN_ROLE, PROBE_GRANTEE]));
    // Same calldata the replacement will sign, simulated from the current admin.
    r.revokeAsAdmin = {};
    for (const role of ["ISSUER_ROLE", "DEFAULT_ADMIN_ROLE", "ARTIST_ROLE"]) r.revokeAsAdmin[role] = await simulate(old, c.address, releaseIface.encodeFunctionData("revokeRole", [ROLES[role], old]));
    r.revokeFromUnprivileged = await simulate(UNPRIVILEGED, c.address, releaseIface.encodeFunctionData("revokeRole", [ROLES.ISSUER_ROLE, old]));
    // Last-admin guard: succeeds => nothing on-chain prevents a permanent lockout.
    r.lastAdminRenounceSucceeds = (await simulate(old, c.address, releaseIface.encodeFunctionData("renounceRole", [ROLES.DEFAULT_ADMIN_ROLE]))).ok;
    out.releases.push(r);
  }

  for (const c of OWNABLES) {
    const o = { address: c.address, label: c.label };
    o.transferOwnershipFromOwner = await simulate(old, c.address, ownableIface.encodeFunctionData("transferOwnership", [PROBE_GRANTEE]));
    o.transferOwnershipFromUnprivileged = await simulate(UNPRIVILEGED, c.address, ownableIface.encodeFunctionData("transferOwnership", [PROBE_GRANTEE]));
    try {
      const current = await provider.call({ to: c.address, data: ownableIface.encodeFunctionData("platformFeeBps") });
      o.platformFeeBps = ownableIface.decodeFunctionResult("platformFeeBps", current)[0].toString();
      o.setSameFeeFromOwner = await simulate(old, c.address, ownableIface.encodeFunctionData("setPlatformFeeBps", [o.platformFeeBps]));
      o.setFeeZeroFromOwner = await simulate(old, c.address, ownableIface.encodeFunctionData("setPlatformFeeBps", [0]));
    } catch { /* not a fee contract */ }
    out.ownables.push(o);
  }

  for (const [sale, tokenIds] of Object.entries(OLD_KEY_EDITIONS)) {
    const read = async (fn, args = []) => saleIface.decodeFunctionResult(fn, await provider.call({ to: sale, data: saleIface.encodeFunctionData(fn, args) }));
    const release = (await read("releases"))[0];
    const now = (await provider.getBlock(tip)).timestamp;
    const s = { sale, release, blockTimestamp: now, balances: { [old]: (await read("balances", [old]))[0].toString(), [ARTIST_WALLET]: (await read("balances", [ARTIST_WALLET]))[0].toString() }, editions: [] };
    for (const tokenId of tokenIds) {
      const v = await read("sales", [tokenId]);
      const payout = editionIface.decodeFunctionResult("payoutOf", await provider.call({ to: release, data: editionIface.encodeFunctionData("payoutOf", [tokenId]) }))[0];
      const open = v.configured && !v.paused && (v.startTime === 0n || BigInt(now) >= v.startTime) && (v.endTime === 0n || BigInt(now) <= v.endTime) && (v.maxSupply === 0n || v.sold < v.maxSupply);
      const e = { tokenId, payout, configured: v.configured, paused: v.paused, priceWei: v.priceWei.toString(), sold: v.sold.toString(), maxSupply: v.maxSupply.toString(), perWalletLimit: v.perWalletLimit.toString(), startTime: v.startTime.toString(), endTime: v.endTime.toString(), purchasableNow: open };
      if (open) {
        // Optional pre-rotation close: same parameters, paused = true. Only the edition
        // artist (the old key) can do this, and only while it still holds ARTIST_ROLE.
        e.closeCalldata = saleIface.encodeFunctionData("configureSale", [tokenId, v.priceWei, v.maxSupply, v.perWalletLimit, v.startTime, v.endTime, true]);
        e.closeFromOld = await simulate(old, sale, e.closeCalldata);
        e.closeFromUnprivileged = await simulate(UNPRIVILEGED, sale, e.closeCalldata);
      }
      s.editions.push(e);
    }
    s.withdrawFromOld = await simulate(old, sale, "0x3ccfd60b");
    out.sales.push(s);
  }
  console.log(JSON.stringify(out, null, 2));
}

main().catch((error) => { console.error(error); process.exit(1); });

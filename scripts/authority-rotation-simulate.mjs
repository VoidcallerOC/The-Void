// Read-only pre-signing check of the deployer-authority rotation against live Fuji
// state. Every check is an eth_call / eth_estimateGas / eth_createAccessList /
// eth_getStorageAt request: nothing is signed, nothing is broadcast and no state
// changes.
//
//   [SAFE_AUTHORITY=0x.. BACKUP_ADMIN=0x..] node scripts/authority-rotation-simulate.mjs
//
// What it proves (live): each rotation entry point exists and accepts the current
// authority; unprivileged callers are rejected; whether the legacy sales can
// transfer ownership; that nothing on-chain stops the last admin from removing
// itself; the storage layout used for state overrides matches live state; the P0
// sequence passes every access gate when each step runs on the state its
// predecessors produce (modelled with eth_call state overrides); the two sale
// closes touch only their own edition and stop purchases.
// What it cannot prove: that the modelled intermediate state is what the real
// transactions produce (that rests on the source and on the postcondition reads
// after each executed step), mempool ordering, or the signers' custody. Without
// SAFE_AUTHORITY/BACKUP_ADMIN it uses labelled stand-in addresses.
import { AbiCoder, Interface, JsonRpcProvider, getAddress, id, keccak256, toBeHex, zeroPadValue } from "ethers";
import { OLD_AUTHORITY, ROLES, RELEASES, OWNABLES, LOCKED_OWNABLES, OPEN_OLD_KEY_SALES, LEGACY_SALE_82B26, LEGACY_RELEASE_82B26, buildRotationPlan, buildSaleCloseSteps, releaseIface, ownableIface, validateAuthorities } from "./authority-rotation-plan.mjs";

const FUJI_RPC = process.env.FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc";
// Simulation-only stand-ins. None is a proposed authority.
const PROBE_GRANTEE = "0x00000000000000000000000000000000000000A1";
const UNPRIVILEGED = "0x000000000000000000000000000000000000dEaD";
const ARTIST_WALLET = "0x284C09a7CC187E096cbbdc88d99DEFE6df32180a";
const STANDIN_SAFE = "0x00000000000000000000000000000000000000A1";
const STANDIN_BACKUP = "0x00000000000000000000000000000000000000b2";
// Fresh buyer with no code (0xdEaD has code on Fuji and rejects ERC-1155 receipt).
const SIM_BUYER = getAddress(`0x${id("the-void:rotation-sim-buyer").slice(-40)}`);
const P0_RELEASE = RELEASES.find((r) => r.priority === "P0").address;
// Storage layout (solc --storage-layout; validated against live state below):
// VoidRelease1155/V2 `_roles` mapping at slot 0; legacy VoidPrimarySale `_status` 0,
// `platformFeeBps` 1, `owner` 2, `sales` 3 (struct: price, maxSupply, sold,
// perWalletLimit, then startTime|endTime<<64|paused<<128|configured<<136).
const ROLES_SLOT = 0n;
const SALES_SLOT = 3n;

const coder = AbiCoder.defaultAbiCoder();
const roleSlot = (role, account) => keccak256(coder.encode(["address", "bytes32"], [account, keccak256(coder.encode(["bytes32", "uint256"], [role, ROLES_SLOT]))]));
const saleBase = (tokenId) => BigInt(keccak256(coder.encode(["uint256", "uint256"], [tokenId, SALES_SLOT])));
const word = (n) => zeroPadValue(toBeHex(BigInt(n)), 32);
const TRUE = word(1);
const FALSE = word(0);

const saleIface = new Interface([
  "function sales(uint256) view returns (uint256 priceWei, uint256 maxSupply, uint256 sold, uint256 perWalletLimit, uint64 startTime, uint64 endTime, bool paused, bool configured)",
  "function balances(address) view returns (uint256)",
  "function platformFeeBps() view returns (uint256)",
  "function owner() view returns (address)",
  "function releases() view returns (address)",
  "function configureSale(uint256 tokenId, uint256 priceWei, uint256 maxSupply, uint256 perWalletLimit, uint64 startTime, uint64 endTime, bool paused)",
  "function purchase(uint256 tokenId, uint256 qty) payable",
]);
const editionIface = new Interface([
  "function artistOf(uint256) view returns (address)",
  "function payoutOf(uint256) view returns (address)",
  "function maxSupplyOf(uint256) view returns (uint256)",
  "function mint(address to, uint256 tokenId, uint256 amount, bytes data)",
]);
// Privileged surface checked in the deployed dispatcher (PUSH4 + selector). The batch
// and two-step entries are listed to show the contracts offer no atomic handoff.
const PRIVILEGED = ["pause()", "unpause()", "mint(address,uint256,uint256,bytes)", "mintBatch(address,uint256[],uint256[],bytes)", "createEdition(bytes32,bytes32,uint256,string)", "createEdition(bytes32,bytes32,uint256,string,address,uint96)", "grantRole(bytes32,address)", "revokeRole(bytes32,address)", "renounceRole(bytes32)", "multicall(bytes[])", "multicall(uint256,bytes[])", "beginDefaultAdminTransfer(address)", "acceptDefaultAdminTransfer()", "execute(address,uint256,bytes)"];
const ERRORS = Object.fromEntries(["AccessDenied(bytes32,address)", "AccessDenied(address)", "NotOwner()", "NotEditionArtist(uint256,address,address)", "SalePaused(uint256)", "ContractPaused()"].map((s) => [id(s).slice(0, 10), s]));

const provider = new JsonRpcProvider(FUJI_RPC, 43113, { staticNetwork: true });
const selectorOf = (sig) => id(sig).slice(0, 10);

async function simulate(from, to, data, { overrides = null, value = 0n, estimate = true } = {}) {
  const tx = { from, to, data, ...(value ? { value: toBeHex(value) } : {}) };
  try {
    if (overrides) await provider.send("eth_call", [tx, "latest", overrides]);
    else await provider.call({ ...tx, value });
    let gas = null;
    if (estimate && !overrides) { try { gas = (await provider.estimateGas({ ...tx, value })).toString(); } catch { /* call ok; estimate not essential */ } }
    return { ok: true, gas };
  } catch (error) {
    const revertData = error?.data || error?.info?.error?.data || error?.error?.data || null;
    const selector = typeof revertData === "string" ? revertData.slice(0, 10) : null;
    return { ok: false, revertSelector: selector, revertError: ERRORS[selector] || null, reason: error?.shortMessage || String(error?.message || error).slice(0, 160) };
  }
}
const storageAt = (address, slot) => provider.getStorage(address, typeof slot === "bigint" ? toBeHex(slot) : slot);

async function p0Sequence(old, safe, backup) {
  const rel = P0_RELEASE;
  const plan = buildRotationPlan({ safe, backup, safeNonce: 0, scope: "P0" });
  const state = {};
  const overrides = () => ({ [rel]: { stateDiff: { ...state } } });
  const set = (role, account, held) => { state[roleSlot(ROLES[role], account)] = held ? TRUE : FALSE; };
  const steps = [];
  // Negative control: before any grant, the Safe's removal step must be rejected.
  const safeRemoval = plan.find((s) => s.signer === safe && s.args.role === "DEFAULT_ADMIN_ROLE");
  const control = await simulate(safe, rel, safeRemoval.calldata, { overrides: overrides() });
  for (const s of plan) {
    const from = s.signer;
    const result = await simulate(from, rel, s.calldata, { overrides: overrides() });
    steps.push({ step: s.step, phase: s.phase, from, function: s.function, args: s.args, calldata: s.calldata, simulated: result });
    // Model the step's effect for the next step (source: grantRole/revokeRole set one bit).
    if (result.ok) set(s.args.role, s.function.startsWith("grantRole") ? s.args.account : OLD_AUTHORITY, s.function.startsWith("grantRole"));
  }
  const after = {
    oldCanStillAdminister: await simulate(old, rel, releaseIface.encodeFunctionData("grantRole", [ROLES.DEFAULT_ADMIN_ROLE, old]), { overrides: overrides() }),
    oldCanStillMint: await simulate(old, rel, editionIface.encodeFunctionData("mint", [old, 1n, 1n, "0x"]), { overrides: overrides() }),
    safeCanAdminister: await simulate(safe, rel, releaseIface.encodeFunctionData("grantRole", [ROLES.DEFAULT_ADMIN_ROLE, safe]), { overrides: overrides() }),
    backupCanAdminister: await simulate(backup, rel, releaseIface.encodeFunctionData("grantRole", [ROLES.DEFAULT_ADMIN_ROLE, backup]), { overrides: overrides() }),
  };
  return { release: rel, safe, backup, negativeControlSafeBeforeGrant: control, steps, finalState: after };
}

async function main() {
  const old = getAddress(OLD_AUTHORITY);
  const resolved = validateAuthorities({ safe: process.env.SAFE_AUTHORITY, backup: process.env.BACKUP_ADMIN });
  const tip = await provider.getBlockNumber();
  const feeData = await provider.getFeeData();
  const out = { probedAt: new Date().toISOString(), tipBlock: tip, gasPriceWei: feeData.gasPrice?.toString() ?? null, oldAuthority: old, oldBalanceWei: (await provider.getBalance(old)).toString(), oldNonce: await provider.getTransactionCount(old), releases: [], ownables: [], sales: [] };

  // State-override support and storage layout, validated against live state.
  out.layout = {
    stateOverrideSupported: (await simulate(UNPRIVILEGED, P0_RELEASE, releaseIface.encodeFunctionData("grantRole", [ROLES.DEFAULT_ADMIN_ROLE, PROBE_GRANTEE]), { overrides: { [P0_RELEASE]: { stateDiff: { [roleSlot(ROLES.DEFAULT_ADMIN_ROLE, UNPRIVILEGED)]: TRUE } } } })).ok,
    releaseRolesSlot0: {},
  };
  for (const c of RELEASES) {
    out.layout.releaseRolesSlot0[c.address] = {
      adminOld: await storageAt(c.address, roleSlot(ROLES.DEFAULT_ADMIN_ROLE, old)) === TRUE,
      adminUnprivileged: await storageAt(c.address, roleSlot(ROLES.DEFAULT_ADMIN_ROLE, UNPRIVILEGED)) === FALSE,
    };
  }

  for (const c of RELEASES) {
    const code = (await provider.getCode(c.address)).toLowerCase();
    const r = { address: c.address, label: c.label, privilegedSelectorsPresent: Object.fromEntries(PRIVILEGED.map((s) => [s, code.includes(`63${selectorOf(s).slice(2)}`)])) };
    r.grantFromOld = await simulate(old, c.address, releaseIface.encodeFunctionData("grantRole", [ROLES.DEFAULT_ADMIN_ROLE, PROBE_GRANTEE]));
    r.grantFromUnprivileged = await simulate(UNPRIVILEGED, c.address, releaseIface.encodeFunctionData("grantRole", [ROLES.DEFAULT_ADMIN_ROLE, PROBE_GRANTEE]));
    r.grantFromArtistWallet = await simulate(ARTIST_WALLET, c.address, releaseIface.encodeFunctionData("grantRole", [ROLES.DEFAULT_ADMIN_ROLE, PROBE_GRANTEE]));
    r.revokeAsAdmin = {};
    for (const role of ["ISSUER_ROLE", "DEFAULT_ADMIN_ROLE", "ARTIST_ROLE"]) r.revokeAsAdmin[role] = await simulate(old, c.address, releaseIface.encodeFunctionData("revokeRole", [ROLES[role], old]));
    r.revokeFromUnprivileged = await simulate(UNPRIVILEGED, c.address, releaseIface.encodeFunctionData("revokeRole", [ROLES.ISSUER_ROLE, old]));
    // Last-admin guard: succeeds => nothing on-chain prevents a permanent lockout.
    r.lastAdminRenounceSucceeds = (await simulate(old, c.address, releaseIface.encodeFunctionData("renounceRole", [ROLES.DEFAULT_ADMIN_ROLE]))).ok;
    out.releases.push(r);
  }

  for (const c of [...OWNABLES.map((x) => ({ ...x, expectTransferable: true })), ...LOCKED_OWNABLES.map((x) => ({ ...x, expectTransferable: false }))]) {
    const o = { address: c.address, label: c.label, expectTransferable: c.expectTransferable };
    o.transferOwnershipFromOwner = await simulate(old, c.address, ownableIface.encodeFunctionData("transferOwnership", [PROBE_GRANTEE]));
    o.transferOwnershipFromUnprivileged = await simulate(UNPRIVILEGED, c.address, ownableIface.encodeFunctionData("transferOwnership", [PROBE_GRANTEE]));
    try {
      const current = await provider.call({ to: c.address, data: ownableIface.encodeFunctionData("platformFeeBps") });
      o.platformFeeBps = ownableIface.decodeFunctionResult("platformFeeBps", current)[0].toString();
      o.setSameFeeFromOwner = await simulate(old, c.address, ownableIface.encodeFunctionData("setPlatformFeeBps", [o.platformFeeBps]));
      o.setFeeZeroFromOwner = await simulate(old, c.address, ownableIface.encodeFunctionData("setPlatformFeeBps", [0]));
      o.setFeeAboveCapFromOwner = await simulate(old, c.address, ownableIface.encodeFunctionData("setPlatformFeeBps", [BigInt(o.platformFeeBps) + 1n]));
    } catch { /* not a fee contract */ }
    out.ownables.push(o);
  }

  // Sale closes (decision R3): every edition on 0x82b26 that pays the old key, plus
  // close-specific verification for the open ones.
  {
    const sale = LEGACY_SALE_82B26;
    const read = async (iface, to, fn, args = []) => iface.decodeFunctionResult(fn, await provider.call({ to, data: iface.encodeFunctionData(fn, args) }));
    const release = getAddress((await read(saleIface, sale, "releases"))[0]);
    const now = (await provider.getBlock(tip)).timestamp;
    const s = {
      simBuyer: SIM_BUYER, simBuyerHasCode: (await provider.getCode(SIM_BUYER)) !== "0x",
      sale, release, releaseMatchesPlan: release === getAddress(LEGACY_RELEASE_82B26), blockTimestamp: now,
      layout: { owner: getAddress(`0x${(await storageAt(sale, 2n)).slice(26)}`) === getAddress((await read(saleIface, sale, "owner"))[0]), platformFeeBps: BigInt(await storageAt(sale, 1n)) === (await read(saleIface, sale, "platformFeeBps"))[0] },
      oldHoldsArtistRole: (await read(releaseIface, release, "hasRole", [ROLES.ARTIST_ROLE, old]))[0],
      balances: { [old]: (await read(saleIface, sale, "balances", [old]))[0].toString(), [ARTIST_WALLET]: (await read(saleIface, sale, "balances", [ARTIST_WALLET]))[0].toString() },
      planCloseSteps: buildSaleCloseSteps().map((p) => ({ step: p.step, tokenId: p.args.tokenId, calldata: p.calldata })),
      editions: [],
    };
    const openIds = OPEN_OLD_KEY_SALES.map((e) => e.tokenId);
    for (const e of OPEN_OLD_KEY_SALES) {
      const tokenId = e.tokenId;
      const v = await read(saleIface, sale, "sales", [tokenId]);
      const base = saleBase(tokenId);
      const packedLive = await storageAt(sale, base + 4n);
      const packedExpected = word(v.startTime | (v.endTime << 64n) | ((v.paused ? 1n : 0n) << 128n) | ((v.configured ? 1n : 0n) << 136n));
      const packedAfterClose = word(v.startTime | (v.endTime << 64n) | (1n << 128n) | (1n << 136n));
      const liveCalldata = saleIface.encodeFunctionData("configureSale", [tokenId, v.priceWei, v.maxSupply, v.perWalletLimit, v.startTime, v.endTime, true]);
      const planStep = buildSaleCloseSteps().find((p) => p.args.tokenId === tokenId);
      const ed = {
        tokenId,
        artist: getAddress((await read(editionIface, release, "artistOf", [tokenId]))[0]),
        payout: getAddress((await read(editionIface, release, "payoutOf", [tokenId]))[0]),
        editionMaxSupply: (await read(editionIface, release, "maxSupplyOf", [tokenId]))[0].toString(),
        live: { configured: v.configured, paused: v.paused, priceWei: v.priceWei.toString(), sold: v.sold.toString(), maxSupply: v.maxSupply.toString(), perWalletLimit: v.perWalletLimit.toString(), startTime: v.startTime.toString(), endTime: v.endTime.toString() },
        layoutMatches: packedLive === packedExpected && BigInt(await storageAt(sale, base)) === v.priceWei && BigInt(await storageAt(sale, base + 2n)) === v.sold,
        planCalldataMatchesLive: planStep?.calldata === liveCalldata,
        closeFromOld: await simulate(old, sale, liveCalldata),
        closeFromUnprivileged: await simulate(UNPRIVILEGED, sale, liveCalldata),
        closeFrom0x284C: await simulate(ARTIST_WALLET, sale, liveCalldata),
        // Ordering requirement: with the old key's ARTIST_ROLE already revoked, the close must fail.
        closeAfterArtistRevoke: await simulate(old, sale, liveCalldata, { overrides: { [release]: { stateDiff: { [roleSlot(ROLES.ARTIST_ROLE, old)]: FALSE } } } }),
        purchaseNow: await simulate(SIM_BUYER, sale, saleIface.encodeFunctionData("purchase", [tokenId, 1n]), { value: v.priceWei, overrides: { [SIM_BUYER]: { balance: toBeHex(10n ** 18n) } } }),
        purchaseAfterClose: await simulate(SIM_BUYER, sale, saleIface.encodeFunctionData("purchase", [tokenId, 1n]), { value: v.priceWei, overrides: { [SIM_BUYER]: { balance: toBeHex(10n ** 18n) }, [sale]: { stateDiff: { [toBeHex(base + 4n, 32)]: packedAfterClose } } } }),
      };
      // Isolation: the close may touch only sales[tokenId] in the sale contract's storage.
      try {
        const al = await provider.send("eth_createAccessList", [{ from: old, to: sale, data: liveCalldata }, "latest"]);
        const allowed = new Set([0n, 1n, 2n, 3n, 4n].map((i) => toBeHex(base + i, 32).toLowerCase()));
        const saleKeys = (al.accessList || []).filter((x) => getAddress(x.address) === getAddress(sale)).flatMap((x) => x.storageKeys.map((k) => k.toLowerCase()));
        ed.accessList = { saleStorageKeys: saleKeys, onlyOwnEditionSlots: saleKeys.every((k) => allowed.has(k)), otherContracts: (al.accessList || []).map((x) => getAddress(x.address)).filter((a) => a !== getAddress(sale)) };
      } catch (error) { ed.accessList = { error: String(error?.shortMessage || error?.message || error).slice(0, 160) }; }
      // The other open edition stays purchasable when only this one is closed.
      const other = openIds.find((x) => x !== tokenId);
      const otherSale = await read(saleIface, sale, "sales", [other]);
      ed.otherEditionPurchasableAfterThisClose = await simulate(SIM_BUYER, sale, saleIface.encodeFunctionData("purchase", [other, 1n]), { value: otherSale.priceWei, overrides: { [SIM_BUYER]: { balance: toBeHex(10n ** 18n) }, [sale]: { stateDiff: { [toBeHex(base + 4n, 32)]: packedAfterClose } } } });
      s.editions.push(ed);
    }
    out.sales.push(s);
  }

  out.p0Sequence = await p0Sequence(old, resolved.safe || STANDIN_SAFE, resolved.backup || STANDIN_BACKUP);
  out.p0Sequence.addresses = resolved.safe && resolved.backup ? "owner-supplied" : "STAND-IN (not proposed authorities): re-run with SAFE_AUTHORITY and BACKUP_ADMIN";
  console.log(JSON.stringify(out, null, 2));
}

main().catch((error) => { console.error(error); process.exit(1); });

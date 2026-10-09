// Offline generator for the deployer-authority rotation package. It encodes
// calldata from the repository ABIs and prints an ordered, reviewable list of
// unsigned transactions. It has no RPC access, never signs and never broadcasts.
//
//   SAFE_AUTHORITY=0x<verified Safe> BACKUP_ADMIN=0x<verified backup> SAFE_NONCE=<n> \
//     SCOPE=P0 node scripts/authority-rotation-plan.mjs
//
// Design (owner decisions R1/R2): a fresh Safe becomes the primary admin and an
// independently controlled backup admin is added. Both are granted, and the
// backup proves it can administer, before the Safe removes the old key's
// DEFAULT_ADMIN_ROLE. No step ever revokes or renounces the Safe or the backup.
// An unresolved address is a hard blocker: the step is emitted with calldata null
// and blockedOn set; placeholder bytes are never encoded.
import { Interface, TypedDataEncoder, ZeroAddress, getAddress, id, isAddress } from "ethers";

export const OLD_AUTHORITY = "0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174";
// Separate privileged key (owner decision R5: unchanged by this package). It may be
// neither the Safe nor the backup, so the package never concentrates its authority.
export const ARTIST_WALLET_0x284C = "0x284C09a7CC187E096cbbdc88d99DEFE6df32180a";
export const CHAIN_ID = 43113;
export const ROLES = Object.freeze({
  DEFAULT_ADMIN_ROLE: `0x${"00".repeat(32)}`,
  ARTIST_ROLE: id("ARTIST_ROLE"),
  ISSUER_ROLE: id("ISSUER_ROLE"),
});

// VoidRelease1155 / VoidRelease1155V2: custom AccessControl (grantRole/revokeRole by
// DEFAULT_ADMIN_ROLE only; renounceRole(bytes32) self-only; no last-admin guard; no
// multicall or two-step admin transfer). VoidReleaseFactory: single-step transferOwnership.
export const releaseIface = new Interface([
  "function grantRole(bytes32 role, address account)",
  "function revokeRole(bytes32 role, address account)",
  "function renounceRole(bytes32 role)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
]);
export const ownableIface = new Interface([
  "function transferOwnership(address newOwner)",
  "function owner() view returns (address)",
  "function setPlatformFeeBps(uint256 nextBps)",
  "function platformFeeBps() view returns (uint256)",
]);

// Authority held by OLD_AUTHORITY, per the read-only inventory (scripts/authority-inventory.mjs).
export const RELEASES = Object.freeze([
  { address: "0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6", label: "Shared release V2 (live)", priority: "P0" },
  { address: "0x262B774cf9a1949170B58E2d57F6189980FE757b", label: "Release V1 (legacy certified)", priority: "P1" },
  { address: "0x82b26Da27136935454Bdf1e40801190B521b82e5", label: "Release (legacy marketplace token)", priority: "P1" },
  { address: "0x7A78F13Bef1a984676787Df1878F0C378b9dFc6e", label: "Release (superseded)", priority: "P2" },
]);
export const OWNABLES = Object.freeze([
  { address: "0x8291A4F1936C1c5C6D8917b0966c80757cd5c265", label: "VoidReleaseFactory V1 (unused)", priority: "P2" },
]);
// Legacy VoidPrimarySale deployments built from source before commit 80c32af: the
// deployed bytecode has no transferOwnership(address) (live dispatcher check and
// eth_call simulation), so owner() stays OLD_AUTHORITY permanently. The only owner
// power is setPlatformFeeBps(x) with x <= platformFeeCapBps (500 = current fee):
// the old key can lower the platform fee, never raise it or redirect any payout.
// Accepted residual for this rotation (owner decision R6).
export const LOCKED_OWNABLES = Object.freeze([
  { address: "0x51cCD2d5Cd71368917f1EFe3fa43Fab8068E1aBA", label: "Shared primary sale (live)", priority: "P0" },
  { address: "0xcc26cd6D6dc25654652D1FBB64dB5F61E20F60F1", label: "Primary sale for 0x82b26", priority: "P1" },
  { address: "0x7D1a068F532aD6c0f591d4Fb9F82fd5b97495363", label: "Primary sale for 0x7A78", priority: "P2" },
]);

// Pre-steps (owner decision R3): two editions on 0x82b26 pay OLD_AUTHORITY and were
// OPEN for purchase in the live simulation; only their artist (the old key, while it
// holds ARTIST_ROLE on 0x82b26) can close them. Parameters are the live sale values
// with paused = true. They must execute before the ARTIST_ROLE revoke on 0x82b26.
export const saleIface = new Interface([
  "function configureSale(uint256 tokenId, uint256 priceWei, uint256 maxSupply, uint256 perWalletLimit, uint64 startTime, uint64 endTime, bool paused)",
  "function withdraw()",
]);
export const LEGACY_SALE_82B26 = "0xcc26cd6D6dc25654652D1FBB64dB5F61E20F60F1";
export const LEGACY_RELEASE_82B26 = "0x82b26Da27136935454Bdf1e40801190B521b82e5";
export const OPEN_OLD_KEY_SALES = Object.freeze([
  { tokenId: "33778802922810732976408591241428358474475553907731009337085064305512658576739", priceWei: "10000000000000000", maxSupply: "25", perWalletLimit: "1", startTime: "0", endTime: "0" },
  { tokenId: "86336109522257422783953313092869910591261689395232051112421244253165221467155", priceWei: "10000000000000000", maxSupply: "25", perWalletLimit: "20", startTime: "0", endTime: "0" },
]);
export function buildSaleCloseSteps() {
  return OPEN_OLD_KEY_SALES.map((e, i) => ({
    step: `P-${i + 1}`, phase: "pre-step: close open sale paying the old key", chainId: CHAIN_ID, value: "0", signer: OLD_AUTHORITY, signerKind: "EOA", to: LEGACY_SALE_82B26,
    contract: "Primary sale for 0x82b26", function: "configureSale(uint256,uint256,uint256,uint256,uint64,uint64,bool)",
    args: { ...e, paused: true },
    calldata: saleIface.encodeFunctionData("configureSale", [e.tokenId, e.priceWei, e.maxSupply, e.perWalletLimit, e.startTime, e.endTime, true]),
    mustPrecede: `revokeRole(ARTIST_ROLE, ${OLD_AUTHORITY}) on ${LEGACY_RELEASE_82B26}`,
    expected: "Writes only sales[tokenId] with identical parameters and paused = true; purchase() then reverts SalePaused(tokenId). Payout destination is not a parameter and cannot change.",
    postcondition: `sales(${e.tokenId}).paused == true AND priceWei/maxSupply/sold/perWalletLimit/startTime/endTime unchanged on ${LEGACY_SALE_82B26}`,
    stopIf: "receipt status != 1, or any SaleConfigured field other than paused differs from the live values",
  }));
}

export function validateAddress(value, name) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (!isAddress(text)) throw new Error(`${name} must be a 20-byte EVM address.`);
  if (text !== text.toLowerCase() && getAddress(text) !== text) throw new Error(`${name} has an invalid EIP-55 checksum.`);
  const address = getAddress(text);
  if (address === ZeroAddress) throw new Error(`${name} must not be the zero address.`);
  if (address === getAddress(OLD_AUTHORITY)) throw new Error(`${name} must differ from the authority being rotated out.`);
  if (address === getAddress(ARTIST_WALLET_0x284C)) throw new Error(`${name} must not be 0x284C, a separately privileged key (decision R5).`);
  const known = [...RELEASES, ...OWNABLES, ...LOCKED_OWNABLES].map((c) => getAddress(c.address));
  if (known.includes(address)) throw new Error(`${name} must not be one of the contracts being rotated.`);
  return address;
}

export function validateAuthorities({ safe = null, backup = null } = {}) {
  const s = validateAddress(safe, "SAFE_AUTHORITY");
  const b = validateAddress(backup, "BACKUP_ADMIN");
  if (s && b && s === b) throw new Error("BACKUP_ADMIN must be independent of SAFE_AUTHORITY (different address).");
  return { safe: s, backup: b };
}

// Safe v1.4.1 EIP-712 SafeTx. Every Safe step is operation 0 (CALL), no refund and
// no gas token, so the hash a signer's wallet shows can be compared byte for byte.
export const SAFE_TX_TYPES = Object.freeze({
  SafeTx: [
    { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" }, { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
});
export function safeTxHash({ safe, chainId = CHAIN_ID, tx }) {
  return TypedDataEncoder.hash({ chainId, verifyingContract: safe }, SAFE_TX_TYPES, tx);
}
function safeTx(to, data, nonce) {
  return { to, value: "0", data, operation: 0, safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: ZeroAddress, refundReceiver: ZeroAddress, nonce: nonce === null ? null : String(nonce) };
}

/**
 * Ordered plan per release (invariants unit-tested):
 *   1. old key   grantRole(DEFAULT_ADMIN_ROLE, SAFE)
 *   2. old key   grantRole(DEFAULT_ADMIN_ROLE, BACKUP)
 *   3. BACKUP    revokeRole(ISSUER_ROLE, old)          proves the backup administers
 *   4. SAFE      revokeRole(DEFAULT_ADMIN_ROLE, old)   proves the Safe; old key no longer admin
 *   5. SAFE      revokeRole(ARTIST_ROLE, old)
 * The old key's admin role is removed only by a transaction that itself proves the
 * Safe can act, after the backup has already proven itself, so no path leaves a
 * release without a working admin. Releases go P0 first; the single-step factory
 * ownership transfer (to the Safe) comes last. LOCKED_OWNABLES never appear.
 */
export function buildRotationPlan({ safe = null, backup = null, safeNonce = null, scope = "P0" } = {}) {
  const levels = { P0: ["P0"], P1: ["P0", "P1"], ALL: ["P0", "P1", "P2"] }[scope];
  if (!levels) throw new Error("scope must be P0, P1 or ALL.");
  ({ safe, backup } = validateAuthorities({ safe, backup }));
  const nonce0 = safeNonce === null || safeNonce === undefined || safeNonce === "" ? null : Number(safeNonce);
  if (nonce0 !== null && (!Number.isInteger(nonce0) || nonce0 < 0)) throw new Error("SAFE_NONCE must be a non-negative integer.");
  const steps = [];
  let safeOffset = 0;
  const add = (step) => steps.push({ step: steps.length + 1, chainId: CHAIN_ID, value: "0", ...step });
  const encodeOrBlock = (iface, fn, args, needs) => {
    const missing = needs.filter(([, v]) => !v).map(([n]) => n);
    return missing.length ? { calldata: null, blockedOn: missing } : { calldata: iface.encodeFunctionData(fn, args) };
  };
  const safeStep = (fields) => {
    const nonce = nonce0 === null ? null : nonce0 + safeOffset;
    safeOffset += 1;
    const blockedOn = [...(!safe ? ["SAFE_AUTHORITY"] : []), ...(nonce === null ? ["SAFE_NONCE"] : [])];
    const tx = safeTx(fields.to, fields.calldata, nonce);
    const hash = safe && nonce !== null ? safeTxHash({ safe, tx }) : null;
    add({ ...fields, signer: safe || "SAFE_AUTHORITY (unresolved)", signerKind: "Safe execTransaction (operation 0 = CALL)", safeTx: tx, safeTxHash: hash, ...(blockedOn.length ? { blockedOn } : {}) });
  };

  for (const c of RELEASES.filter((r) => levels.includes(r.priority))) {
    add({
      phase: "grant primary", signer: OLD_AUTHORITY, signerKind: "EOA", to: c.address, contract: c.label,
      function: "grantRole(bytes32,address)", args: { role: "DEFAULT_ADMIN_ROLE", account: safe || "SAFE_AUTHORITY (unresolved)" },
      ...encodeOrBlock(releaseIface, "grantRole", [ROLES.DEFAULT_ADMIN_ROLE, safe], [["SAFE_AUTHORITY", safe]]),
      expected: "Safe gains DEFAULT_ADMIN_ROLE. Old key keeps every role; recoverable by the old key.",
      postcondition: `hasRole(DEFAULT_ADMIN_ROLE, SAFE) == true on ${c.address}`,
      stopIf: "receipt status != 1, or the RoleGranted log names any account other than the Safe",
    });
    add({
      phase: "grant backup", signer: OLD_AUTHORITY, signerKind: "EOA", to: c.address, contract: c.label,
      function: "grantRole(bytes32,address)", args: { role: "DEFAULT_ADMIN_ROLE", account: backup || "BACKUP_ADMIN (unresolved)" },
      ...encodeOrBlock(releaseIface, "grantRole", [ROLES.DEFAULT_ADMIN_ROLE, backup], [["BACKUP_ADMIN", backup]]),
      expected: "Backup gains DEFAULT_ADMIN_ROLE. Old key keeps every role; recoverable by the old key.",
      postcondition: `hasRole(DEFAULT_ADMIN_ROLE, BACKUP) == true AND role holders from logs == {old, SAFE, BACKUP} on ${c.address}`,
      stopIf: "receipt status != 1, or any unexpected RoleGranted/RoleRevoked on this release since step 1",
    });
    add({
      phase: "backup proof", signer: backup || "BACKUP_ADMIN (unresolved)", signerKind: "backup admin (EOA or Safe, per verification)", to: c.address, contract: c.label,
      function: "revokeRole(bytes32,address)", args: { role: "ISSUER_ROLE", account: OLD_AUTHORITY },
      calldata: releaseIface.encodeFunctionData("revokeRole", [ROLES.ISSUER_ROLE, OLD_AUTHORITY]),
      ...(!backup ? { blockedOn: ["BACKUP_ADMIN"] } : {}),
      expected: "Old key loses ISSUER_ROLE (direct mint). RoleRevoked(ISSUER_ROLE, old, sender = BACKUP) proves the backup can exercise DEFAULT_ADMIN_ROLE.",
      postcondition: `hasRole(ISSUER_ROLE, old) == false; RoleRevoked sender == BACKUP on ${c.address}`,
      stopIf: "the backup cannot sign or the tx reverts: STOP. Do not let the Safe remove the old admin. Recovery: old key revokeRole(DEFAULT_ADMIN_ROLE, BACKUP), re-plan.",
    });
    safeStep({
      phase: "safe proof + old admin removal", to: c.address, contract: c.label,
      function: "revokeRole(bytes32,address)", args: { role: "DEFAULT_ADMIN_ROLE", account: OLD_AUTHORITY },
      calldata: releaseIface.encodeFunctionData("revokeRole", [ROLES.DEFAULT_ADMIN_ROLE, OLD_AUTHORITY]),
      expected: "Old key loses DEFAULT_ADMIN_ROLE. Executes only if the Safe reaches its threshold, so success is the Safe's proof. Admins afterwards: {SAFE, BACKUP}, both proven.",
      postcondition: `hasRole(DEFAULT_ADMIN_ROLE, old) == false AND DEFAULT_ADMIN holders from logs == {SAFE, BACKUP} on ${c.address}`,
      stopIf: "any DEFAULT_ADMIN holder other than SAFE and BACKUP appears in the logs: STOP and have the Safe revoke it before anything else",
    });
    safeStep({
      phase: "safe revoke", to: c.address, contract: c.label,
      function: "revokeRole(bytes32,address)", args: { role: "ARTIST_ROLE", account: OLD_AUTHORITY },
      calldata: releaseIface.encodeFunctionData("revokeRole", [ROLES.ARTIST_ROLE, OLD_AUTHORITY]),
      ...(c.address === LEGACY_RELEASE_82B26 ? { requiresCompleted: ["P-1", "P-2"] } : {}),
      expected: "Old key loses ARTIST_ROLE (createEdition; configureSale for editions it created).",
      postcondition: `hasRole(ARTIST_ROLE, old) == false on ${c.address}`,
      stopIf: "receipt status != 1",
    });
  }
  for (const c of OWNABLES.filter((r) => levels.includes(r.priority))) {
    add({
      phase: "ownership transfer (irreversible)", signer: OLD_AUTHORITY, signerKind: "EOA", to: c.address, contract: c.label,
      function: "transferOwnership(address)", args: { newOwner: safe || "SAFE_AUTHORITY (unresolved)" },
      ...encodeOrBlock(ownableIface, "transferOwnership", [safe], [["SAFE_AUTHORITY", safe]]),
      expected: "owner() becomes the Safe. SINGLE-STEP: cannot be undone; the Safe must already have executed on the live release.",
      postcondition: `owner() == SAFE on ${c.address}`,
      stopIf: "the Safe has not executed at least one transaction on 0x7Bba",
    });
  }
  return steps;
}

export function packageStatus(steps) {
  const blocked = steps.filter((s) => s.blockedOn?.length || !s.calldata);
  return blocked.length
    ? { status: "BLOCKED", blockedSteps: blocked.map((s) => s.step), blockedOn: [...new Set(blocked.flatMap((s) => s.blockedOn || []))] }
    : { status: "READY_FOR_OWNER_REVIEW" };
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const scope = process.env.SCOPE || "P0";
  const steps = buildRotationPlan({ safe: process.env.SAFE_AUTHORITY, backup: process.env.BACKUP_ADMIN, safeNonce: process.env.SAFE_NONCE, scope });
  console.log(JSON.stringify({ chainId: CHAIN_ID, oldAuthority: OLD_AUTHORITY, scope, unsigned: true, ...packageStatus(steps), preSteps: buildSaleCloseSteps(), steps, lockedOwnables: LOCKED_OWNABLES }, null, 2));
}

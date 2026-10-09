// Offline generator for the deployer-authority rotation package. It encodes
// calldata from the repository ABIs and prints an ordered, reviewable list of
// unsigned transactions. It has no RPC access, never signs and never broadcasts.
//
//   NEW_AUTHORITY=0x<owner-approved wallet or Safe> node scripts/authority-rotation-plan.mjs
//
// Without NEW_AUTHORITY it prints the address-independent transactions in full
// and the others as templates; it never invents a replacement address.
import { Interface, getAddress, id, isAddress, ZeroAddress } from "ethers";

export const OLD_AUTHORITY = "0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174";
export const CHAIN_ID = 43113;
export const ROLES = Object.freeze({
  DEFAULT_ADMIN_ROLE: `0x${"00".repeat(32)}`,
  ARTIST_ROLE: id("ARTIST_ROLE"),
  ISSUER_ROLE: id("ISSUER_ROLE"),
});

// VoidRelease1155 / VoidRelease1155V2: custom AccessControl (grantRole/revokeRole by
// DEFAULT_ADMIN_ROLE only; renounceRole(bytes32) self-only). VoidPrimarySale and
// VoidReleaseFactory: single-step transferOwnership(address).
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
  { address: "0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6", label: "Shared release V2 (live)", priority: "P0", roles: ["DEFAULT_ADMIN_ROLE", "ARTIST_ROLE", "ISSUER_ROLE"] },
  { address: "0x262B774cf9a1949170B58E2d57F6189980FE757b", label: "Release V1 (legacy certified)", priority: "P1", roles: ["DEFAULT_ADMIN_ROLE", "ARTIST_ROLE", "ISSUER_ROLE"] },
  { address: "0x82b26Da27136935454Bdf1e40801190B521b82e5", label: "Release (legacy marketplace token)", priority: "P1", roles: ["DEFAULT_ADMIN_ROLE", "ARTIST_ROLE", "ISSUER_ROLE"] },
  { address: "0x7A78F13Bef1a984676787Df1878F0C378b9dFc6e", label: "Release (superseded)", priority: "P2", roles: ["DEFAULT_ADMIN_ROLE", "ARTIST_ROLE", "ISSUER_ROLE"] },
]);
export const OWNABLES = Object.freeze([
  { address: "0x8291A4F1936C1c5C6D8917b0966c80757cd5c265", label: "VoidReleaseFactory V1 (unused)", priority: "P2", proofFeeBps: false },
]);
// Legacy VoidPrimarySale deployments built from source before commit 80c32af: the
// deployed bytecode has no transferOwnership(address) (live dispatcher check and
// eth_call simulation), so owner() stays OLD_AUTHORITY permanently. The only owner
// power is setPlatformFeeBps(x) with x <= platformFeeCapBps (500 = current fee):
// the old key can lower the platform fee, never raise it or redirect any payout.
export const LOCKED_OWNABLES = Object.freeze([
  { address: "0x51cCD2d5Cd71368917f1EFe3fa43Fab8068E1aBA", label: "Shared primary sale (live)", priority: "P0" },
  { address: "0xcc26cd6D6dc25654652D1FBB64dB5F61E20F60F1", label: "Primary sale for 0x82b26", priority: "P1" },
  { address: "0x7D1a068F532aD6c0f591d4Fb9F82fd5b97495363", label: "Primary sale for 0x7A78", priority: "P2" },
]);

export function validateNewAuthority(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (!isAddress(text)) throw new Error("NEW_AUTHORITY must be a 20-byte EVM address.");
  if (text !== text.toLowerCase() && getAddress(text) !== text) throw new Error("NEW_AUTHORITY has an invalid EIP-55 checksum.");
  const address = getAddress(text);
  if (address === ZeroAddress) throw new Error("NEW_AUTHORITY must not be the zero address.");
  if (address === getAddress(OLD_AUTHORITY)) throw new Error("NEW_AUTHORITY must differ from the authority being rotated out.");
  const known = [...RELEASES, ...OWNABLES, ...LOCKED_OWNABLES].map((c) => getAddress(c.address));
  if (known.includes(address)) throw new Error("NEW_AUTHORITY must not be one of the contracts being rotated.");
  return address;
}

const PLACEHOLDER = "<NEW_AUTHORITY>";
function encode(iface, fn, args, newAuthority) {
  const needsNew = args.some((a) => a === PLACEHOLDER);
  if (needsNew && !newAuthority) {
    const fragment = iface.getFunction(fn);
    return { calldata: null, calldataTemplate: `${fragment.selector}${args.map((a) => (a === PLACEHOLDER ? "<NEW_AUTHORITY left-padded to 32 bytes>" : String(a).replace(/^0x/, ""))).join("")}` };
  }
  return { calldata: iface.encodeFunctionData(fn, args.map((a) => (a === PLACEHOLDER ? newAuthority : a))) };
}

/**
 * Ordered plan. Invariants (unit-tested):
 *  - on each release the grant to the new authority comes first; the new authority's
 *    first action is revoking the old key's DEFAULT_ADMIN_ROLE (it proves control
 *    and ends the window in which a possibly-compromised old key could revoke the
 *    new authority or grant a third party), then ISSUER_ROLE, then ARTIST_ROLE;
 *  - no step ever revokes or renounces a role held by the new authority;
 *  - releases are rotated P0 first, and the single-step ownership transfer happens
 *    only after the live release is fully rotated, so the new address has already
 *    been proven controllable (an address mistake in transferOwnership is
 *    unrecoverable);
 *  - LOCKED_OWNABLES never appear: their bytecode cannot transfer ownership.
 */
export function buildRotationPlan({ newAuthority = null, scope = "P0" } = {}) {
  const levels = { P0: ["P0"], P1: ["P0", "P1"], ALL: ["P0", "P1", "P2"] }[scope];
  if (!levels) throw new Error("scope must be P0, P1 or ALL.");
  const releases = RELEASES.filter((c) => levels.includes(c.priority));
  const ownables = OWNABLES.filter((c) => levels.includes(c.priority));
  const steps = [];
  const signerNew = newAuthority || PLACEHOLDER;
  const add = (step) => steps.push({ step: steps.length + 1, chainId: CHAIN_ID, value: "0", ...step });
  const revoke = (c, role, note) => add({
    phase: role === "DEFAULT_ADMIN_ROLE" ? "release-admin-revoke (proof of control)" : "release-revoke",
    signer: signerNew, to: c.address, contract: c.label,
    function: "revokeRole(bytes32,address)", args: { role, account: OLD_AUTHORITY },
    ...encode(releaseIface, "revokeRole", [ROLES[role], OLD_AUTHORITY], newAuthority),
    expected: note,
    verify: `hasRole(${role}, ${OLD_AUTHORITY}) == false AND hasRole(DEFAULT_ADMIN_ROLE, ${signerNew}) == true on ${c.address}`,
  });

  for (const c of releases) {
    add({
      phase: "release-grant", signer: OLD_AUTHORITY, to: c.address, contract: c.label,
      function: "grantRole(bytes32,address)", args: { role: "DEFAULT_ADMIN_ROLE", account: signerNew },
      ...encode(releaseIface, "grantRole", [ROLES.DEFAULT_ADMIN_ROLE, PLACEHOLDER], newAuthority),
      expected: "New authority gains DEFAULT_ADMIN_ROLE. Old key keeps every role, so this step is fully recoverable.",
      verify: `hasRole(DEFAULT_ADMIN_ROLE, ${signerNew}) == true on ${c.address}`,
    });
    revoke(c, "DEFAULT_ADMIN_ROLE", "Old key loses DEFAULT_ADMIN_ROLE. First action signed by the new authority: success proves it can exercise DEFAULT_ADMIN_ROLE and closes the window in which a possibly-compromised old key could revoke it. Send immediately after step 'release-grant' is confirmed.");
    revoke(c, "ISSUER_ROLE", "Old key loses ISSUER_ROLE (direct mint).");
    revoke(c, "ARTIST_ROLE", "Old key loses ARTIST_ROLE (createEdition / configureSale for editions it created). Editions whose artistOf is the old key can no longer have their sale reconfigured.");
  }
  for (const c of ownables) {
    add({
      phase: "ownership-transfer", signer: OLD_AUTHORITY, to: c.address, contract: c.label,
      function: "transferOwnership(address)", args: { newOwner: signerNew },
      ...encode(ownableIface, "transferOwnership", [PLACEHOLDER], newAuthority),
      expected: "owner() becomes the new authority. SINGLE-STEP: cannot be undone by the old key; the new authority must already be proven on the live release.",
      verify: `owner() == ${signerNew} on ${c.address}`,
    });
    if (c.proofFeeBps) {
      add({
        phase: "ownership-proof (optional)", signer: signerNew, to: c.address, contract: c.label,
        function: "setPlatformFeeBps(uint256)", args: { nextBps: "<current platformFeeBps(), read immediately before signing>" },
        calldata: null, calldataTemplate: `${ownableIface.getFunction("setPlatformFeeBps").selector}<current platformFeeBps as uint256>`,
        expected: "No economic change (same value); emits PlatformFeeUpdated(x, x) proving the new owner can act.",
        verify: "platformFeeBps() unchanged; PlatformFeeUpdated log emitted from the new owner",
      });
    }
  }
  return steps;
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const newAuthority = validateNewAuthority(process.env.NEW_AUTHORITY);
  const scope = process.env.SCOPE || "ALL";
  console.log(JSON.stringify({ chainId: CHAIN_ID, oldAuthority: OLD_AUTHORITY, newAuthority, scope, unsigned: true, steps: buildRotationPlan({ newAuthority, scope }) }, null, 2));
}

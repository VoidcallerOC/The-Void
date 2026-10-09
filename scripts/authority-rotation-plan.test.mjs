import { describe, expect, it } from "vitest";
import { getAddress, id } from "ethers";
import {
  ARTIST_WALLET_0x284C, LEGACY_RELEASE_82B26, LOCKED_OWNABLES, OLD_AUTHORITY, OPEN_OLD_KEY_SALES, OWNABLES, RELEASES, ROLES,
  buildRotationPlan, buildSaleCloseSteps, ownableIface, packageStatus, releaseIface, safeTxHash, saleIface, validateAuthorities,
} from "./authority-rotation-plan.mjs";

// Deterministic test-only addresses; NOT proposed authorities.
const SAFE = getAddress("0x00000000000000000000000000000000000000a1");
const BACKUP = getAddress("0x00000000000000000000000000000000000000b2");
const full = (scope = "ALL") => buildRotationPlan({ safe: SAFE, backup: BACKUP, safeNonce: 0, scope });

describe("authority rotation plan", () => {
  it("uses the standard selectors and role hashes", () => {
    expect(releaseIface.getFunction("grantRole").selector).toBe("0x2f2ff15d");
    expect(releaseIface.getFunction("revokeRole").selector).toBe("0xd547741f");
    expect(ownableIface.getFunction("transferOwnership").selector).toBe("0xf2fde38b");
    expect(ROLES.ISSUER_ROLE).toBe(id("ISSUER_ROLE"));
    expect(ROLES.ARTIST_ROLE).toBe(id("ARTIST_ROLE"));
    expect(ROLES.DEFAULT_ADMIN_ROLE).toBe(`0x${"00".repeat(32)}`);
  });

  it("rejects unsafe or non-independent authorities", () => {
    expect(validateAuthorities({})).toEqual({ safe: null, backup: null });
    expect(() => validateAuthorities({ safe: "0x0000000000000000000000000000000000000000" })).toThrow(/zero/);
    expect(() => validateAuthorities({ safe: OLD_AUTHORITY })).toThrow(/differ/);
    expect(() => validateAuthorities({ backup: ARTIST_WALLET_0x284C })).toThrow(/0x284C/);
    expect(() => validateAuthorities({ safe: LOCKED_OWNABLES[0].address })).toThrow(/contracts being rotated/);
    expect(() => validateAuthorities({ safe: "0xaBd3746e8b852f55bE52FC44faB6cAb908b1c17A" })).toThrow();
    expect(() => validateAuthorities({ safe: SAFE, backup: SAFE })).toThrow(/independent/);
    expect(() => validateAuthorities({ backup: "not-an-address" })).toThrow(/20-byte/);
  });

  it("never encodes placeholder bytes: unresolved addresses block the package", () => {
    const steps = buildRotationPlan({ scope: "ALL" });
    expect(packageStatus(steps).status).toBe("BLOCKED");
    expect(packageStatus(steps).blockedOn.sort()).toEqual(["BACKUP_ADMIN", "SAFE_AUTHORITY", "SAFE_NONCE"]);
    for (const step of steps) {
      if (step.calldata) expect(step.calldata).toMatch(/^0x[0-9a-f]+$/);
      if (step.function.startsWith("grantRole") || step.function.startsWith("transferOwnership")) expect(step.calldata).toBeNull();
    }
    // A Safe address without its nonce still blocks the Safe steps (no hash to compare).
    expect(packageStatus(buildRotationPlan({ safe: SAFE, backup: BACKUP, scope: "P0" })).blockedOn).toEqual(["SAFE_NONCE"]);
    expect(packageStatus(full("P0")).status).toBe("READY_FOR_OWNER_REVIEW");
  });

  it("encodes calldata that decodes back to exactly the declared call", () => {
    for (const step of full()) {
      const iface = step.function.startsWith("transferOwnership") ? ownableIface : releaseIface;
      const parsed = iface.parseTransaction({ data: step.calldata });
      expect(`${parsed.name}(${parsed.fragment.inputs.map((i) => i.type).join(",")})`).toBe(step.function);
      if (parsed.name === "grantRole") expect([parsed.args[0], parsed.args[1]]).toEqual([ROLES[step.args.role], step.args.account]);
      if (parsed.name === "revokeRole") expect([parsed.args[0], parsed.args[1]]).toEqual([ROLES[step.args.role], getAddress(OLD_AUTHORITY)]);
      if (parsed.name === "transferOwnership") expect(parsed.args[0]).toBe(SAFE);
      expect(step.chainId).toBe(43113);
      expect(step.value).toBe("0");
    }
  });

  it("per release: grant Safe, grant backup, backup proof, Safe removes old admin, Safe revokes artist", () => {
    const steps = full();
    for (const release of RELEASES) {
      const own = steps.filter((s) => s.to === release.address);
      expect(own.map((s) => [s.signer === SAFE ? "safe" : s.signer === BACKUP ? "backup" : "old", s.function.split("(")[0], s.args.role, s.args.account])).toEqual([
        ["old", "grantRole", "DEFAULT_ADMIN_ROLE", SAFE],
        ["old", "grantRole", "DEFAULT_ADMIN_ROLE", BACKUP],
        ["backup", "revokeRole", "ISSUER_ROLE", OLD_AUTHORITY],
        ["safe", "revokeRole", "DEFAULT_ADMIN_ROLE", OLD_AUTHORITY],
        ["safe", "revokeRole", "ARTIST_ROLE", OLD_AUTHORITY],
      ]);
    }
  });

  it("removes the old admin only after both new admins are granted and the backup has acted (no lockout path)", () => {
    const steps = full();
    for (const release of RELEASES) {
      const own = steps.filter((s) => s.to === release.address);
      const removal = own.find((s) => s.args.role === "DEFAULT_ADMIN_ROLE" && s.function.startsWith("revokeRole"));
      expect(removal.signer).toBe(SAFE);
      const before = own.filter((s) => s.step < removal.step);
      expect(before.some((s) => s.function.startsWith("grantRole") && s.args.account === SAFE)).toBe(true);
      expect(before.some((s) => s.function.startsWith("grantRole") && s.args.account === BACKUP)).toBe(true);
      expect(before.some((s) => s.signer === BACKUP)).toBe(true);
    }
    for (const step of steps) {
      expect(step.function.startsWith("renounceRole")).toBe(false);
      if (step.function.startsWith("revokeRole")) expect(step.args.account).toBe(OLD_AUTHORITY);
    }
  });

  it("Safe steps are plain CALLs with sequential nonces and a reproducible EIP-712 hash", () => {
    const safeSteps = full().filter((s) => s.signer === SAFE);
    expect(safeSteps.map((s) => s.safeTx.nonce)).toEqual(safeSteps.map((_, i) => String(i)));
    for (const s of safeSteps) {
      expect(s.safeTx).toMatchObject({ to: s.to, value: "0", data: s.calldata, operation: 0, gasPrice: "0", gasToken: "0x0000000000000000000000000000000000000000", refundReceiver: "0x0000000000000000000000000000000000000000" });
      expect(s.safeTxHash).toBe(safeTxHash({ safe: SAFE, tx: s.safeTx }));
      expect(s.safeTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });

  it("scopes P0 to the live release and transfers factory ownership only to the Safe, last", () => {
    expect([...new Set(full("P0").map((s) => s.to))]).toEqual(["0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6"]);
    expect(full("P0")).toHaveLength(5);
    const all = full();
    expect(all).toHaveLength(RELEASES.length * 5 + OWNABLES.length);
    expect(all.at(-1)).toMatchObject({ to: OWNABLES[0].address, function: "transferOwnership(address)", args: { newOwner: SAFE } });
    const locked = new Set(LOCKED_OWNABLES.map((c) => c.address));
    expect(all.filter((s) => locked.has(s.to))).toEqual([]);
  });

  it("encodes the sale-close pre-steps with unchanged parameters, paused = true, before the 0x82b26 artist revoke", () => {
    const pre = buildSaleCloseSteps();
    expect(pre.map((s) => s.step)).toEqual(["P-1", "P-2"]);
    pre.forEach((step, i) => {
      const parsed = saleIface.parseTransaction({ data: step.calldata });
      const e = OPEN_OLD_KEY_SALES[i];
      expect(parsed.args.map(String)).toEqual([e.tokenId, e.priceWei, e.maxSupply, e.perWalletLimit, e.startTime, e.endTime, "true"]);
      expect(step.signer).toBe(OLD_AUTHORITY);
    });
    // Live simulation (run 37911342571) produced exactly this calldata for P-1.
    expect(pre[0].calldata.slice(0, 74)).toBe("0x23a126174aae1ffba437e9e91d04ea8032dfa64a3e8ed673475793a65bea7c266cf12563");
    const artistRevoke = full().find((s) => s.to === LEGACY_RELEASE_82B26 && s.args.role === "ARTIST_ROLE");
    expect(artistRevoke.requiresCompleted).toEqual(["P-1", "P-2"]);
  });
});

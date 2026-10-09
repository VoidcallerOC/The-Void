import { describe, expect, it } from "vitest";
import { getAddress, id } from "ethers";
import { OLD_AUTHORITY, OWNABLES, RELEASES, ROLES, buildRotationPlan, ownableIface, releaseIface, validateNewAuthority } from "./authority-rotation-plan.mjs";

// Deterministic test-only address; NOT a proposed replacement authority.
const NEW = getAddress("0x00000000000000000000000000000000000000a1");

describe("authority rotation plan", () => {
  it("uses the standard selectors and role hashes", () => {
    expect(releaseIface.getFunction("grantRole").selector).toBe("0x2f2ff15d");
    expect(releaseIface.getFunction("revokeRole").selector).toBe("0xd547741f");
    expect(ownableIface.getFunction("transferOwnership").selector).toBe("0xf2fde38b");
    expect(ROLES.ISSUER_ROLE).toBe(id("ISSUER_ROLE"));
    expect(ROLES.ARTIST_ROLE).toBe(id("ARTIST_ROLE"));
    expect(ROLES.DEFAULT_ADMIN_ROLE).toBe(`0x${"00".repeat(32)}`);
  });

  it("rejects unsafe replacement addresses and never invents one", () => {
    expect(validateNewAuthority("")).toBeNull();
    expect(() => validateNewAuthority("0x0000000000000000000000000000000000000000")).toThrow(/zero/);
    expect(() => validateNewAuthority(OLD_AUTHORITY)).toThrow(/differ/);
    expect(() => validateNewAuthority(OWNABLES[0].address)).toThrow(/contracts being rotated/);
    expect(() => validateNewAuthority("0xaBd3746e8b852f55bE52FC44faB6cAb908b1c17A")).toThrow();
    expect(() => validateNewAuthority("not-an-address")).toThrow(/20-byte/);
    const templates = buildRotationPlan({ scope: "ALL" });
    for (const step of templates) {
      const needsNew = step.function.startsWith("grantRole") || step.function.startsWith("transferOwnership") || step.signer === "<NEW_AUTHORITY>";
      if (step.function.startsWith("grantRole") || step.function.startsWith("transferOwnership")) expect(step.calldata).toBeNull();
      expect(needsNew || step.signer === OLD_AUTHORITY).toBe(true);
    }
  });

  it("encodes calldata that decodes back to exactly the declared call", () => {
    for (const step of buildRotationPlan({ newAuthority: NEW, scope: "ALL" }).filter((s) => s.calldata)) {
      const iface = step.function.startsWith("transferOwnership") ? ownableIface : releaseIface;
      const parsed = iface.parseTransaction({ data: step.calldata });
      expect(`${parsed.name}(${parsed.fragment.inputs.map((i) => i.type).join(",")})`).toBe(step.function);
      if (parsed.name === "grantRole") expect([parsed.args[0], parsed.args[1]]).toEqual([ROLES[step.args.role], NEW]);
      if (parsed.name === "revokeRole") expect([parsed.args[0], parsed.args[1]]).toEqual([ROLES[step.args.role], getAddress(OLD_AUTHORITY)]);
      if (parsed.name === "transferOwnership") expect(parsed.args[0]).toBe(NEW);
      expect(step.chainId).toBe(43113);
      expect(step.value).toBe("0");
    }
  });

  it("orders each release grant -> ISSUER revoke (proof) -> ADMIN revoke -> ARTIST revoke", () => {
    const steps = buildRotationPlan({ newAuthority: NEW, scope: "ALL" });
    for (const release of RELEASES) {
      const own = steps.filter((s) => s.to === release.address);
      expect(own.map((s) => [s.signer === NEW ? "new" : "old", s.function.split("(")[0], s.args.role])).toEqual([
        ["old", "grantRole", "DEFAULT_ADMIN_ROLE"],
        ["new", "revokeRole", "ISSUER_ROLE"],
        ["new", "revokeRole", "DEFAULT_ADMIN_ROLE"],
        ["new", "revokeRole", "ARTIST_ROLE"],
      ]);
    }
  });

  it("rotates the live P0 release first and transfers ownership only after it is fully rotated", () => {
    const steps = buildRotationPlan({ newAuthority: NEW, scope: "ALL" });
    expect(steps[0].to).toBe(RELEASES[0].address);
    const liveDone = Math.max(...steps.filter((s) => s.to === RELEASES[0].address).map((s) => s.step));
    for (const s of steps.filter((x) => x.function.startsWith("transferOwnership"))) expect(s.step).toBeGreaterThan(liveDone);
    expect(steps.find((s) => s.function.startsWith("transferOwnership")).to).toBe(OWNABLES[0].address);
  });

  it("scopes the package to P0 when requested", () => {
    const targets = new Set(buildRotationPlan({ newAuthority: NEW, scope: "P0" }).map((s) => s.to));
    expect([...targets]).toEqual(["0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6", "0x51cCD2d5Cd71368917f1EFe3fa43Fab8068E1aBA"]);
  });
});

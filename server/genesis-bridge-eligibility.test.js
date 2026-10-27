import { describe, expect, it } from "vitest";
import { bridgeEligibilityEnabled, checkBridgeEligibility, GROTTO_CHAIN_ID, SOURCE_BRIDGE, REMOTE_BRIDGE } from "./genesis-bridge-eligibility.js";

describe("Grotto bridge eligibility", () => {
  it("is disabled by default", () => {
    expect(bridgeEligibilityEnabled({})).toBe(false);
    expect(GROTTO_CHAIN_ID).toBe(36463);
    expect(SOURCE_BRIDGE.toLowerCase()).toBe("0x68539f95fb2758327a9c7ededa1002b0f3ec8992");
    expect(REMOTE_BRIDGE.toLowerCase()).toBe("0x0d6fa9968aa57295217737379c44ebbc1130b1fa");
  });

  it("fails closed when disabled", async () => {
    const result = await checkBridgeEligibility({ wallet: "0x0000000000000000000000000000000000000001", env: {} });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("BRIDGE_DISABLED");
  });

  it("fails closed even when flag is set without providers", async () => {
    const result = await checkBridgeEligibility({ wallet: "0x0000000000000000000000000000000000000001", env: { GENESIS_BRIDGE_ELIGIBILITY: "true" } });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("PROVIDERS_MISSING");
  });
});

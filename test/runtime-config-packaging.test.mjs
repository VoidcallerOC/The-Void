import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

describe("runtime config packaging", () => {
  it("copies the authoritative Fuji config into /app/config", async () => {
    const dockerfile = await readFile(resolve(root, "Dockerfile"), "utf8");
    const config = JSON.parse(await readFile(resolve(root, "config/fuji-release.json"), "utf8"));
    expect(dockerfile).toContain("COPY config ./config");
    expect(config).toMatchObject({ networkName: "Avalanche Fuji", chainId: 43113, contractType: "ERC1155" });
    expect(config.contractAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    if (config.contractName === "VoidRelease1155V2") {
      expect(config.contractAddress).not.toBe("0x0000000000000000000000000000000000000000");
      expect(config.primarySaleAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(config.primarySaleAddress).not.toBe("0x0000000000000000000000000000000000000000");
      if (process.env.EXPECTED_FUJI_V2_RELEASE_ADDRESS) expect(config.contractAddress.toLowerCase()).toBe(process.env.EXPECTED_FUJI_V2_RELEASE_ADDRESS.toLowerCase());
    } else {
      expect(config.contractName).toBe("VoidRelease1155");
      expect(config.contractAddress).toBe("0x262B774cf9a1949170B58E2d57F6189980FE757b");
    }
  });
});

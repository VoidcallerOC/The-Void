import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

describe("runtime config packaging", () => {
  it("copies the authoritative Fuji config into /app/config", async () => {
    const dockerfile = await readFile(resolve(root, "Dockerfile"), "utf8");
    const config = JSON.parse(await readFile(resolve(root, "config/fuji-release.json"), "utf8"));
    expect(dockerfile).toContain("COPY config ./config");
    expect(config).toMatchObject({ networkName: "Avalanche Fuji", chainId: 43113, contractName: "VoidRelease1155", contractAddress: "0x262B774cf9a1949170B58E2d57F6189980FE757b" });
  });
});

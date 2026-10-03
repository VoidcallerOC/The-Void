import { describe, expect, it } from "vitest";
import { ethers } from "ethers";
import { FUJI_RELEASE_CONFIG, explainFujiEditionError, simulateFujiCall } from "./fuji-release.js";

const errors = new ethers.Interface(["error ExceedsSupply(uint256 tokenId, uint256 available, uint256 requested)", "error EditionNotFound(uint256 tokenId)"]);

function provider(callError) {
  return {
    request: async ({ method }) => {
      if (method === "eth_chainId") return FUJI_RELEASE_CONFIG.chainHexId;
      if (method === "eth_call") { if (callError) throw callError; return "0x"; }
      throw new Error(`unexpected ${method}`);
    },
  };
}

describe("mint revert explanations", () => {
  it("names supply and missing-edition reverts", () => {
    expect(explainFujiEditionError({ data: errors.encodeErrorResult("ExceedsSupply", [1n, 0n, 1n]) })).toMatchObject({ code: "ExceedsSupply", message: "Mint exceeds the edition's remaining supply (0 left)." });
    expect(explainFujiEditionError({ data: errors.encodeErrorResult("EditionNotFound", [1n]) }).message).toMatch(/does not exist on Fuji/);
  });

  it("stops a mint before broadcast when the dry run reverts", async () => {
    const from = "0x284c09a7cc187e096cbbdc88d99defe6df32180a";
    await expect(simulateFujiCall(provider(null), { from, data: "0x" })).resolves.toBeUndefined();
    await expect(simulateFujiCall(provider({ data: errors.encodeErrorResult("EditionNotFound", [1n]) }), { from, data: "0x" })).rejects.toMatchObject({ code: "EditionNotFound" });
    await expect(simulateFujiCall(provider(new Error("execution reverted")), { from, data: "0x" })).rejects.toThrow(/would revert on Fuji/);
  });
});

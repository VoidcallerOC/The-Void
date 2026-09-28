import { describe, expect, it } from "vitest";
import { extractForgeJson } from "./deploy-marketplace-output.mjs";

describe("extractForgeJson", () => {
  it("extracts deployment JSON after compiler and human-readable Forge output", () => {
    const output = [
      "Compiling 1 files with Solc 0.8.30",
      "Compiler run successful!",
      'Transaction: {"from":"0xabc","to":null,"nonce":"0x20"}',
      "ABI: []",
      JSON.stringify({ deployedTo: "0xDeployed", transactionHash: "0xTransaction", blockNumber: 123 }),
    ].join("\n");

    expect(extractForgeJson(output)).toEqual({
      deployedTo: "0xDeployed",
      transactionHash: "0xTransaction",
      blockNumber: 123,
    });
  });

  it("fails closed when no deployment result is present", () => {
    expect(() => extractForgeJson("Compiling 1 files with Solc 0.8.30\nCompiler run successful!"))
      .toThrow("Forge did not return a parseable deployment result.");
  });
});

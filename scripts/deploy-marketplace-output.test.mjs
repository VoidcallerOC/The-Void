import { describe, expect, it } from "vitest";
import { extractForgeJson } from "./deploy-marketplace-output.mjs";

describe("extractForgeJson", () => {
  it("does not mistake Forge's PTY dry-run transcript for a deployment result", () => {
    const output = [
      "0x1111111111111111111111111111111111111111111111111111111111111111\r",
      "\r3[2K\r\u001b[1m[\u001b[32m\u2838\u001b[0m]\u001b[0m Compiling...\r",
      "Enter private key:\u001b[1m\u001b[33mWarning\u001b[0m: Dry run enabled, not broadcasting transaction\r\n",
      "Contract: MusicMarketplace\r\n",
      `Transaction: ${JSON.stringify({ from: "0xabc", to: null, nonce: "0x0" })}\r\n`,
      "ABI: []\r\n",
      "\u001b[1m\u001b[33mWarning\u001b[0m: To broadcast this transaction, add --broadcast\r\n",
    ].join("");

    expect(() => extractForgeJson(output)).toThrow("Forge did not return a parseable deployment result.");
  });

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

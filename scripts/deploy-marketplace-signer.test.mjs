import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildForgeCreateArgs,
  buildForgeEnvironment,
  hashDeploymentBytecode,
  resolveMarketplaceConfig,
  runForgeCreate,
  runMarketplaceDeployment,
  verifyForgeDeployment,
} from "./deploy-marketplace.mjs";

const execFileAsync = promisify(execFile);
const TRANSACTION_HASH = `0x${"ab".repeat(32)}`;
const FEE_RECIPIENT = "0x284c09a7cc187e096cbbdc88d99defe6df32180a";
const DEPLOYED_CONTRACT_ADDRESS = `0x${"cd".repeat(20)}`;
const PRIVATE_KEY_SENTINEL = `0x${"11".repeat(32)}`;
const RPC_URL_SENTINEL = "https://rpc.example.invalid/fuji?token=TEST_ONLY_RPC_SENTINEL";
const FUJI_CANONICAL_TOKEN = "0x82b26da27136935454bdf1e40801190b521b82e5";
const CCHAIN_CANONICAL_TOKEN = "0x1111111111111111111111111111111111111111";

function makeEnv(overrides = {}) {
  return {
    PATH: process.env.PATH || "/usr/bin",
    HOME: process.env.HOME || "/home/node",
    AVALANCHE_FUJI_RPC_URL: RPC_URL_SENTINEL,
    DEPLOYER_PRIVATE_KEY: PRIVATE_KEY_SENTINEL,
    MARKETPLACE_FEE_RECIPIENT: FEE_RECIPIENT,
    MARKETPLACE_FEE_BPS: "250",
    FUJI_CANONICAL_TOKEN,
    CCHAIN_CANONICAL_TOKEN,
    ...overrides,
  };
}

async function makeDeploymentFixture() {
  const cwd = await mkdtemp(join(tmpdir(), "marketplace-signer-test-"));
  const bytecodePath = join(cwd, "out", "MusicMarketplace.sol", "MusicMarketplace.json");
  await mkdir(join(cwd, "out", "MusicMarketplace.sol"), { recursive: true });
  await writeFile(bytecodePath, JSON.stringify({ bytecode: { object: "0x60006000" } }));
  return { cwd, bytecodePath };
}

const goodReceipt = (overrides = {}) => ({
  status: 1,
  blockNumber: 456,
  transactionHash: TRANSACTION_HASH,
  contractAddress: DEPLOYED_CONTRACT_ADDRESS,
  ...overrides,
});

const goodForgeOutput = (overrides = {}) => ({
  deployedTo: DEPLOYED_CONTRACT_ADDRESS,
  transactionHash: TRANSACTION_HASH,
  ...overrides,
});

describe("marketplace deployment signer hardening", () => {
  it("uses Render's existing wallet through the hidden Forge prompt, not argv or child env", async () => {
    const fixture = await makeDeploymentFixture();
    let observedCall;
    let capturedInput;
    class FakeProvider {
      constructor(url, chainId, options) {
        expect(url).toBe(RPC_URL_SENTINEL);
        expect(chainId).toBe(43113);
        expect(options).toEqual({ staticNetwork: true });
      }

      async waitForTransaction(hash, confirmations, timeout) {
        expect(hash).toBe(TRANSACTION_HASH);
        expect(confirmations).toBe(1);
        expect(timeout).toBe(60_000);
        return goodReceipt();
      }
    }

    try {
      const record = await runMarketplaceDeployment({
        env: makeEnv({
          DEPLOYER_KEYSTORE_PATH: undefined,
          DEPLOYER_KEYSTORE_PASSWORD_FILE: undefined,
        }),
        cwd: fixture.cwd,
        Provider: FakeProvider,
        execute: async (args, options) => {
          observedCall = { args: [...args], options };
          capturedInput = Buffer.from(options.input);
          return {
            stdout: [
              "Compiling 1 files with Solc 0.8.24",
              JSON.stringify(goodForgeOutput({ blockNumber: 456 })),
            ].join("\n"),
            stderr: "",
          };
        },
      });

      expect(observedCall.args).toContain("--interactive");
      expect(observedCall.args).toContain("--chain");
      expect(observedCall.args).toContain("43113");
      expect(observedCall.args).toContain("--broadcast");
      expect(observedCall.args).toContain("--json");
      expect(observedCall.args.indexOf("--broadcast")).toBeLessThan(observedCall.args.indexOf("--constructor-args"));
      expect(observedCall.args.indexOf("--json")).toBeLessThan(observedCall.args.indexOf("--constructor-args"));
      expect(observedCall.args).toContain(FEE_RECIPIENT);
      expect(observedCall.args).toContain("250");
      expect(observedCall.args).toContain(FUJI_CANONICAL_TOKEN);
      expect(observedCall.args).not.toContain("--private-key");
      expect(observedCall.args).not.toContain("--keystore");
      expect(observedCall.args).not.toContain("--password-file");
      expect(observedCall.args.join(" ")).not.toContain(PRIVATE_KEY_SENTINEL);
      expect(observedCall.args.join(" ")).not.toContain(RPC_URL_SENTINEL);
      expect(capturedInput.toString("utf8")).toBe(`${PRIVATE_KEY_SENTINEL}\n`);
      expect(observedCall.options.env.DEPLOYER_PRIVATE_KEY).toBeUndefined();
      expect(observedCall.options.env.DEPLOYER_KEYSTORE_PATH).toBeUndefined();
      expect(observedCall.options.env.DEPLOYER_KEYSTORE_PASSWORD_FILE).toBeUndefined();
      expect(observedCall.options.env.ETH_PASSWORD).toBeUndefined();
      expect(observedCall.options.env.ETH_RPC_URL).toBe(RPC_URL_SENTINEL);
      expect(observedCall.options.cwd).toBe(fixture.cwd);
      expect([...observedCall.options.input].every((byte) => byte === 0)).toBe(true);

      expect(record).toMatchObject({
        network: "fuji",
        chainId: 43113,
        contractAddress: DEPLOYED_CONTRACT_ADDRESS,
        deploymentTransaction: TRANSACTION_HASH,
        deploymentBlock: 456,
        feeRecipient: FEE_RECIPIENT,
        feeBasisPoints: 250,
        sourceVerificationStatus: "NOT_REQUESTED",
      });
      expect(record.bytecodeHash).toMatch(/^0x[0-9a-f]{64}$/);

      const artifact = await readFile(join(fixture.cwd, "deployments", "marketplace-fuji.json"), "utf8");
      expect(artifact).not.toContain(PRIVATE_KEY_SENTINEL);
      expect(artifact).not.toContain(RPC_URL_SENTINEL);
    } finally {
      capturedInput?.fill(0);
      await rm(fixture.cwd, { recursive: true, force: true });
    }
  });

  it("uses a TTY prompt without putting the key in Forge or script argv, and suppresses key-bearing output", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "marketplace-pty-test-"));
    const fakeBin = join(fixture, "bin");
    await mkdir(fakeBin, { recursive: true });
    const forgeArgsPath = join(fixture, "forge-args.txt");
    const scriptArgsPath = join(fixture, "script-args.txt");
    const receivedKeyPath = join(fixture, "received-test-key.txt");
    const forgeStatePath = join(fixture, "forge-state.txt");
    const fakeScriptPath = join(fakeBin, "script");
    const fakeForgePath = join(fakeBin, "forge");

    try {
      await writeFile(fakeScriptPath, [
        "#!/bin/sh",
        'printf \'%s\\n\' "$@" > "$SCRIPT_ARGS_CAPTURE"',
        'exec /usr/bin/script "$@"',
        "",
      ].join("\n"), { mode: 0o755 });
      await chmod(fakeScriptPath, 0o755);

      await writeFile(fakeForgePath, [
        "#!/bin/sh",
        'printf \'%s\\n\' "$@" > "$FORGE_ARGS_CAPTURE"',
        'if [ -t 0 ]; then printf "tty=yes\\n" > "$FORGE_STATE_CAPTURE"; else printf "tty=no\\n" > "$FORGE_STATE_CAPTURE"; fi',
        'if [ "${DEPLOYER_PRIVATE_KEY+x}" = x ]; then printf "key-env=present\\n" >> "$FORGE_STATE_CAPTURE"; else printf "key-env=absent\\n" >> "$FORGE_STATE_CAPTURE"; fi',
        "stty -echo",
        "IFS= read -r received_key",
        "stty echo",
        'printf \'%s\' "$received_key" > "$FORGE_KEY_CAPTURE"',
        'printf \'%s\\n\' "$received_key"',
        'printf \'%s\\n\' "$received_key" >&2',
        "exit 23",
        "",
      ].join("\n"), { mode: 0o755 });
      await chmod(fakeForgePath, 0o755);

      let runError;
      try {
        await execFileAsync(process.execPath, [join(process.cwd(), "scripts", "deploy-marketplace.mjs")], {
          cwd: process.cwd(),
          env: makeEnv({
            PATH: `${fakeBin}:${process.env.PATH || "/usr/bin"}`,
            SCRIPT_ARGS_CAPTURE: scriptArgsPath,
            FORGE_ARGS_CAPTURE: forgeArgsPath,
            FORGE_KEY_CAPTURE: receivedKeyPath,
            FORGE_STATE_CAPTURE: forgeStatePath,
          }),
          maxBuffer: 1024 * 1024,
        });
      } catch (error) {
        runError = error;
      }

      expect(runError).toBeDefined();
      expect(runError.stderr).toContain("Forge create failed; sensitive process output was suppressed.");
      expect(runError.stdout).not.toContain(PRIVATE_KEY_SENTINEL);
      expect(runError.stderr).not.toContain(PRIVATE_KEY_SENTINEL);

      const scriptArgs = await readFile(scriptArgsPath, "utf8");
      const forgeArgs = await readFile(forgeArgsPath, "utf8");
      const forgeState = await readFile(forgeStatePath, "utf8");
      const receivedKey = await readFile(receivedKeyPath, "utf8");
      expect(scriptArgs).toContain("--interactive");
      expect(scriptArgs).not.toContain(PRIVATE_KEY_SENTINEL);
      expect(forgeArgs).toContain("--interactive");
      expect(forgeArgs).not.toContain("--private-key");
      expect(forgeArgs).not.toContain("--keystore");
      expect(forgeArgs).not.toContain("--password-file");
      expect(forgeArgs).not.toContain(PRIVATE_KEY_SENTINEL);
      expect(forgeState).toContain("tty=yes");
      expect(forgeState).toContain("key-env=absent");
      expect(receivedKey).toBe(PRIVATE_KEY_SENTINEL);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("fails closed when the existing Render wallet credential is missing or malformed", async () => {
    const execute = vi.fn();
    await expect(runMarketplaceDeployment({ env: makeEnv({ DEPLOYER_PRIVATE_KEY: undefined }), execute }))
      .rejects.toThrow("A valid DEPLOYER_PRIVATE_KEY environment credential is required.");
    await expect(runMarketplaceDeployment({ env: makeEnv({ DEPLOYER_PRIVATE_KEY: "not-a-key" }), execute }))
      .rejects.toThrow("A valid DEPLOYER_PRIVATE_KEY environment credential is required.");
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not expose child-process output or errors on Forge failure and clears the input buffer", async () => {
    const env = makeEnv();
    const config = resolveMarketplaceConfig(env);
    const sensitiveError = Object.assign(new Error(PRIVATE_KEY_SENTINEL), {
      stdout: PRIVATE_KEY_SENTINEL,
      stderr: PRIVATE_KEY_SENTINEL,
    });
    const privateKeyInput = Buffer.from(`${PRIVATE_KEY_SENTINEL}\n`);

    await expect(runForgeCreate(async () => { throw sensitiveError; }, config, env, privateKeyInput))
      .rejects.toThrow("Forge create failed; sensitive process output was suppressed.");
    expect([...privateKeyInput].every((byte) => byte === 0)).toBe(true);
  });

  it("keeps Fuji at chain 43113, preserves fee settings, and retains the explicit mainnet confirmation gate", () => {
    expect(resolveMarketplaceConfig(makeEnv())).toMatchObject({
      network: "fuji",
      chainId: 43113,
      feeRecipient: FEE_RECIPIENT,
      feeBps: 250,
    });
    expect(() => resolveMarketplaceConfig(makeEnv({
      DEPLOY_NETWORK: "mainnet",
      AVALANCHE_CCHAIN_RPC_URL: "https://mainnet.rpc.example.invalid",
    }))).toThrow("Mainnet deployment requires CONFIRM_MAINNET_DEPLOY=yes.");
    expect(resolveMarketplaceConfig(makeEnv({
      DEPLOY_NETWORK: "mainnet",
      AVALANCHE_CCHAIN_RPC_URL: "https://mainnet.rpc.example.invalid",
      CCHAIN_CANONICAL_TOKEN,
      CONFIRM_MAINNET_DEPLOY: "yes",
    }))).toMatchObject({ network: "mainnet", chainId: 43114, canonicalToken: CCHAIN_CANONICAL_TOKEN });
    expect(() => resolveMarketplaceConfig(makeEnv({ FUJI_CANONICAL_TOKEN: CCHAIN_CANONICAL_TOKEN })))
      .toThrow("Fuji canonical token must be 0x82b26Da27136935454Bdf1e40801190B521b82e5.");
  });

  it("preserves fail-closed transaction, receipt, contract, and deployment-block checks", () => {
    expect(verifyForgeDeployment(goodForgeOutput(), goodReceipt())).toEqual({
      transactionHash: TRANSACTION_HASH,
      contractAddress: DEPLOYED_CONTRACT_ADDRESS,
      deploymentBlock: 456,
    });
    expect(() => verifyForgeDeployment(goodForgeOutput({ transactionHash: "not-a-hash" }), goodReceipt()))
      .toThrow("Deployment output did not include a valid transaction hash.");
    expect(() => verifyForgeDeployment(goodForgeOutput({ deployedTo: "not-an-address" }), goodReceipt()))
      .toThrow("Deployment output did not include a valid contract address.");
    expect(() => verifyForgeDeployment(goodForgeOutput(), null))
      .toThrow("A successful mined transaction receipt with a deployment block was not available.");
    expect(() => verifyForgeDeployment(goodForgeOutput(), goodReceipt({ status: 0 })))
      .toThrow("A successful mined transaction receipt with a deployment block was not available.");
    expect(() => verifyForgeDeployment(goodForgeOutput(), goodReceipt({ blockNumber: null })))
      .toThrow("A successful mined transaction receipt with a deployment block was not available.");
  });

  it("computes a SHA-256 bytecode hash and rejects malformed bytecode", () => {
    const expected = `0x${createHash("sha256").update(Buffer.from("60006000", "hex")).digest("hex")}`;
    expect(hashDeploymentBytecode("0x60006000")).toBe(expected);
    expect(() => hashDeploymentBytecode("0xabc"))
      .toThrow("Deployment bytecode artifact did not contain valid bytecode.");
    expect(() => hashDeploymentBytecode("0xzz00"))
      .toThrow("Deployment bytecode artifact did not contain valid bytecode.");
  });

  it("strips the existing wallet and obsolete signer variables from Forge's environment", () => {
    const env = makeEnv({
      ETH_PASSWORD: "TEST_ONLY_PASSWORD_SENTINEL",
      DEPLOYER_KEYSTORE_PATH: "/not-used/keystore",
      DEPLOYER_KEYSTORE_PASSWORD_FILE: "/not-used/password-file",
      DEPLOYER_KEYSTORE_PASSWORD: "TEST_ONLY_PASSWORD_SENTINEL",
    });
    const childEnv = buildForgeEnvironment(env, RPC_URL_SENTINEL);
    expect(childEnv.ETH_RPC_URL).toBe(RPC_URL_SENTINEL);
    for (const key of [
      "DEPLOYER_PRIVATE_KEY",
      "ETH_PRIVATE_KEY",
      "ETH_PASSWORD",
      "ETH_KEYSTORE",
      "ETH_KEYSTORE_ACCOUNT",
      "DEPLOYER_KEYSTORE_PATH",
      "DEPLOYER_KEYSTORE_PASSWORD_FILE",
      "DEPLOYER_KEYSTORE_PASSWORD",
    ]) {
      expect(childEnv[key]).toBeUndefined();
    }

    const args = buildForgeCreateArgs(resolveMarketplaceConfig(env));
    expect(args).toContain("--interactive");
    expect(args).not.toContain("--private-key");
    expect(args).not.toContain("--keystore");
    expect(args).not.toContain("--password-file");
    expect(args.join(" ")).not.toContain(PRIVATE_KEY_SENTINEL);
    expect(args.join(" ")).not.toContain(RPC_URL_SENTINEL);
  });
});

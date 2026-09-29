import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildForgeCreateArgs,
  buildForgeEnvironment,
  hashDeploymentBytecode,
  resolveMarketplaceConfig,
  runForgeCreate,
  runMarketplaceDeployment,
  verifyForgeDeployment,
} from "./deploy-marketplace.mjs";

const TRANSACTION_HASH = `0x${"ab".repeat(32)}`;
const CONTRACT_ADDRESS = "0x284c09a7cc187e096cbbdc88d99defe6df32180a";
const PRIVATE_KEY_SENTINEL = "TEST_ONLY_PRIVATE_KEY_SENTINEL_NOT_A_CREDENTIAL";
const PASSWORD_SENTINEL = "TEST_ONLY_KEYSTORE_PASSWORD_SENTINEL_NOT_A_CREDENTIAL";
const RPC_URL_SENTINEL = "https://rpc.example.invalid/fuji?token=TEST_ONLY_RPC_SENTINEL";

function makeEnv(overrides = {}) {
  return {
    PATH: process.env.PATH || "/usr/bin",
    HOME: process.env.HOME || "/home/node",
    AVALANCHE_FUJI_RPC_URL: RPC_URL_SENTINEL,
    DEPLOYER_KEYSTORE_PATH: "/etc/secrets/marketplace-deployer.keystore",
    DEPLOYER_KEYSTORE_PASSWORD_FILE: "/etc/secrets/marketplace-deployer-password",
    MARKETPLACE_FEE_RECIPIENT: CONTRACT_ADDRESS,
    MARKETPLACE_FEE_BPS: "250",
    ...overrides,
  };
}

async function makeSignerFixture() {
  const cwd = await mkdtemp(join(tmpdir(), "marketplace-signer-test-"));
  const secretsDirectory = join(cwd, "secrets");
  await mkdir(secretsDirectory, { recursive: true });
  const keystorePath = join(secretsDirectory, "fixture-keystore.json");
  const passwordFilePath = join(secretsDirectory, "fixture-password");
  const bytecodePath = join(cwd, "out", "MusicMarketplace.sol", "MusicMarketplace.json");
  await mkdir(join(cwd, "out", "MusicMarketplace.sol"), { recursive: true });
  await writeFile(keystorePath, "fixture only; not an encrypted production keystore\n");
  await writeFile(passwordFilePath, `${PASSWORD_SENTINEL}\n`);
  await writeFile(bytecodePath, JSON.stringify({ bytecode: { object: "0x60006000" } }));
  return { cwd, keystorePath, passwordFilePath, bytecodePath };
}

const goodReceipt = (overrides = {}) => ({
  status: 1,
  blockNumber: 456,
  transactionHash: TRANSACTION_HASH,
  contractAddress: CONTRACT_ADDRESS,
  ...overrides,
});

const goodForgeOutput = (overrides = {}) => ({
  deployedTo: CONTRACT_ADDRESS,
  transactionHash: TRANSACTION_HASH,
  ...overrides,
});

describe("marketplace deployment signer hardening", () => {
  it("uses protected keystore/password-file paths and excludes signer secrets and RPC URL from argv", async () => {
    const fixture = await makeSignerFixture();
    try {
      const env = makeEnv({
        DEPLOYER_PRIVATE_KEY: PRIVATE_KEY_SENTINEL,
        ETH_PASSWORD: PASSWORD_SENTINEL,
        DEPLOYER_KEYSTORE_PATH: fixture.keystorePath,
        DEPLOYER_KEYSTORE_PASSWORD_FILE: fixture.passwordFilePath,
      });
      let observedCall;
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

      const record = await runMarketplaceDeployment({
        env,
        cwd: fixture.cwd,
        Provider: FakeProvider,
        execute: async (file, args, options) => {
          observedCall = { file, args, options };
          return {
            stdout: [
              "Compiling 1 files with Solc 0.8.24",
              JSON.stringify(goodForgeOutput({ blockNumber: 456 })),
            ].join("\n"),
            stderr: "",
          };
        },
      });

      expect(observedCall.file).toBe("forge");
      expect(observedCall.args).toContain("--keystore");
      expect(observedCall.args).toContain(fixture.keystorePath);
      expect(observedCall.args).toContain("--password-file");
      expect(observedCall.args).toContain(fixture.passwordFilePath);
      expect(observedCall.args).toContain("--chain");
      expect(observedCall.args).toContain("43113");
      expect(observedCall.args).toContain("--broadcast");
      expect(observedCall.args).toContain("--json");
      expect(observedCall.args).toContain(CONTRACT_ADDRESS);
      expect(observedCall.args).toContain("250");
      expect(observedCall.args).not.toContain("--private-key");
      expect(observedCall.args).not.toContain("--rpc-url");
      expect(observedCall.args.join(" ")).not.toContain(PRIVATE_KEY_SENTINEL);
      expect(observedCall.args.join(" ")).not.toContain(PASSWORD_SENTINEL);
      expect(observedCall.args.join(" ")).not.toContain(RPC_URL_SENTINEL);
      expect(observedCall.options.env.ETH_RPC_URL).toBe(RPC_URL_SENTINEL);
      expect(observedCall.options.env.DEPLOYER_PRIVATE_KEY).toBeUndefined();
      expect(observedCall.options.env.ETH_PASSWORD).toBeUndefined();

      expect(record).toMatchObject({
        network: "fuji",
        chainId: 43113,
        contractAddress: CONTRACT_ADDRESS,
        deploymentTransaction: TRANSACTION_HASH,
        deploymentBlock: 456,
        feeRecipient: CONTRACT_ADDRESS,
        feeBasisPoints: 250,
        sourceVerificationStatus: "NOT_REQUESTED",
      });
      expect(record.bytecodeHash).toMatch(/^0x[0-9a-f]{64}$/);

      const artifact = await readFile(join(fixture.cwd, "deployments", "marketplace-fuji.json"), "utf8");
      expect(artifact).not.toContain(PRIVATE_KEY_SENTINEL);
      expect(artifact).not.toContain(PASSWORD_SENTINEL);
      expect(artifact).not.toContain(RPC_URL_SENTINEL);
    } finally {
      await rm(fixture.cwd, { recursive: true, force: true });
    }
  });

  it("does not expose child-process output or errors on Forge failure", async () => {
    const env = makeEnv();
    const config = resolveMarketplaceConfig(env);
    const sensitiveError = Object.assign(new Error(PRIVATE_KEY_SENTINEL), {
      stdout: PRIVATE_KEY_SENTINEL,
      stderr: PASSWORD_SENTINEL,
    });

    await expect(runForgeCreate(async () => { throw sensitiveError; }, config, env))
      .rejects.toThrow("Forge create failed; sensitive process output was suppressed.");
  });

  it("keeps the Fuji default at chain 43113 and retains the explicit mainnet confirmation gate", () => {
    expect(resolveMarketplaceConfig(makeEnv())).toMatchObject({ network: "fuji", chainId: 43113 });
    expect(() => resolveMarketplaceConfig(makeEnv({
      DEPLOY_NETWORK: "mainnet",
      AVALANCHE_CCHAIN_RPC_URL: "https://mainnet.rpc.example.invalid",
    }))).toThrow("Mainnet deployment requires CONFIRM_MAINNET_DEPLOY=yes.");
    expect(resolveMarketplaceConfig(makeEnv({
      DEPLOY_NETWORK: "mainnet",
      AVALANCHE_CCHAIN_RPC_URL: "https://mainnet.rpc.example.invalid",
      CONFIRM_MAINNET_DEPLOY: "yes",
    }))).toMatchObject({ network: "mainnet", chainId: 43114 });
  });

  it("preserves fail-closed transaction, receipt, contract, and deployment-block checks", () => {
    expect(verifyForgeDeployment(goodForgeOutput(), goodReceipt())).toEqual({
      transactionHash: TRANSACTION_HASH,
      contractAddress: CONTRACT_ADDRESS,
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
    expect(() => hashDeploymentBytecode("0xabc")).toThrow("Deployment bytecode artifact did not contain valid bytecode.");
    expect(() => hashDeploymentBytecode("0xzz00")).toThrow("Deployment bytecode artifact did not contain valid bytecode.");
  });

  it("removes raw signer material from the Forge environment while providing the RPC URL only by environment", () => {
    const env = makeEnv({
      DEPLOYER_PRIVATE_KEY: PRIVATE_KEY_SENTINEL,
      ETH_PASSWORD: PASSWORD_SENTINEL,
    });
    const childEnv = buildForgeEnvironment(env, RPC_URL_SENTINEL);
    expect(childEnv.ETH_RPC_URL).toBe(RPC_URL_SENTINEL);
    expect(childEnv.DEPLOYER_PRIVATE_KEY).toBeUndefined();
    expect(childEnv.ETH_PASSWORD).toBeUndefined();

    const config = resolveMarketplaceConfig(env);
    const args = buildForgeCreateArgs(config);
    expect(args).not.toContain(PRIVATE_KEY_SENTINEL);
    expect(args).not.toContain(PASSWORD_SENTINEL);
    expect(args).not.toContain(RPC_URL_SENTINEL);
  });
});

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbiCoder, getAddress, getCreateAddress, id, keccak256 } from "ethers";
import { ALBUM_SIGNATURES } from "./deploy-release-per-contract-fuji.mjs";
import { FEE_RECIPIENT, MAINNET_CHAIN_ID, buildDeploymentRecord, buildDryRunPlan, deploymentRecordPath, run, validateDeploymentEnv, verifyReleaseStep } from "./deploy-release-per-contract-mainnet.mjs";
import { ARTIST, DEPLOYER, RECIPIENT, artifacts, fakeChain } from "../test/helpers/mainnet-fake-chain.mjs";

const KEY = `0x${"22".repeat(32)}`;
const BASE = { DEPLOY_NETWORK: "mainnet", EXPECTED_DEPLOYER_ADDRESS: DEPLOYER };
const READY = { ...BASE, EXPECTED_DEPLOYER_NONCE: "0", RELEASE_PLATFORM_RECIPIENT: RECIPIENT };
const selectors = (signatures) => signatures.map((signature) => `63${id(signature).slice(2, 10)}`).join("");
const quietly = async (fn) => {
  const log = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = log; }
};
const readyPlan = (chain = fakeChain()) => buildDryRunPlan(validateDeploymentEnv(READY), chain, { load: artifacts });

describe("release-per-contract mainnet plan: no key, no broadcast", () => {
  it("writes the dry-run plan for the plan binding, without a key", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "void-plan-")), "plan.json");
    const plan = await quietly(() => run(["--dry-run"], { ...READY, PLAN_OUTPUT_PATH: path }, { provider: fakeChain(), buildDryRunPlan: (config, provider) => buildDryRunPlan(config, provider, { load: artifacts }) }));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(JSON.parse(JSON.stringify(plan)));
    expect(plan).toMatchObject({ mode: "DRY_RUN", broadcasted: false, readyToBroadcast: true });
  });

  it("refuses any private key in its environment and any broadcast request", () => {
    expect(() => validateDeploymentEnv({ ...READY, DEPLOYER_PRIVATE_KEY: KEY })).toThrow(/never reads a private key/);
    expect(() => validateDeploymentEnv({ ...READY, MAINNET_DEPLOYER_PRIVATE_KEY: KEY })).toThrow(/never reads a private key/);
    expect(() => validateDeploymentEnv({ ...READY, BROADCAST_DEPLOYMENT: "yes", CONFIRM_MAINNET_DEPLOY: "yes" })).toThrow(/never signs or broadcasts/);
    // An empty variable is not a key.
    expect(validateDeploymentEnv({ ...READY, DEPLOYER_PRIVATE_KEY: "" }).deployerAddress).toBe(DEPLOYER);
  });

  it("plans only for the defined deployer", () => {
    expect(() => validateDeploymentEnv({ ...READY, EXPECTED_DEPLOYER_ADDRESS: "" })).toThrow(/EXPECTED_DEPLOYER_ADDRESS is required/);
    expect(() => validateDeploymentEnv({ ...READY, EXPECTED_DEPLOYER_ADDRESS: ARTIST })).toThrow(/defined mainnet deployer/);
    expect(() => validateDeploymentEnv({ ...READY, EXPECTED_DEPLOYER_ADDRESS: "0x00000000000000000000000000000000000000A1" })).toThrow(/defined mainnet deployer/);
  });

  it("reports the missing recipient as BLOCKED and produces no signing request without it", async () => {
    const plan = await buildDryRunPlan(validateDeploymentEnv(BASE), fakeChain(), { load: artifacts });
    expect(plan).toMatchObject({ mode: "DRY_RUN", chainId: 43114, broadcasted: false, readyToBroadcast: false, signingRequests: null });
    expect(plan.checks.find((item) => item.check === "platformRecipient verified")).toMatchObject({ status: "BLOCKED" });
  });

  it("refuses Fuji and every other chain, and an RPC URL with credentials or plain HTTP to a remote host", async () => {
    await expect(buildDryRunPlan(validateDeploymentEnv(READY), fakeChain({ chainId: 43113n }), { load: artifacts })).rejects.toThrow(/Expected Avalanche C-Chain 43114/);
    expect(() => validateDeploymentEnv({ ...READY, DEPLOY_NETWORK: "fuji" })).toThrow(/mainnet/);
    expect(() => validateDeploymentEnv({ ...READY, AVALANCHE_MAINNET_RPC_URL: "https://user:pass@rpc.example" })).toThrow(/without embedded credentials/);
    expect(() => validateDeploymentEnv({ ...READY, AVALANCHE_MAINNET_RPC_URL: "http://rpc.example" })).toThrow(/HTTPS/);
    expect(validateDeploymentEnv({ ...READY, AVALANCHE_MAINNET_RPC_URL: "http://127.0.0.1:8545" }).rpcUrl).toBe("http://127.0.0.1:8545");
  });

  it("accepts only the recorded Nano S Plus for both fees and refuses the artist, the deployer, any other address, a split, and any fee other than 250 bps", () => {
    expect(FEE_RECIPIENT).toBe(RECIPIENT);
    expect(() => validateDeploymentEnv({ ...BASE, RELEASE_PLATFORM_RECIPIENT: ARTIST })).toThrow(/artist wallet/);
    expect(() => validateDeploymentEnv({ ...BASE, RELEASE_PLATFORM_RECIPIENT: "0x00000000000000000000000000000000000000A1" })).toThrow(/Nano S Plus recorded/);
    expect(() => validateDeploymentEnv({ ...BASE, RELEASE_PLATFORM_RECIPIENT: DEPLOYER })).toThrow(/deployer/);
    expect(() => validateDeploymentEnv({ ...BASE, RELEASE_PLATFORM_RECIPIENT: RECIPIENT, RELEASE_MARKETPLACE_FEE_RECIPIENT: "0x00000000000000000000000000000000000000A2" })).toThrow(/one recipient/);
    expect(() => validateDeploymentEnv({ ...BASE, RELEASE_PLATFORM_FEE_BPS: "500" })).toThrow(/exactly 250/);
    expect(() => validateDeploymentEnv({ ...BASE, RELEASE_MARKETPLACE_FEE_BPS: "0" })).toThrow(/exactly 250/);
    expect(validateDeploymentEnv({ ...BASE, RELEASE_PLATFORM_RECIPIENT: RECIPIENT }).marketplaceFeeRecipient).toBe(RECIPIENT);
  });

  it("carries the exact unsigned creation transactions: chain, deployer, nonces, creation data, hashes and predicted addresses", async () => {
    const plan = await readyPlan();
    const factory = getCreateAddress({ from: DEPLOYER, nonce: 0 });
    const coder = AbiCoder.defaultAbiCoder();
    const factoryData = `0x6001600155${coder.encode(["address"], [RECIPIENT]).slice(2)}`;
    const marketplaceData = `0x6002600255${coder.encode(["address", "uint256", "address"], [RECIPIENT, 250, factory]).slice(2)}`;
    expect(plan.signingRequests).toEqual([
      { step: 1, contract: "VoidReleaseFactoryV2Royalty", chainId: 43114, from: DEPLOYER, to: null, nonce: 0, value: "0", data: factoryData.toLowerCase(), dataHash: keccak256(factoryData), gasLimit: "1200000", predictedAddress: factory },
      { step: 2, contract: "ReleaseMarketplaceV4", chainId: 43114, from: DEPLOYER, to: null, nonce: 1, value: "0", data: marketplaceData.toLowerCase(), dataHash: keccak256(marketplaceData), gasLimit: "1200000", predictedAddress: getCreateAddress({ from: DEPLOYER, nonce: 1 }) },
    ]);
    expect(plan.transactions[0].predictedImplementation).toBe(getCreateAddress({ from: factory, nonce: 1 }));
    expect(plan.planInputs).toEqual({ DEPLOY_NETWORK: "mainnet", EXPECTED_DEPLOYER_ADDRESS: DEPLOYER, EXPECTED_DEPLOYER_NONCE: "0", RELEASE_PLATFORM_RECIPIENT: RECIPIENT, RELEASE_MARKETPLACE_FEE_RECIPIENT: RECIPIENT, RELEASE_PLATFORM_FEE_BPS: "250", RELEASE_MARKETPLACE_FEE_BPS: "250" });
  });

  it("contains no secret material", async () => {
    const text = JSON.stringify(await readyPlan());
    expect(text).not.toMatch(/PRIVATE_KEY|privateKey|mnemonic|seed/i);
    // The only 32-byte hex values are hashes the plan names as such, and the ABI-encoded (padded)
    // public fee recipient passed to the factory constructor.
    const words = [...text.matchAll(/"([a-zA-Z]+)":"0x[0-9a-fA-F]{64}"/g)].map((match) => match[1]);
    expect(new Set(words)).toEqual(new Set(["initCodeHash", "runtimeCodeHash", "dataHash", "factory"]));
    expect(JSON.parse(text).constructorArgsEncoded.factory).toBe(AbiCoder.defaultAbiCoder().encode(["address"], [RECIPIENT]));
  });

  it("is not ready when the nonce moved, a transaction is pending, a predicted address has code, funding is short or the recipient is a contract", async () => {
    const predicted = getCreateAddress({ from: DEPLOYER, nonce: 0 });
    for (const chain of [fakeChain({ nonce: 1 }), fakeChain({ pendingNonce: 1 }), fakeChain({ code: { [predicted]: "0x60" } }), fakeChain({ balance: 0n }), fakeChain({ code: { [RECIPIENT]: "0x60" } })]) {
      expect((await readyPlan(chain)).readyToBroadcast).toBe(false);
    }
    expect((await readyPlan()).readyToBroadcast).toBe(true);
  });

  it("refuses artifacts that do not enforce the 2.5% artist royalty on chain", async () => {
    const unlocked = async (path) => ({ ...(await artifacts(path)), deployedBytecode: { object: path.includes("VoidRelease1155V4") ? `0x${selectors(ALBUM_SIGNATURES)}` : "0x6000" } });
    const plan = await buildDryRunPlan(validateDeploymentEnv(READY), fakeChain(), { load: unlocked });
    expect(plan.checks.find((item) => item.check === "artifacts enforce the 2.5% artist royalty on chain")).toMatchObject({ status: "FAIL" });
    expect(plan.readyToBroadcast).toBe(false);
  });
});

describe("release-per-contract mainnet: verifying owner-signed transactions from chain", () => {
  async function minedFactory(chain, plan, factoryOptions = {}, mineOverrides = {}) {
    const [factory] = plan.transactions;
    const hash = chain.mine(plan.signingRequests[0], mineOverrides);
    chain.factoryViews(factory.predictedAddress, { implementation: factory.predictedImplementation, ...factoryOptions });
    return hash;
  }

  it("verifies the factory and the marketplace and builds the mainnet record", async () => {
    const chain = fakeChain();
    const plan = await readyPlan(chain);
    const [factory, marketplace] = plan.transactions;
    const first = await verifyReleaseStep(chain, plan, 1, await minedFactory(chain, plan), { load: artifacts });
    expect(first).toMatchObject({ address: factory.predictedAddress, implementationAddress: factory.predictedImplementation, platformRecipient: RECIPIENT, platformFeeBps: 250, requiredRoyaltyBps: 250 });
    const hash = chain.mine(plan.signingRequests[1]);
    chain.marketplaceViews(marketplace.predictedAddress, { registry: factory.predictedAddress });
    const second = await verifyReleaseStep(chain, plan, 2, hash, { load: artifacts });
    expect(second).toMatchObject({ address: marketplace.predictedAddress, factoryAddress: factory.predictedAddress, feeRecipient: RECIPIENT, feeBps: 250 });
    const record = buildDeploymentRecord(plan, [first, second], { sourceCommit: "a".repeat(40), planDigest: "b".repeat(64) });
    expect(record).toMatchObject({ network: "mainnet", chainId: 43114, signedBy: { deployer: DEPLOYER }, factory: { address: factory.predictedAddress, contract: "VoidReleaseFactoryV2Royalty", deploymentTransaction: first.transaction }, marketplace: { address: marketplace.predictedAddress, contract: "ReleaseMarketplaceV4", factoryAddress: factory.predictedAddress } });
    expect(deploymentRecordPath(factory.predictedAddress)).toMatch(/^deployments\/release-per-contract-mainnet-0x/);
  });

  it.each([
    ["a wrong chain ID", { tx: { chainId: 43113n } }, /chainId 43113/],
    ["a different sender", { tx: { from: ARTIST } }, /sender/],
    ["a different nonce", { tx: { nonce: 7 } }, /nonce 7/],
    ["changed creation data (constructor args or artifact)", { tx: { data: "0x6001600155deadbeef" } }, /creation data hash/],
    ["a call instead of a creation", { tx: { to: RECIPIENT } }, /expected a contract creation/],
    ["a non-zero value", { tx: { value: 1n } }, /value 1/],
    ["a contract at another address", { contractAddress: "0x00000000000000000000000000000000000000F1" }, /created 0x00000000000000000000000000000000000000f1/i],
    ["a reverted transaction", { status: 0 }, /receipt status 0/],
  ])("refuses a mined factory transaction with %s", async (_name, overrides, message) => {
    const chain = fakeChain();
    const plan = await readyPlan(chain);
    await expect(verifyReleaseStep(chain, plan, 1, await minedFactory(chain, plan, {}, overrides), { load: artifacts })).rejects.toThrow(message);
  });

  it("refuses a factory whose immutables or implementation differ from the plan", async () => {
    for (const [options, message] of [
      [{ recipient: ARTIST }, /platformRecipient/],
      [{ fee: 500n }, /PLATFORM_FEE_BPS/],
      [{ forbidden: ARTIST }, /implementation platformFeeRecipient/],
      [{ implementationCode: "0x6000" }, /runtime code differs/],
      [{ implementation: "0x00000000000000000000000000000000000000F2" }, /implementation 0x/],
    ]) {
      const chain = fakeChain();
      const plan = await readyPlan(chain);
      await expect(verifyReleaseStep(chain, plan, 1, await minedFactory(chain, plan, options), { load: artifacts })).rejects.toThrow(message);
    }
    const chain = fakeChain();
    const plan = await readyPlan(chain);
    await expect(verifyReleaseStep(chain, plan, 1, await minedFactory(chain, plan, {}, { runtime: "0x6002" }), { load: artifacts })).rejects.toThrow(/factory runtime code differs/);
  });

  it("refuses a marketplace bound to another factory, recipient, fee or chain", async () => {
    for (const [options, message] of [
      [{ registry: "0x00000000000000000000000000000000000000F3" }, /registry/],
      [{ feeRecipient: ARTIST }, /feeRecipient/],
      [{ fee: 0n }, /platformFeeBps/],
      [{ chain: 43113n }, /deploymentChainId/],
      [{ runtime: "0x6001" }, /marketplace runtime code differs/],
    ]) {
      const chain = fakeChain();
      const plan = await readyPlan(chain);
      await verifyReleaseStep(chain, plan, 1, await minedFactory(chain, plan), { load: artifacts });
      const hash = chain.mine(plan.signingRequests[1], options.runtime ? { runtime: options.runtime } : {});
      chain.marketplaceViews(plan.transactions[1].predictedAddress, { registry: plan.transactions[0].predictedAddress, ...options });
      await expect(verifyReleaseStep(chain, plan, 2, hash, { load: artifacts })).rejects.toThrow(message);
    }
  });

  it("refuses an RPC on another chain and a malformed or unknown hash", async () => {
    const chain = fakeChain();
    const plan = await readyPlan(chain);
    await expect(verifyReleaseStep(fakeChain({ chainId: 1n }), plan, 1, `0x${"1".repeat(64)}`, { load: artifacts })).rejects.toThrow(/RPC reports chain 1/);
    await expect(verifyReleaseStep(chain, plan, 1, "0x1234", { load: artifacts })).rejects.toThrow(/32-byte transaction hash/);
    await expect(verifyReleaseStep(chain, plan, 1, `0x${"9".repeat(64)}`, { load: artifacts, timeoutMs: 1 })).rejects.toThrow(/not mined/);
  });
});

it("keeps the mainnet chain constant", () => {
  expect(MAINNET_CHAIN_ID).toBe(43114);
  expect(getAddress(RECIPIENT)).toBe(FEE_RECIPIENT);
});

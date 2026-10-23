import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbiCoder, getAddress, getCreateAddress, id, keccak256 } from "ethers";
import { ALBUM_SIGNATURES } from "./deploy-release-per-contract-fuji.mjs";
import { RELEASE_FACTORY_PROFILES, factoryProfile, missingSelectors, profileOfPlan, FACTORY_ARTIFACT_PATH, FACTORY_CONTRACT, FEE_RECIPIENT, MAINNET_CHAIN_ID, MARKETPLACE_ARTIFACT_PATH, buildDeploymentRecord, buildDryRunPlan, deploymentRecordPath, run, settledSaleProblems, validateDeploymentEnv, verifyReleaseStep } from "./deploy-release-per-contract-mainnet.mjs";
import { ARTIST, DEPLOYER, FACTORY_INIT, LEGACY_SALE_INIT, RECIPIENT, artifacts, fakeChain, sequentialArtifacts, sequentialRuntime } from "../test/helpers/mainnet-fake-chain.mjs";
import { validateApprovedPlan } from "./approved-plan.mjs";
import { bindPlan } from "./plan-binding-core.mjs";
import mainnetManifest from "../config/mainnet-release-per-contract.json" with { type: "json" };
import { SETTLED_SALE_RUNTIME_CODE_HASH } from "../src/lib/sale-authorization.js";

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
    const factoryData = `${FACTORY_INIT}${coder.encode(["address"], [RECIPIENT]).slice(2)}`;
    const marketplaceData = `0x6002600255${coder.encode(["address", "address", "address", "address", "uint256", "address"], [RECIPIENT, factory, "0x262B774cf9a1949170B58E2d57F6189980FE757b", "0xD1B4367dd9f235f9ee61878019d66E31511E98eE", 3, "0x284C09a7CC187E096cbbdc88d99DEFE6df32180a"]).slice(2)}`;
    expect(plan.signingRequests).toEqual([
      { step: 1, contract: "VoidReleaseFactoryV2RoyaltySettled", chainId: 43114, from: DEPLOYER, to: null, nonce: 0, value: "0", data: factoryData.toLowerCase(), dataHash: keccak256(factoryData), gasLimit: "1200000", predictedAddress: factory },
      { step: 2, contract: "VoidUnifiedMarketplace", chainId: 43114, from: DEPLOYER, to: null, nonce: 1, value: "0", data: marketplaceData.toLowerCase(), dataHash: keccak256(marketplaceData), gasLimit: "1200000", predictedAddress: getCreateAddress({ from: DEPLOYER, nonce: 1 }) },
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
    expect(new Set(words)).toEqual(new Set(["initCodeHash", "runtimeCodeHash", "reviewedRuntimeHash", "dataHash", "factory"]));
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

  it("plans the corrected factory, whose releases pay the platform fee during the purchase", async () => {
    // Nonce 0 of the defined deployer created the deployed factory 0x262B…; the next factory comes from a later nonce.
    const plan = await buildDryRunPlan(validateDeploymentEnv({ ...READY, EXPECTED_DEPLOYER_NONCE: "2" }), fakeChain({ nonce: 2 }), { load: artifacts });
    expect(getCreateAddress({ from: DEPLOYER, nonce: 0 })).toBe(getAddress(mainnetManifest.historicalDeployments[0].factoryAddress));
    expect(getCreateAddress({ from: DEPLOYER, nonce: 3 })).toBe(getAddress(mainnetManifest.factoryAddress));
    expect(plan.readyToBroadcast).toBe(true);
    expect(FACTORY_CONTRACT).toBe("VoidReleaseFactoryV2RoyaltySettled");
    expect(plan.artifacts.factory).toMatchObject({ contract: FACTORY_CONTRACT, path: FACTORY_ARTIFACT_PATH, primarySale: "VoidPrimarySaleSettled", initCodeHash: keccak256(FACTORY_INIT) });
    expect(plan.artifacts.primarySale).toMatchObject({ contract: "VoidPrimarySaleSettled", path: "out/VoidPrimarySaleSettled.sol/VoidPrimarySaleSettled.json", reviewedRuntimeHash: SETTLED_SALE_RUNTIME_CODE_HASH });
    expect(plan.transactions[0]).toMatchObject({ contract: FACTORY_CONTRACT, constructor: { platformRecipient: RECIPIENT } });
    expect(plan.transactions[0].primarySale).toMatch(/^VoidPrimarySaleSettled /);
    // The marketplace is bound to the factory this plan creates, never to the deployed one.
    expect(plan.transactions[1].constructor.releaseFactory).toBe(plan.transactions[0].predictedAddress);
    expect(plan.transactions[1].constructor.releaseFactory).not.toBe(getAddress(mainnetManifest.factoryAddress));
    expect(plan.checks.find((item) => item.check === "factory gives every release the settled primary sale")).toMatchObject({ status: "PASS", value: [] });
  });

  it("refuses a factory that does not embed the exact reviewed settled sale, or embeds the legacy sale", async () => {
    const PlatformPaidOnly = `0x60016001557f${id("PlatformPaid(address,uint256)").slice(2)}`;
    const factoryWith = (object) => async (path) => (path.includes("Factory") ? { ...(await artifacts(path)), bytecode: { object } } : artifacts(path));
    const saleWith = (deployed) => async (path) => (path.includes("VoidPrimarySaleSettled") ? { ...(await artifacts(path)), deployedBytecode: { object: deployed } } : artifacts(path));
    for (const [load, expected] of [
      // An unrelated PlatformPaid signature is not the sale implementation.
      [factoryWith(PlatformPaidOnly), ["factory does not embed the VoidPrimarySaleSettled creation code"]],
      [factoryWith(`0x6001600155${LEGACY_SALE_INIT.slice(2)}`), ["factory does not embed the VoidPrimarySaleSettled creation code", "factory embeds the legacy VoidPrimarySale"]],
      [factoryWith(`${FACTORY_INIT}${LEGACY_SALE_INIT.slice(2)}`), ["factory embeds the legacy VoidPrimarySale"]],
      // A sale artifact whose runtime is not the one the Earnings view authorizes.
      [saleWith(`0x${"60".repeat(4000)}0000`), ["VoidPrimarySaleSettled artifact is not the reviewed sale"]],
    ]) {
      const plan = await buildDryRunPlan(validateDeploymentEnv(READY), fakeChain(), { load });
      expect(plan.checks.find((item) => item.check === "factory gives every release the settled primary sale")).toMatchObject({ status: "FAIL", value: expected });
      expect(plan.readyToBroadcast).toBe(false);
    }
  });

  it.skipIf(!existsSync(new URL("../out/VoidReleaseFactoryV2RoyaltySettled.sol/VoidReleaseFactoryV2RoyaltySettled.json", import.meta.url)))("tells the compiled corrected factory from the deployed one", () => {
    const compiled = (name) => JSON.parse(readFileSync(new URL(`../out/${name}.sol/${name}.json`, import.meta.url), "utf8"));
    const settled = compiled("VoidReleaseFactoryV2RoyaltySettled");
    expect(FACTORY_ARTIFACT_PATH).toBe("out/VoidReleaseFactoryV2RoyaltySettled.sol/VoidReleaseFactoryV2RoyaltySettled.json");
    const [sale, legacySale] = [compiled("VoidPrimarySaleSettled"), compiled("VoidPrimarySale")];
    expect(settledSaleProblems(settled.bytecode.object, sale, legacySale)).toEqual([]);
    expect(settledSaleProblems(compiled("VoidReleaseFactoryV2Royalty").bytecode.object, sale, legacySale)).toEqual(["factory does not embed the VoidPrimarySaleSettled creation code", "factory embeds the legacy VoidPrimarySale"]);
    // Same constructor as the deployed factory: the one platform recipient.
    expect(settled.abi.find((item) => item.type === "constructor").inputs.map((input) => input.type)).toEqual(["address"]);
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
    expect(record).toMatchObject({ network: "mainnet", chainId: 43114, signedBy: { deployer: DEPLOYER }, factory: { address: factory.predictedAddress, contract: "VoidReleaseFactoryV2RoyaltySettled", artifact: "out/VoidReleaseFactoryV2RoyaltySettled.sol/VoidReleaseFactoryV2RoyaltySettled.json", primarySale: "VoidPrimarySaleSettled", deploymentTransaction: first.transaction }, marketplace: { address: marketplace.predictedAddress, contract: "VoidUnifiedMarketplace", genesisCollection: "0xD1B4367dd9f235f9ee61878019d66E31511E98eE", legacyReleaseFactory: "0x262B774cf9a1949170B58E2d57F6189980FE757b", artifact: MARKETPLACE_ARTIFACT_PATH, factoryAddress: factory.predictedAddress } });
    expect(deploymentRecordPath(factory.predictedAddress)).toMatch(/^deployments\/release-per-contract-mainnet-0x/);
    // Every field the manifest update needs for the new active pair is in the record.
    expect(record.factory).toMatchObject({ address: expect.any(String), deploymentBlock: expect.any(Number), implementationAddress: factory.predictedImplementation, platformRecipient: RECIPIENT });
    expect(record.marketplace).toMatchObject({ address: expect.any(String), deploymentBlock: expect.any(Number), factoryAddress: record.factory.address, feeRecipient: RECIPIENT, feeBps: 250 });
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

  it("refuses a marketplace bound to another factory, recipient, fee, Genesis policy or chain", async () => {
    for (const [options, message] of [
      [{ registry: "0x00000000000000000000000000000000000000F3" }, /releaseFactory/],
      [{ legacy: "0x00000000000000000000000000000000000000F3" }, /legacyReleaseFactory/],
      [{ feeRecipient: ARTIST }, /feeRecipient/],
      [{ fee: 0n }, /factory economics/],
      [{ genesis: "0x00000000000000000000000000000000000000F4" }, /genesisCollection/],
      [{ genesisMax: 4n }, /genesisMaxTokenId/],
      [{ genesisReceiver: "0x00000000000000000000000000000000000000F5" }, /genesisRoyaltyReceiver/],
      [{ genesisFee: 250n }, /Genesis economics/],
      [{ genesisRoyalty: 250n }, /Genesis economics/],
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

describe("release-per-contract mainnet: the sequential token-ID factory (RELEASE_FACTORY_PROFILE=sequential)", () => {
  const SEQ = { ...READY, RELEASE_FACTORY_PROFILE: "sequential" };
  const sequentialPlan = (chain = fakeChain()) => buildDryRunPlan(validateDeploymentEnv(SEQ), chain, { load: sequentialArtifacts });
  const minedSequentialFactory = async (chain, plan, options = {}) => {
    const [factory] = plan.transactions;
    const hash = chain.mine(plan.signingRequests[0]);
    chain.factoryViews(factory.predictedAddress, { implementation: factory.predictedImplementation, version: 4n, implementationCode: sequentialRuntime, sequential: {}, ...options });
    return hash;
  };

  it("plans VoidReleaseFactoryV4Sequential with the V6 implementation, version 4, the settled sale and the same marketplace bindings", async () => {
    const plan = await sequentialPlan();
    expect(plan.readyToBroadcast).toBe(true);
    expect(plan).toMatchObject({ factoryProfile: "sequential", tokenIdScheme: "sequential" });
    expect(plan.artifacts.factory).toMatchObject({ contract: "VoidReleaseFactoryV4Sequential", path: "out/VoidReleaseFactoryV4Sequential.sol/VoidReleaseFactoryV4Sequential.json", primarySale: "VoidPrimarySaleSettled" });
    expect(plan.artifacts.implementation).toMatchObject({ contract: "VoidRelease1155V6Sequential", path: "out/VoidRelease1155V6Sequential.sol/VoidRelease1155V6Sequential.json", runtimeCodeHash: keccak256(sequentialRuntime), albumCapable: true });
    expect(plan.transactions[0]).toMatchObject({ contract: "VoidReleaseFactoryV4Sequential", constructor: { platformRecipient: RECIPIENT }, sealedInBytecode: { PLATFORM_FEE_BPS: 250, RELEASE_VERSION: 4, REQUIRED_ROYALTY_BPS: 250 } });
    expect(plan.transactions[0].implementation).toMatch(/^VoidRelease1155V6Sequential \(token IDs 1, 2, 3/);
    expect(plan.signingRequests[0].contract).toBe("VoidReleaseFactoryV4Sequential");
    // Same marketplace as the settled plan: bound to this plan's factory, the production factory 0x262B… and Genesis 0-3.
    expect(plan.transactions[1].constructor).toEqual({ feeRecipient: RECIPIENT, releaseFactory: plan.transactions[0].predictedAddress, legacyReleaseFactory: "0x262B774cf9a1949170B58E2d57F6189980FE757b", genesisCollection: "0xD1B4367dd9f235f9ee61878019d66E31511E98eE", genesisMaxTokenId: 3, genesisRoyaltyReceiver: ARTIST });
    expect(plan.checks.find((item) => item.check === "implementation assigns sequential token IDs per release")).toMatchObject({ status: "PASS", value: [] });
    expect(plan.checks.find((item) => item.check === "factory gives every release the settled primary sale")).toMatchObject({ status: "PASS" });
  });

  it("records the profile in planInputs so the signing tool re-plans the same factory, and leaves the default plan unchanged", async () => {
    const plan = await sequentialPlan();
    expect(plan.planInputs.RELEASE_FACTORY_PROFILE).toBe("sequential");
    expect(validateDeploymentEnv(plan.planInputs).factoryProfile).toBe("sequential");
    const settled = await readyPlan();
    expect(settled.planInputs).not.toHaveProperty("RELEASE_FACTORY_PROFILE");
    expect(settled).not.toHaveProperty("factoryProfile");
    expect(settled.transactions[0]).toMatchObject({ contract: FACTORY_CONTRACT, sealedInBytecode: { RELEASE_VERSION: 2 } });
    expect(profileOfPlan(settled)).toBe(RELEASE_FACTORY_PROFILES.settled);
    expect(profileOfPlan(plan)).toBe(RELEASE_FACTORY_PROFILES.sequential);
    expect(() => validateDeploymentEnv({ ...READY, RELEASE_FACTORY_PROFILE: "v5" })).toThrow(/settled" or "sequential/);
    expect(factoryProfile("")).toBe(RELEASE_FACTORY_PROFILES.settled);
  });

  it("is not ready when the implementation artifact does not number its tokens", async () => {
    const plan = await buildDryRunPlan(validateDeploymentEnv(SEQ), fakeChain(), { load: artifacts });
    expect(plan.checks.find((item) => item.check === "implementation assigns sequential token IDs per release")).toMatchObject({ status: "FAIL", value: ["nextTokenId()", "lastTokenId()", "IMPLEMENTATION_VERSION()"] });
    expect(plan.readyToBroadcast).toBe(false);
  });

  it("verifies a mined sequential factory and builds the record naming V6 and the sequential scheme", async () => {
    const chain = fakeChain();
    const plan = await sequentialPlan(chain);
    const [factory, marketplace] = plan.transactions;
    const first = await verifyReleaseStep(chain, plan, 1, await minedSequentialFactory(chain, plan), { load: sequentialArtifacts });
    expect(first).toMatchObject({ address: factory.predictedAddress, implementationAddress: factory.predictedImplementation, releaseVersion: 4 });
    const hash = chain.mine(plan.signingRequests[1]);
    chain.marketplaceViews(marketplace.predictedAddress, { registry: factory.predictedAddress });
    const second = await verifyReleaseStep(chain, plan, 2, hash, { load: sequentialArtifacts });
    const record = buildDeploymentRecord(plan, [first, second], { sourceCommit: "a".repeat(40), planDigest: "b".repeat(64) });
    expect(record.factory).toMatchObject({ contract: "VoidReleaseFactoryV4Sequential", artifact: "out/VoidReleaseFactoryV4Sequential.sol/VoidReleaseFactoryV4Sequential.json", implementation: "VoidRelease1155V6Sequential", implementationVersion: 4, implementationSourceVersion: 6, tokenIdScheme: "sequential", requiredRoyaltyBps: 250 });
    expect(record.marketplace).toMatchObject({ factoryAddress: factory.predictedAddress, legacyReleaseFactory: "0x262B774cf9a1949170B58E2d57F6189980FE757b" });
  });

  it("refuses a mined factory reporting version 2, an implementation without sequential IDs, or one already numbering", async () => {
    for (const [options, message] of [
      [{ version: 2n }, /RELEASE_VERSION 2/],
      [{ sequential: null }, /does not expose sequential token IDs/],
      [{ sequential: { version: 5n } }, /IMPLEMENTATION_VERSION 5/],
      [{ sequential: { next: 2n } }, /sequential token IDs \(nextTokenId 2/],
      [{ sequential: { idOfOne: 7n } }, /tokenIdFor\(1\) 7/],
      [{ implementationCode: "0x6000" }, /runtime code differs/],
    ]) {
      const chain = fakeChain();
      const plan = await sequentialPlan(chain);
      await expect(verifyReleaseStep(chain, plan, 1, await minedSequentialFactory(chain, plan, options), { load: sequentialArtifacts })).rejects.toThrow(message);
    }
  });

  it("is a valid approved release-infrastructure plan once bound; a mismatched factory or implementation is refused", async () => {
    // Nonce 0 is the executed 0x262B… factory, which the validator deliberately exempts; the next deployment uses a later nonce.
    const plan = await buildDryRunPlan(validateDeploymentEnv({ ...SEQ, EXPECTED_DEPLOYER_NONCE: "5" }), fakeChain({ nonce: 5 }), { load: sequentialArtifacts });
    const entry = { kind: "release-per-contract-mainnet", plan, binding: bindPlan("release-per-contract-mainnet", plan, "c".repeat(40)) };
    expect(() => validateApprovedPlan(entry)).not.toThrow();
    for (const mutate of [
      (copy) => { copy.artifacts.implementation.path = "out/VoidRelease1155V4Royalty.sol/VoidRelease1155V4Royalty.json"; },
      (copy) => { copy.transactions[0].contract = "VoidReleaseFactoryV2Royalty"; copy.signingRequests[0].contract = "VoidReleaseFactoryV2Royalty"; },
    ]) {
      const copy = JSON.parse(JSON.stringify(plan));
      mutate(copy);
      expect(() => validateApprovedPlan({ kind: entry.kind, plan: copy, binding: bindPlan(entry.kind, copy, "c".repeat(40)) })).toThrow(/must deploy VoidReleaseFactoryV2RoyaltySettled or VoidReleaseFactoryV4Sequential/);
    }
  });

  it.skipIf(!existsSync(new URL("../out/VoidReleaseFactoryV4Sequential.sol/VoidReleaseFactoryV4Sequential.json", import.meta.url)))("the compiled sequential factory embeds the reviewed settled sale and creates the V6 implementation", () => {
    const compiled = (name) => JSON.parse(readFileSync(new URL(`../out/${name}.sol/${name}.json`, import.meta.url), "utf8"));
    const factory = compiled("VoidReleaseFactoryV4Sequential");
    const [sale, legacySale, v6, v4Royalty] = [compiled("VoidPrimarySaleSettled"), compiled("VoidPrimarySale"), compiled("VoidRelease1155V6Sequential"), compiled("VoidRelease1155V4Royalty")];
    expect(settledSaleProblems(factory.bytecode.object, sale, legacySale)).toEqual([]);
    const code = factory.bytecode.object.toLowerCase();
    expect(code.includes(v6.bytecode.object.slice(2).toLowerCase())).toBe(true);
    expect(code.includes(v4Royalty.bytecode.object.slice(2).toLowerCase())).toBe(false);
    expect(missingSelectors(v6.deployedBytecode.object, RELEASE_FACTORY_PROFILES.sequential.sequentialSignatures)).toEqual([]);
    expect(factory.abi.find((item) => item.type === "constructor").inputs.map((input) => input.type)).toEqual(["address"]);
  });
});

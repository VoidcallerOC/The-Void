import { describe, expect, it } from "vitest";
import { Wallet, getAddress, getCreateAddress, id } from "ethers";
import { ALBUM_SIGNATURES } from "./deploy-release-per-contract-fuji.mjs";
import { DEFAULT_ROYALTY_PAYOUT, FEE_RECIPIENT, FUJI_CHAIN_ID, broadcastRehearsal, buildRehearsalPlan, existingFujiAddresses, run, validateRehearsalEnv } from "./rehearse-royalty-fuji.mjs";

const KEY = `0x${"33".repeat(32)}`;
const DEPLOYER = new Wallet(KEY).address;
const BASE = { DEPLOY_NETWORK: "fuji", EXPECTED_DEPLOYER_ADDRESS: DEPLOYER };
const BROADCAST = { ...BASE, DEPLOYER_PRIVATE_KEY: KEY, EXPECTED_DEPLOYER_NONCE: "61", BROADCAST_REHEARSAL: "yes", CONFIRM_FUJI_REHEARSAL: "yes" };

function fakeProvider({ chainId = FUJI_CHAIN_ID, nonce = 61, pendingNonce = nonce, balance = 10n ** 18n, code = {} } = {}) {
  return {
    getNetwork: async () => ({ chainId: BigInt(chainId) }),
    getTransactionCount: async (_a, tag) => (tag === "pending" ? pendingNonce : nonce),
    getBalance: async () => balance,
    getCode: async (target) => code[getAddress(target)] ?? "0x",
  };
}
// Artifacts whose runtime carries the royalty-lock and album selectors (PUSH4 + selector).
const selectors = (signatures) => signatures.map((signature) => `63${id(signature).slice(2, 10)}`).join("");
const artifacts = (locked = true) => async (path) => ({
  abi: [], bytecode: { object: "0x6000" },
  deployedBytecode: { object: path.includes("VoidRelease1155V4Royalty") ? `0x${selectors(ALBUM_SIGNATURES)}${locked ? selectors(["REQUIRED_ROYALTY_BPS()", "platformFeeRecipient()"]) : ""}` : path.includes("Marketplace") ? `0x${locked ? selectors(["REQUIRED_ROYALTY_BPS()", "REQUIRED_PLATFORM_FEE_BPS()"]) : ""}` : "0x6000" },
});

describe("Fuji royalty rehearsal (additive Fuji-first gate)", () => {
  it("uses the same platform fee recipient as the mainnet manifest and a separate passive royalty payout", () => {
    expect(FEE_RECIPIENT).toBe("0xb65C575CaE01574296Fab6E620B9A15cC0121ce4");
    expect(validateRehearsalEnv(BASE)).toMatchObject({ deployer: DEPLOYER, royaltyPayout: getAddress(DEFAULT_ROYALTY_PAYOUT), broadcast: false, deployerPrivateKey: null });
    expect(() => validateRehearsalEnv({ ...BASE, REHEARSAL_ROYALTY_PAYOUT: FEE_RECIPIENT })).toThrow(/must differ/);
    expect(() => validateRehearsalEnv({ ...BASE, REHEARSAL_ROYALTY_PAYOUT: DEPLOYER })).toThrow(/must differ/);
  });

  it("refuses mainnet and every other chain", async () => {
    expect(() => validateRehearsalEnv({ ...BASE, DEPLOY_NETWORK: "mainnet" })).toThrow(/fuji/);
    await expect(buildRehearsalPlan(validateRehearsalEnv(BASE), fakeProvider({ chainId: 43114 }), { load: artifacts() })).rejects.toThrow(/only on Fuji/);
  });

  it("requires the typed confirmation, the key and the reviewed nonce to broadcast", () => {
    expect(validateRehearsalEnv(BROADCAST)).toMatchObject({ broadcast: true, expectedNonce: 61 });
    for (const field of ["CONFIRM_FUJI_REHEARSAL", "DEPLOYER_PRIVATE_KEY", "EXPECTED_DEPLOYER_NONCE"]) expect(() => validateRehearsalEnv({ ...BROADCAST, [field]: "" }), field).toThrow(new RegExp(field));
    expect(() => validateRehearsalEnv({ ...BROADCAST, EXPECTED_DEPLOYER_ADDRESS: FEE_RECIPIENT })).toThrow(/does not belong/);
  });

  it("plans only new addresses: none may be a recorded Fuji contract or already have code", async () => {
    const existing = existingFujiAddresses();
    expect(existing.has(getAddress("0x3e4E0d9187f6fD11bD6d792a7088D0c2dE8E3aC8"))).toBe(true);
    expect(existing.has(getAddress("0xa464edb22C4959943334DB07001e3ba63989C898"))).toBe(true);
    const config = validateRehearsalEnv({ ...BASE, EXPECTED_DEPLOYER_NONCE: "61" });
    const plan = await buildRehearsalPlan(config, fakeProvider(), { load: artifacts() });
    expect(plan.predicted.factory).toBe(getCreateAddress({ from: DEPLOYER, nonce: 61 }));
    expect(plan.predicted.marketplace).toBe(getCreateAddress({ from: DEPLOYER, nonce: 62 }));
    expect(plan).toMatchObject({ ready: true, broadcasted: false });
    const occupied = await buildRehearsalPlan(config, fakeProvider({ code: { [plan.predicted.factory]: "0x60" } }), { load: artifacts() });
    expect(occupied.ready).toBe(false);
  });

  it("is not ready with unlocked artifacts, a moved nonce, pending transactions or no funds", async () => {
    const config = validateRehearsalEnv({ ...BASE, EXPECTED_DEPLOYER_NONCE: "61" });
    for (const [provider, load] of [[fakeProvider(), artifacts(false)], [fakeProvider({ nonce: 62 }), artifacts()], [fakeProvider({ pendingNonce: 62 }), artifacts()], [fakeProvider({ balance: 0n }), artifacts()]]) {
      expect((await buildRehearsalPlan(config, provider, { load })).ready).toBe(false);
    }
  });

  it("never broadcasts by default and refuses to broadcast an unready plan", async () => {
    const plan = await run(["--dry-run"], BASE, { provider: fakeProvider(), buildRehearsalPlan: (config, provider) => buildRehearsalPlan(config, provider, { load: artifacts() }), broadcastRehearsal: () => { throw new Error("must not broadcast"); } });
    expect(plan).toMatchObject({ mode: "PLAN", broadcasted: false });
    await expect(broadcastRehearsal(validateRehearsalEnv(BROADCAST), fakeProvider(), { ready: false })).rejects.toThrow(/not ready/);
  });
});

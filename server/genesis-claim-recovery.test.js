import { Wallet } from "ethers";
import { describe, expect, it } from "vitest";
import { loadGenesisClaimConfig } from "./genesis-claim.js";
import { createMemoryGenesisClaimReservationStore } from "./genesis-claim-store.js";

const signerKey = `0x${"5a".repeat(32)}`;
const signer = new Wallet(signerKey).address;
const OLD = "0x00000000000000000000000000000000000000a1";
const RECOVERY = "0x00000000000000000000000000000000000000a2";
const RELEASE = "0x00000000000000000000000000000000000000a3";
const SALE = "0x00000000000000000000000000000000000000a4";
const base = {
  RELEASE_NETWORK: "mainnet", GENESIS_CLAIM_ENABLED: "true", GENESIS_CLAIM_CONTRACT: RECOVERY,
  GENESIS_CLAIM_RELEASE_CONTRACT: RELEASE, GENESIS_CLAIM_PRIMARY_SALE: SALE, GENESIS_CLAIM_TOKEN_ID: "1",
  GENESIS_CLAIM_ALLOCATION: "0", GENESIS_PUBLIC_MINT_ALLOCATION: "0", GENESIS_CLAIM_START: "1794000000",
  GENESIS_CLAIM_WINDOW_SECONDS: "86400", GENESIS_PUBLIC_WINDOW_SECONDS: "691200", GENESIS_PUBLIC_PRICE_WEI: "250000000000000000",
  GENESIS_RPC_URL: "https://genesis.example/rpc", GENESIS_DESTINATION_RPC_URL: "https://destination.example/rpc",
  GENESIS_CLAIM_SIGNER_PRIVATE_KEY: signerKey, GENESIS_CLAIM_SIGNER_ADDRESS: signer,
};

describe("Genesis recovery configuration", () => {
  it("keeps the live sale schedule independent from the recovery claim window", () => {
    const config = loadGenesisClaimConfig({
      ...base, GENESIS_CLAIM_RECOVERY: "true", GENESIS_PUBLIC_SALE_START: "1793019600", GENESIS_PUBLIC_SALE_END: "1793710799",
      GENESIS_CLAIM_LEDGER_CONTRACTS: `${OLD},${RECOVERY}`,
    });
    expect(config).toMatchObject({ recoveryMode: true, claimStart: 1794000000n, claimEnd: 1794086400n, publicSaleStart: 1793019600n, publicSaleEnd: 1793710799n, publicWindow: 691200n });
    expect(config.ledgerContracts.map((address) => address.toLowerCase())).toEqual([OLD, RECOVERY]);
  });

  it("rejects a recovery sale window whose endpoints do not match its declared duration", () => {
    expect(() => loadGenesisClaimConfig({
      ...base, GENESIS_CLAIM_RECOVERY: "true", GENESIS_PUBLIC_SALE_START: "1793019600", GENESIS_PUBLIC_SALE_END: "1793710798",
    })).toThrow(/public sale window/);
  });
});

describe("Genesis recovery reservation alias", () => {
  it("lists historical reservations and writes new reservations under the recovery contract", async () => {
    const store = createMemoryGenesisClaimReservationStore({ ledgerContracts: [OLD, RECOVERY] });
    const wallet = "0x00000000000000000000000000000000000000b1";
    await store.withLock(OLD, (tx) => tx.upsert({ claimContract: OLD, wallet, block: 1, usedTokenId: "0", balances: [1, 0, 0, 0], deadline: 10n, status: "REDEEMED", voucher: {}, signature: "0x" }));
    const rows = await store.withLock(RECOVERY, (tx) => tx.list());
    expect(rows).toHaveLength(1);
    expect(rows[0].wallet.toLowerCase()).toBe(wallet);
    await store.withLock(RECOVERY, (tx) => tx.upsert({ claimContract: RECOVERY, wallet: "0x00000000000000000000000000000000000000b2", block: 2, usedTokenId: "1", balances: [0, 1, 0, 0], deadline: 20n, status: "PENDING", voucher: {}, signature: "0x" }));
    expect(store.rows.size).toBe(2);
  });
});

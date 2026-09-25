import { describe, expect, it, vi } from "vitest";
import { Wallet } from "ethers";
import { ContractOwnerVerificationService, createClaimMessage, verifyPersonalSign } from "./contract-owner-verification.js";
import { LEGACY_CONTRACT, LEGACY_CHAIN_ID } from "../src/lib/legacy-genesis.js";

const owner = Wallet.createRandom();
const other = Wallet.createRandom();
const slug = "voidcaller";

function harness({ rows = [], updateRows = [{ nonce: "n" }], insert = true, ownerAddress = owner.address, now = new Date("2026-09-25T16:00:00.000Z") } = {}) {
  const db = {
    query: vi.fn(async (sql) => {
      const text = String(sql);
      if (text.includes("FROM artist_contract_verifications") && text.includes("SELECT wallet_address")) return { rows };
      if (text.includes("FROM artist_contract_verifications") && text.includes("SELECT id")) return { rows: [] };
      if (text.includes("INSERT INTO artist_contract_verify_challenges")) return { rows: [] };
      if (text.includes("FROM artist_contract_verify_challenges")) return { rows };
      if (text.includes("UPDATE artist_contract_verify_challenges")) return { rows: updateRows };
      if (text.includes("INSERT INTO artist_contract_verifications")) return { rows: insert ? [{ id: "id-1" }] : [] };
      return { rows: [] };
    }),
  };
  const ownerReader = { ownerOf: vi.fn(async () => ownerAddress) };
  const service = new ContractOwnerVerificationService({
    db,
    config: { mainnetRpcUrl: "https://api.avax.network/ext/bc/C/rpc" },
    ownerReader,
    now: () => now,
  });
  return { db, service, ownerReader };
}

describe("contract owner claim", () => {
  it("persists challenges in the database instead of memory", async () => {
    const { service, db } = harness();
    const challenge = await service.createChallenge({ slug });
    expect(challenge.expiresAt).toBe("2026-09-25T16:10:00.000Z");
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO artist_contract_verify_challenges"), expect.arrayContaining([challenge.nonce, slug, LEGACY_CONTRACT, LEGACY_CHAIN_ID]));
  });

  it("accepts a valid personal_sign from the live owner()", async () => {
    const expiresAt = "2026-09-25T16:10:00.000Z";
    const nonce = "abcdefghijklmnopqrstuvwxyz0123456789ABCD";
    const message = createClaimMessage({ slug, contract: LEGACY_CONTRACT, chainId: LEGACY_CHAIN_ID, nonce, expiresAt });
    const signature = await owner.signMessage(message);
    expect(verifyPersonalSign({ address: owner.address, message, signature })).toBe(true);
    const { service, ownerReader } = harness({ rows: [{ nonce, message, expires_at: expiresAt, used_at: null }] });
    await expect(service.verifyClaim({ slug, address: owner.address, signature })).resolves.toMatchObject({
      verified: true,
      wallet: owner.address.toLowerCase(),
      chainId: 43114,
      contract: LEGACY_CONTRACT,
    });
    expect(ownerReader.ownerOf).toHaveBeenCalledWith(LEGACY_CONTRACT);
  });

  it("rejects a signer who is not owner()", async () => {
    const expiresAt = "2026-09-25T16:10:00.000Z";
    const nonce = "abcdefghijklmnopqrstuvwxyz0123456789ABCD";
    const message = createClaimMessage({ slug, contract: LEGACY_CONTRACT, chainId: LEGACY_CHAIN_ID, nonce, expiresAt });
    const signature = await other.signMessage(message);
    const { service } = harness({ rows: [{ nonce, message, expires_at: expiresAt, used_at: null }] });
    await expect(service.verifyClaim({ slug, address: other.address, signature })).rejects.toMatchObject({ code: "NOT_CONTRACT_OWNER", status: 403 });
  });

  it("rejects a reused nonce", async () => {
    const expiresAt = "2026-09-25T16:10:00.000Z";
    const nonce = "abcdefghijklmnopqrstuvwxyz0123456789ABCD";
    const message = createClaimMessage({ slug, contract: LEGACY_CONTRACT, chainId: LEGACY_CHAIN_ID, nonce, expiresAt });
    const signature = await owner.signMessage(message);
    const { service } = harness({ rows: [{ nonce, message, expires_at: expiresAt, used_at: null }], updateRows: [] });
    await expect(service.verifyClaim({ slug, address: owner.address, signature })).rejects.toMatchObject({ code: "NONCE_REUSED", status: 409 });
  });

  it("rejects an expired nonce", async () => {
    const expiresAt = "2026-09-25T15:00:00.000Z";
    const nonce = "abcdefghijklmnopqrstuvwxyz0123456789ABCD";
    const message = createClaimMessage({ slug, contract: LEGACY_CONTRACT, chainId: LEGACY_CHAIN_ID, nonce, expiresAt });
    const signature = await owner.signMessage(message);
    const { service } = harness({ rows: [{ nonce, message, expires_at: expiresAt, used_at: null }], now: new Date("2026-09-25T16:00:00.000Z") });
    await expect(service.verifyClaim({ slug, address: owner.address, signature })).rejects.toMatchObject({ code: "CHALLENGE_EXPIRED", status: 401 });
  });

  it("fails closed when owner() RPC errors", async () => {
    const expiresAt = "2026-09-25T16:10:00.000Z";
    const nonce = "abcdefghijklmnopqrstuvwxyz0123456789ABCD";
    const message = createClaimMessage({ slug, contract: LEGACY_CONTRACT, chainId: LEGACY_CHAIN_ID, nonce, expiresAt });
    const signature = await owner.signMessage(message);
    const { service } = harness({ rows: [{ nonce, message, expires_at: expiresAt, used_at: null }] });
    service.ownerReader.ownerOf = vi.fn(async () => { throw Object.assign(new Error("rpc"), { code: "MAINNET_RPC_UNAVAILABLE", status: 503 }); });
    await expect(service.verifyClaim({ slug, address: owner.address, signature })).rejects.toMatchObject({ code: "MAINNET_RPC_UNAVAILABLE", status: 503 });
  });

  it("exposes a badge payload only when a verification record exists", async () => {
    const empty = harness({ rows: [] });
    await expect(empty.service.getStatus({ slug })).resolves.toMatchObject({ verified: false, snowtrace: expect.stringContaining(LEGACY_CONTRACT) });
    const filled = harness({ rows: [{ wallet_address: owner.address.toLowerCase(), contract_address: LEGACY_CONTRACT, chain_id: 43114, verified_at: "2026-09-25T16:01:00.000Z" }] });
    await expect(filled.service.getStatus({ slug })).resolves.toMatchObject({ verified: true, wallet: owner.address.toLowerCase() });
  });
});

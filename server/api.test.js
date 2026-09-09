import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { createApiHandler } from "./api-http.js";
import { ApiError } from "./api-errors.js";
import { createRateLimiter } from "./api-runtime.js";
import { ApiService } from "./api-service.js";

const wallet = "0xd1b4367dd9f235f9ee61878019d66e31511e98ee";
const seller = "0x1111111111111111111111111111111111111111";
const marketplace = "0x2222222222222222222222222222222222222222";
const transactionHash = `0x${"a".repeat(64)}`;

function responseDouble() {
  return { headers: null, status: null, body: "", writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
}

function requestDouble({ method = "GET", url = "/api/health", body = "", headers = {} } = {}) {
  return { method, url, headers, socket: { remoteAddress: "127.0.0.1" }, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(body); } };
}

describe("HTTP API boundary", () => {
  it("returns a stable health response with a request id", async () => {
    const handler = createApiHandler({ service: {} });
    const response = responseDouble();
    await handler(requestDouble(), response);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).data.ok).toBe(true);
    expect(JSON.parse(response.body).requestId).toBeTruthy();
  });

  it("reports readiness separately from process liveness", async () => {
    const handler = createApiHandler({ service: { getOperationalHealth: vi.fn().mockResolvedValue({ ok: false, database: { ok: true }, indexer: { ok: false, reason: "INDEXER_UNAVAILABLE" } }) } });
    const response = responseDouble();
    await handler(requestDouble({ url: "/api/health/ready" }), response);
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body).data.indexer.reason).toBe("INDEXER_UNAVAILABLE");
  });

  it("allows only configured browser origins to make authenticated API requests", async () => {
    const handler = createApiHandler({ service: {}, allowedOrigins: ["https://app.voidcaller.example"] });
    const allowed = responseDouble();
    await handler(requestDouble({ headers: { origin: "https://app.voidcaller.example" } }), allowed);
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://app.voidcaller.example");
    const denied = responseDouble();
    await handler(requestDouble({ method: "OPTIONS", headers: { origin: "https://attacker.example" } }), denied);
    expect(denied.status).toBe(403);
  });

  it("returns consistent JSON for malformed request bodies", async () => {
    const handler = createApiHandler({ service: { createListing: vi.fn() } });
    const response = responseDouble();
    await handler(requestDouble({ method: "POST", url: "/api/listings", body: "not-json" }), response);
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe("INVALID_JSON");
  });

  it("exposes challenge and verification only through a configured auth service", async () => {
    const authService = { createChallenge: vi.fn().mockResolvedValue({ nonce: "public-nonce", message: "message" }), verifyChallenge: vi.fn().mockResolvedValue({ token: "opaque-session" }) };
    const handler = createApiHandler({ service: {}, authService });
    const nonceResponse = responseDouble();
    await handler(requestDouble({ method: "POST", url: "/api/auth/nonce", body: JSON.stringify({ wallet, chainId: 43113 }) }), nonceResponse);
    expect(nonceResponse.status).toBe(200);
    expect(authService.createChallenge).toHaveBeenCalledWith(expect.objectContaining({ wallet, chainId: 43113, requestId: expect.any(String) }));

    const verifyResponse = responseDouble();
    await handler(requestDouble({ method: "POST", url: "/api/auth/verify", body: JSON.stringify({ wallet, chainId: 43113, nonce: "public-nonce", message: "message", signature: "signature" }) }), verifyResponse);
    expect(verifyResponse.status).toBe(200);
    expect(authService.verifyChallenge).toHaveBeenCalledWith(expect.objectContaining({ nonce: "public-nonce", signature: "signature" }));

    const unavailable = createApiHandler({ service: {} });
    const unavailableResponse = responseDouble();
    await unavailable(requestDouble({ method: "POST", url: "/api/auth/nonce", body: "{}" }), unavailableResponse);
    expect(unavailableResponse.status).toBe(503);
    expect(JSON.parse(unavailableResponse.body).error.code).toBe("AUTH_UNAVAILABLE");
  });

  it("exposes persisted indexer health without treating it as API liveness", async () => {
    const service = { getIndexerHealth: vi.fn().mockResolvedValue([{ chain_id: 43114, current_indexed_block: "100", latest_known_block: "104", finalized_block: "92", indexer_lag: "4", rpc_failures: "2", database_failures: "1", last_error: "temporary RPC failure" }]) };
    const handler = createApiHandler({ service });
    const response = responseDouble();
    await handler(requestDouble({ method: "GET", url: "/api/indexer/health?chainId=43114" }), response);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).data[0]).toMatchObject({ current_indexed_block: "100", indexer_lag: "4", last_error: "temporary RPC failure" });
    expect(service.getIndexerHealth).toHaveBeenCalledWith({ chainId: "43114" });
  });

  it("routes Artist Studio writes only through the configured service", async () => {
    const studioService = { createArtist: vi.fn().mockResolvedValue({ id: "artist-1" }) };
    const handler = createApiHandler({ service: {}, studioService });
    const response = responseDouble();
    await handler(requestDouble({ method: "POST", url: "/api/studio/artists", body: JSON.stringify({ name: "Voidcaller" }) }), response);
    expect(response.status).toBe(200);
    expect(studioService.createArtist).toHaveBeenCalledWith(expect.objectContaining({ input: { name: "Voidcaller" }, request: expect.objectContaining({ requestId: expect.any(String) }) }));

    const unavailable = createApiHandler({ service: {} });
    const unavailableResponse = responseDouble();
    await unavailable(requestDouble({ method: "POST", url: "/api/studio/artists", body: "{}" }), unavailableResponse);
    expect(unavailableResponse.status).toBe(503);
    expect(JSON.parse(unavailableResponse.body).error.code).toBe("ARTIST_STUDIO_UNAVAILABLE");
  });
});

describe("API service trust boundaries", () => {
  it("does not trust browser seller identity and leaves listing state pending", async () => {
    const repository = { upsertTransaction: vi.fn().mockResolvedValue({ status: "SUBMITTED", transaction_hash: "0xlisting" }) };
    const service = new ApiService({ db: { query: vi.fn().mockResolvedValue({ rows: [{ id: "marketplace-contract", address: marketplace }] }) }, repository, authenticator: () => ({ wallet }) });
    await expect(service.createListing({ request: {}, input: { sellerWallet: seller, chainId: 43114, transactionHash, marketplaceAddress: marketplace } })).rejects.toMatchObject({ code: "WALLET_MISMATCH" });
    const result = await service.createListing({ request: {}, input: { sellerWallet: wallet, chainId: 43114, transactionHash, marketplaceAddress: marketplace } });
    expect(result.state).toBe("PENDING");
    expect(repository.upsertTransaction).toHaveBeenCalledWith(expect.objectContaining({ status: "SUBMITTED", transactionType: "LISTING_CREATE" }));
  });

  it("creates an idempotent purchase intent from the persisted listing price", async () => {
    const db = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "listing-1", chain_id: 43114, status: "ACTIVE", price_wei: "7", remaining_amount: "3", marketplace_address: marketplace }] })
      .mockResolvedValueOnce({ rows: [{ id: "tx-1", status: "PENDING", value_wei: "14" }] }) };
    const service = new ApiService({ db, repository: {}, authenticator: () => ({ wallet }) });
    const result = await service.createPurchaseIntent({ request: {}, input: { buyerWallet: wallet, listingId: "listing-1", quantity: "2", idempotencyKey: "purchase-1", marketplaceAddress: marketplace } });
    expect(result.state).toBe("PENDING");
    expect(result.paymentWei).toBe("14");
    expect(db.query).toHaveBeenLastCalledWith(expect.stringContaining("INSERT INTO transactions"), [43114, "intent:purchase-1", "purchase-1", wallet, marketplace, "14"]);
  });

  it("refuses to claim purchase confirmation without a blockchain verifier", async () => {
    const service = new ApiService({ db: { query: vi.fn() }, repository: {}, authenticator: () => ({ wallet }) });
    await expect(service.verifyPurchase({ request: {}, input: { buyerWallet: wallet, chainId: 43114, transactionHash, listingId: "listing-1", marketplaceAddress: marketplace } })).rejects.toMatchObject({ code: "BLOCKCHAIN_VERIFIER_NOT_CONFIGURED", status: 501 });
  });

  it("records failed purchase verification without creating a completed purchase", async () => {
    const repository = { upsertTransaction: vi.fn().mockResolvedValue({ id: "tx-failed", status: "FAILED" }) };
    const service = new ApiService({ db: { query: vi.fn() }, repository, authenticator: () => ({ wallet }), blockchainVerifier: vi.fn().mockResolvedValue({ state: "FAILED" }) });
    await expect(service.verifyPurchase({ request: {}, input: { buyerWallet: wallet, chainId: 43114, transactionHash, listingId: "listing-1", marketplaceAddress: marketplace } })).resolves.toMatchObject({ state: "FAILED" });
    expect(repository.upsertTransaction).toHaveBeenCalledWith(expect.objectContaining({ status: "FAILED", transactionType: "PURCHASE" }));
  });

  it("records a purchase only after authoritative settlement validates all indexed fields", async () => {
    const blockHash = `0x${"b".repeat(64)}`;
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ id: "listing-1", chain_id: 43114, seller_wallet: seller, marketplace_address: marketplace, token_contract_address: seller, token_id: "9", price_wei: "7", remaining_amount: "3", currency: "native" }] }) };
    const repository = { upsertTransaction: vi.fn().mockResolvedValue({ id: "purchase-tx", status: "FINALIZED" }), recordPurchase: vi.fn().mockResolvedValue({ id: "purchase-1", status: "FINALIZED" }) };
    const verification = { state: "FINALIZED", buyer: wallet, seller, marketplaceAddress: marketplace, tokenContractAddress: seller, tokenId: "9", quantity: "2", salePriceWei: "14", platformFeeWei: "1", royaltyWei: "1", currency: "native", blockNumber: 100, blockHash, logIndex: 7 };
    const service = new ApiService({ db, repository, authenticator: () => ({ wallet }), blockchainVerifier: vi.fn().mockResolvedValue(verification) });
    await expect(service.verifyPurchase({ request: {}, input: { buyerWallet: wallet, chainId: 43114, transactionHash, listingId: "listing-1", marketplaceAddress: marketplace } })).resolves.toMatchObject({ state: "FINALIZED", purchase: { id: "purchase-1" } });
    expect(repository.recordPurchase).toHaveBeenCalledWith(expect.objectContaining({ buyerWallet: wallet, sellerWallet: seller, tokenContractAddress: seller, tokenId: "9", quantity: "2", salePriceWei: "14", platformFeeWei: "1", royaltyWei: "1", blockNumber: "100", blockHash, settlementLogIndex: 7 }));

    const invalid = new ApiService({ db, repository, authenticator: () => ({ wallet }), blockchainVerifier: vi.fn().mockResolvedValue({ ...verification, salePriceWei: "13" }) });
    await expect(invalid.verifyPurchase({ request: {}, input: { buyerWallet: wallet, chainId: 43114, transactionHash, listingId: "listing-1", marketplaceAddress: marketplace } })).rejects.toMatchObject({ code: "SETTLEMENT_MISMATCH" });
    expect(repository.recordPurchase).toHaveBeenCalledTimes(1);
  });

  it("rate-limits repeated API calls through the injectable hook", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: () => 1 });
    expect(limiter.check("wallet").allowed).toBe(true);
    expect(() => limiter.check("wallet")).toThrow(ApiError);
  });
});

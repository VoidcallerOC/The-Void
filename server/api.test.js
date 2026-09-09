import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { createApiHandler } from "./api-http.js";
import { ApiError } from "./api-errors.js";
import { createRateLimiter } from "./api-runtime.js";
import { ApiService } from "./api-service.js";

const wallet = "0xd1b4367dd9f235f9ee61878019d66e31511e98ee";
const seller = "0x1111111111111111111111111111111111111111";

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

  it("returns consistent JSON for malformed request bodies", async () => {
    const handler = createApiHandler({ service: { createListing: vi.fn() } });
    const response = responseDouble();
    await handler(requestDouble({ method: "POST", url: "/api/listings", body: "not-json" }), response);
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe("INVALID_JSON");
  });
});

describe("API service trust boundaries", () => {
  it("does not trust browser seller identity and leaves listing state pending", async () => {
    const repository = { upsertTransaction: vi.fn().mockResolvedValue({ status: "SUBMITTED", transaction_hash: "0xlisting" }) };
    const service = new ApiService({ db: { query: vi.fn() }, repository, authenticator: () => ({ wallet }) });
    await expect(service.createListing({ request: {}, input: { sellerWallet: seller, chainId: 43114, transactionHash: "0xlisting", marketplaceAddress: seller } })).rejects.toMatchObject({ code: "WALLET_MISMATCH" });
    const result = await service.createListing({ request: {}, input: { sellerWallet: wallet, chainId: 43114, transactionHash: "0xlisting", marketplaceAddress: seller } });
    expect(result.state).toBe("PENDING");
    expect(repository.upsertTransaction).toHaveBeenCalledWith(expect.objectContaining({ status: "SUBMITTED", transactionType: "LISTING_CREATE" }));
  });

  it("creates an idempotent purchase intent from the persisted listing price", async () => {
    const db = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "listing-1", chain_id: 43114, status: "ACTIVE", price_wei: "7", remaining_amount: "3" }] })
      .mockResolvedValueOnce({ rows: [{ id: "tx-1", status: "SUBMITTED", value_wei: "14" }] }) };
    const service = new ApiService({ db, repository: {}, authenticator: () => ({ wallet }) });
    const result = await service.createPurchaseIntent({ request: {}, input: { buyerWallet: wallet, listingId: "listing-1", quantity: "2", idempotencyKey: "purchase-1", marketplaceAddress: seller } });
    expect(result.state).toBe("PENDING");
    expect(result.paymentWei).toBe("14");
    expect(db.query).toHaveBeenLastCalledWith(expect.stringContaining("INSERT INTO transactions"), [43114, "intent:purchase-1", "purchase-1", wallet, seller, "14"]);
  });

  it("refuses to claim purchase confirmation without a blockchain verifier", async () => {
    const service = new ApiService({ db: { query: vi.fn() }, repository: {}, authenticator: () => ({ wallet }) });
    await expect(service.verifyPurchase({ request: {}, input: { buyerWallet: wallet, chainId: 43114, transactionHash: "0xbuy", listingId: "listing-1", marketplaceAddress: seller } })).rejects.toMatchObject({ code: "BLOCKCHAIN_VERIFIER_NOT_CONFIGURED", status: 501 });
  });

  it("rate-limits repeated API calls through the injectable hook", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: () => 1 });
    expect(limiter.check("wallet").allowed).toBe(true);
    expect(() => limiter.check("wallet")).toThrow(ApiError);
  });
});

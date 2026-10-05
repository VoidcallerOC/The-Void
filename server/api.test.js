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

  it("serves only configured claim targets and routes eligibility and voucher requests", async () => {
    const genesisClaim = {
      config: { enabled: true, genesisChainId: 43114, destinationChainId: 43113, releaseContract: seller, tokenId: "77" },
      verifyContractBindings: vi.fn().mockResolvedValue(undefined),
      checkEligibility: vi.fn().mockResolvedValue({ eligible: true, eligibleTokenIds: ["2"] }),
      issueVoucher: vi.fn().mockResolvedValue({ voucher: { claimant: wallet, quantity: "1" }, signature: "0xsignature" }),
    };
    const handler = createApiHandler({ service: {}, genesisClaim });

    const configResponse = responseDouble();
    await handler(requestDouble({ url: "/api/claims/config" }), configResponse);
    expect(configResponse.status).toBe(200);
    expect(JSON.parse(configResponse.body).data).toEqual(genesisClaim.config);
    expect(genesisClaim.verifyContractBindings).toHaveBeenCalledOnce();

    const eligibilityResponse = responseDouble();
    await handler(requestDouble({ method: "POST", url: "/api/claims/eligibility", body: JSON.stringify({ wallet }) }), eligibilityResponse);
    expect(eligibilityResponse.status).toBe(200);
    expect(JSON.parse(eligibilityResponse.body).data).toEqual({ eligible: true, eligibleTokenIds: ["2"] });
    expect(genesisClaim.checkEligibility).toHaveBeenCalledWith(wallet);

    const voucherResponse = responseDouble();
    await handler(requestDouble({ method: "POST", url: "/api/claims/vouchers", body: JSON.stringify({ wallet }) }), voucherResponse);
    expect(voucherResponse.status).toBe(200);
    expect(JSON.parse(voucherResponse.body).data).toMatchObject({ voucher: { claimant: wallet, quantity: "1" }, signature: "0xsignature" });
    expect(genesisClaim.issueVoucher).toHaveBeenCalledWith(wallet);

    const unavailable = createApiHandler({ service: {} });
    const unavailableResponse = responseDouble();
    await unavailable(requestDouble({ url: "/api/claims/config" }), unavailableResponse);
    expect(unavailableResponse.status).toBe(503);
    expect(JSON.parse(unavailableResponse.body).error.code).toBe("CLAIM_UNAVAILABLE");
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

  it("routes the authoritative aggregate Marketplace volume read", async () => {
    const service = { getMarketplaceVolume: vi.fn().mockResolvedValue({ currency: "AVAX", primaryMintVolumeWei: "10", secondaryMarketVolumeWei: "20", overallVolumeWei: "30" }) };
    const handler = createApiHandler({ service });
    const response = responseDouble();
    await handler(requestDouble({ url: "/api/marketplace/volume" }), response);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).data).toMatchObject({ currency: "AVAX", overallVolumeWei: "30" });
    expect(service.getMarketplaceVolume).toHaveBeenCalledOnce();
  });

  it("routes Main-page volume through the canonical Fuji VOIDCALLER scope without changing the global route", async () => {
    const service = { getSelfTitledEpVolume: vi.fn().mockResolvedValue({ currency: "AVAX", overallVolumeWei: "7" }), getMarketplaceVolume: vi.fn() };
    const handler = createApiHandler({ service });
    const response = responseDouble();
    await handler(requestDouble({ url: "/api/marketplace/volume/self-titled-ep?chainId=43113&tokenContractAddress=0x82b26Da27136935454Bdf1e40801190B521b82e5&tokenIds=33778802922810732976408591241428358474475553907731009337085064305512658576739" }), response);
    expect(response.status).toBe(200);
    expect(service.getSelfTitledEpVolume).toHaveBeenCalledWith({ chainId: "43113", tokenContractAddress: "0x82b26Da27136935454Bdf1e40801190B521b82e5", tokenIds: ["33778802922810732976408591241428358474475553907731009337085064305512658576739"] });
    expect(service.getMarketplaceVolume).not.toHaveBeenCalled();
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

  it("routes artwork uploads to the artist's artwork endpoint", async () => {
    const studioService = { uploadArtwork: vi.fn().mockResolvedValue({ uri: "ipfs://bafyart", contentType: "image/png", byteSize: 4 }) };
    const handler = createApiHandler({ service: {}, studioService });
    const response = responseDouble();
    await handler(requestDouble({ method: "POST", url: "/api/studio/artists/artist-1/artwork", body: JSON.stringify({ data: "iVBORw==" }), headers: { authorization: "Bearer opaque" } }), response);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).data).toEqual({ uri: "ipfs://bafyart", contentType: "image/png", byteSize: 4 });
    expect(studioService.uploadArtwork).toHaveBeenCalledWith(expect.objectContaining({ artistId: "artist-1", input: { data: "iVBORw==" } }));
  });

  it("routes public preview uploads to the artist's audio-preview endpoint", async () => {
    const studioService = { uploadTrackPreview: vi.fn().mockResolvedValue({ uri: "ipfs://bafyaudio", contentType: "audio/mpeg", byteSize: 5 }) };
    const handler = createApiHandler({ service: {}, studioService });
    const response = responseDouble();
    await handler(requestDouble({ method: "POST", url: "/api/studio/artists/artist-1/audio-preview", body: JSON.stringify({ data: "SUQz" }), headers: { authorization: "Bearer opaque" } }), response);
    expect(response.status).toBe(200);
    expect(studioService.uploadTrackPreview).toHaveBeenCalledWith(expect.objectContaining({ artistId: "artist-1", input: { data: "SUQz" } }));
  });

  it("routes metadata publication to the canonical Studio endpoint and rejects obsolete paths", async () => {
    const studioService = { publishMetadata: vi.fn().mockResolvedValue({ releaseId: "release-a", metadataUri: "ipfs://cid" }) };
    const handler = createApiHandler({ service: {}, studioService });
    const response = responseDouble();
    await handler(requestDouble({ method: "POST", url: "/api/studio/releases/release-a/metadata", body: JSON.stringify({ releaseType: "EP" }), headers: { authorization: "Bearer opaque" } }), response);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).data).toEqual({ releaseId: "release-a", metadataUri: "ipfs://cid" });
    expect(studioService.publishMetadata).toHaveBeenCalledWith(expect.objectContaining({ releaseId: "release-a", input: { releaseType: "EP" } }));

    const missing = responseDouble();
    await handler(requestDouble({ method: "POST", url: "/api/studio/releases/release-a/obsolete", body: "{}" }), missing);
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body).error.code).toBe("NOT_FOUND");
  });

  it("routes artist verification through the configured service and stays fail-closed without it", async () => {
    const verificationService = {
      getMine: vi.fn().mockResolvedValue({ application: null, canReapply: true, reviewer: false }),
      submit: vi.fn().mockResolvedValue({ publicId: "va_1", status: "SUBMITTED", artistName: "Voidcaller" }),
      listVerified: vi.fn().mockResolvedValue([]),
    };
    const handler = createApiHandler({ service: {}, verificationService });
    const me = responseDouble();
    await handler(requestDouble({ method: "GET", url: "/api/verification/me", headers: { authorization: "Bearer opaque" } }), me);
    expect(me.status).toBe(200);
    expect(verificationService.getMine).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({ requestId: expect.any(String) }) }));

    const publicList = responseDouble();
    await handler(requestDouble({ method: "GET", url: "/api/verification/artists" }), publicList);
    expect(publicList.status).toBe(200);
    expect(verificationService.listVerified).toHaveBeenCalled();

    const submit = responseDouble();
    await handler(requestDouble({ method: "POST", url: "/api/verification/applications", body: JSON.stringify({ artistName: "Voidcaller" }), headers: { authorization: "Bearer opaque" } }), submit);
    expect(submit.status).toBe(200);
    expect(verificationService.submit).toHaveBeenCalledWith(expect.objectContaining({ input: { artistName: "Voidcaller" } }));

    const unavailable = createApiHandler({ service: {} });
    const unavailableResponse = responseDouble();
    await unavailable(requestDouble({ method: "GET", url: "/api/verification/me" }), unavailableResponse);
    expect(unavailableResponse.status).toBe(503);
    expect(JSON.parse(unavailableResponse.body).error.code).toBe("VERIFICATION_UNAVAILABLE");
  });
});

describe("reviewer notification count route", () => {
  it("routes GET /api/verification/review/count to the reviewer count, not the application lookup", async () => {
    const verificationService = {
      countReviewQueue: vi.fn().mockResolvedValue({ count: 3 }),
      getReviewApplication: vi.fn(),
    };
    const handler = createApiHandler({ service: {}, verificationService });
    const response = responseDouble();
    await handler(requestDouble({ method: "GET", url: "/api/verification/review/count", headers: { authorization: "Bearer opaque" } }), response);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).data).toEqual({ count: 3 });
    expect(verificationService.countReviewQueue).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer opaque" }) }) }));
    expect(verificationService.getReviewApplication).not.toHaveBeenCalled();
  });

  it("returns 403 REVIEWER_REQUIRED from the count route for unauthorized wallets", async () => {
    const verificationService = {
      countReviewQueue: vi.fn().mockRejectedValue(new ApiError(403, "REVIEWER_REQUIRED", "This wallet is not authorized to review artist verification applications.")),
    };
    const handler = createApiHandler({ service: {}, verificationService });
    const response = responseDouble();
    await handler(requestDouble({ method: "GET", url: "/api/verification/review/count", headers: { authorization: "Bearer opaque" } }), response);
    expect(response.status).toBe(403);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("REVIEWER_REQUIRED");
    expect(body.data).toBeUndefined();
  });
});

describe("API service trust boundaries", () => {
  it("returns primary purchase evidence from the transaction endpoint", async () => {
    const primaryPurchase = {
      status: "CONFIRMED",
      tokenId: "123",
      editionId: "edition-1",
      quantity: "1",
      priceWei: "10000000000000000",
      purchaser: wallet,
    };
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ id: "tx-1", transaction_hash: transactionHash, purchases: [], primaryPurchases: [primaryPurchase] }] }) };
    const service = new ApiService({ db, repository: {} });
    await expect(service.getMarketplaceTransaction({ chainId: 43113, transactionHash })).resolves.toMatchObject({ primaryPurchases: [primaryPurchase] });
    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/FROM primary_purchases pp/i);
    expect(sql).toMatch(/pp\.paid_wei/i);
    expect(sql).toMatch(/LEFT JOIN editions e/i);
    expect(sql).toMatch(/AS "primaryPurchases"/i);
  });

  it("aggregates indexed primary and secondary monetary volume while excluding non-public catalog rows", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ primary_mint_volume_wei: "100", secondary_market_volume_wei: "250", overall_volume_wei: "350" }] }) };
    const service = new ApiService({ db, repository: {} });
    await expect(service.getMarketplaceVolume()).resolves.toEqual({
      currency: "AVAX",
      primaryMintVolumeWei: "100",
      secondaryMarketVolumeWei: "250",
      overallVolumeWei: "350",
      secondaryMarkets: "indexed marketplace contracts",
    });
    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/FROM primary_purchases pp/i);
    expect(sql).toMatch(/SUM\(pp\.paid_wei\)/i);
    expect(sql).toMatch(/FROM purchases p/i);
    expect(sql).toMatch(/SUM\(p\.sale_price_wei\)/i);
    expect(sql).toMatch(/status IN \('CONFIRMED', 'FINALIZED', 'RECONCILED'\)/i);
    expect(sql).toMatch(/e\.status='PUBLISHED'[\s\S]*r\.status='PUBLISHED'[\s\S]*a\.status='ACTIVE'/i);
    expect(sql).toMatch(/mc\.contract_type='MARKETPLACE'/i);
  });

  it("scopes Main-page volume to the requested Fuji VOIDCALLER token identity", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ primary_mint_volume_wei: "100", secondary_market_volume_wei: "250", overall_volume_wei: "350" }] }) };
    const service = new ApiService({ db, repository: {} });
    const fujiTokenContract = "0x82b26Da27136935454Bdf1e40801190B521b82e5";
    const fujiTokenId = "33778802922810732976408591241428358474475553907731009337085064305512658576739";
    await expect(service.getSelfTitledEpVolume({ chainId: "43113", tokenContractAddress: fujiTokenContract, tokenIds: [fujiTokenId] })).resolves.toMatchObject({ overallVolumeWei: "350" });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/tc\.chain_id=\$1/i);
    expect(sql).toMatch(/LOWER\(tc\.address\)=LOWER\(\$2\)/i);
    expect(sql).toMatch(/tok\.token_id = ANY\(\$3::numeric\[\]\)/i);
    expect(params).toEqual([43113, fujiTokenContract.toLowerCase(), [fujiTokenId]]);
  });

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

describe("marketplace hero file route", () => {
  it("serves a stored header image without JSON wrapping", async () => {
    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const marketplacePresentation = { openHero: vi.fn().mockResolvedValue({ body, contentType: "image/png", filename: "marketplace-hero-0123456789abcdef.png" }) };
    const handler = createApiHandler({ service: {}, marketplacePresentation });
    const response = responseDouble();
    await handler(requestDouble({ url: "/api/marketplace/heroes/marketplace-hero-0123456789abcdef.png" }), response);
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.compare(response.body, body)).toBe(0);
    expect(marketplacePresentation.openHero).toHaveBeenCalledWith({ filename: "marketplace-hero-0123456789abcdef.png" });
  });

  it("returns not found when the header file is missing", async () => {
    const marketplacePresentation = { openHero: vi.fn().mockRejectedValue(new ApiError(404, "HERO_FILE_NOT_FOUND", "Marketplace hero file was not found.")) };
    const handler = createApiHandler({ service: {}, marketplacePresentation });
    const response = responseDouble();
    await handler(requestDouble({ url: "/api/marketplace/heroes/nope.png" }), response);
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body).error.code).toBe("HERO_FILE_NOT_FOUND");
  });
});

describe("artist portfolio file route", () => {
  it("serves a stored profile image without JSON wrapping", async () => {
    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const studioService = { openPortfolioImage: vi.fn().mockResolvedValue({ body, contentType: "image/png", filename: "artist-portfolio-0123456789abcdef.png" }) };
    const handler = createApiHandler({ service: {}, studioService });
    const response = responseDouble();
    await handler(requestDouble({ url: "/api/artists/portfolio/artist-portfolio-0123456789abcdef.png" }), response);
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.compare(response.body, body)).toBe(0);
    expect(studioService.openPortfolioImage).toHaveBeenCalledWith({ filename: "artist-portfolio-0123456789abcdef.png" });
  });

  it("returns not found when the portfolio file is missing", async () => {
    const studioService = { openPortfolioImage: vi.fn().mockRejectedValue(new ApiError(404, "PORTFOLIO_FILE_NOT_FOUND", "Artist portfolio image was not found.")) };
    const handler = createApiHandler({ service: {}, studioService });
    const response = responseDouble();
    await handler(requestDouble({ url: "/api/artists/portfolio/nope.png" }), response);
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body).error.code).toBe("PORTFOLIO_FILE_NOT_FOUND");
  });

  it("posts a portfolio upload to the studio service and not the release artwork uploader", async () => {
    const studioService = { uploadPortfolioImage: vi.fn().mockResolvedValue({ uri: "/assets/artist-portfolio/artist-portfolio-0123456789abcdef.png" }), uploadArtwork: vi.fn() };
    const handler = createApiHandler({ service: {}, studioService });
    const response = responseDouble();
    await handler(requestDouble({ method: "POST", url: "/api/studio/artists/artist-1/portfolio", body: JSON.stringify({ data: "aQ==", filename: "face.png" }) }), response);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).data.uri).toBe("/assets/artist-portfolio/artist-portfolio-0123456789abcdef.png");
    expect(studioService.uploadPortfolioImage).toHaveBeenCalledWith(expect.objectContaining({ artistId: "artist-1", input: { data: "aQ==", filename: "face.png" } }));
    expect(studioService.uploadArtwork).not.toHaveBeenCalled();
  });
});

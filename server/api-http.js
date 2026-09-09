import { Buffer } from "node:buffer";
import { pipeline } from "node:stream/promises";
import { createRequestId } from "./api-runtime.js";
import { ApiError, apiErrorFrom, errorResponse } from "./api-errors.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new (class extends Error { constructor() { super("Request body must be valid JSON."); this.code = "INVALID_JSON"; } })(); }
}

function corsHeaders(request, allowedOrigins) {
  const origin = request.headers?.origin;
  if (!origin || !allowedOrigins.includes(origin)) return {};
  return { "access-control-allow-origin": origin, vary: "Origin", "access-control-allow-headers": "authorization, content-type, x-request-id", "access-control-allow-methods": "GET, POST, PATCH, OPTIONS" };
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, { ...JSON_HEADERS, ...headers });
  response.end(JSON.stringify(body));
}

async function sendMedia(response, media, cors = {}) {
  if (media.type === "redirect") {
    response.writeHead(302, { location: media.url, "cache-control": "no-store", "referrer-policy": "no-referrer", ...cors });
    response.end();
    return;
  }
  const mediaHeaders = { "content-type": media.contentType, "content-length": String(media.contentLength), "accept-ranges": "bytes", "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-disposition": "inline" };
  if (media.partial) mediaHeaders["content-range"] = `bytes ${media.start}-${media.end}/${media.totalLength}`;
  response.writeHead(media.partial ? 206 : 200, { ...mediaHeaders, ...cors });
  await pipeline(media.stream, response);
}

function pathParts(pathname) { return pathname.replace(/^\/|\/$/g, "").split("/").filter(Boolean); }

export function createApiHandler({ service, authService = null, mediaGateway = null, studioService = null, rateLimiter = null, allowedOrigins = [], logger = console } = {}) {
  if (!service) throw new TypeError("createApiHandler requires an ApiService.");
  return async function handle(request, response) {
    const requestId = request.headers["x-request-id"] || createRequestId();
    const url = new URL(request.url || "/", "http://localhost");
    const parts = pathParts(url.pathname);
    const method = request.method || "GET";
    const base = parts[0] === "api" ? parts.slice(1) : parts;
    const responseHeaders = corsHeaders(request, allowedOrigins);
    const apiRequest = { requestId, method, path: url.pathname, headers: request.headers, ip: request.socket?.remoteAddress, rateLimitKey: request.headers["x-forwarded-for"] || request.socket?.remoteAddress || "anonymous" };
    try {
      if (method === "OPTIONS") {
        if (request.headers?.origin && !Object.keys(responseHeaders).length) return send(response, 403, { error: { code: "ORIGIN_NOT_ALLOWED", message: "Origin is not allowed.", details: null, requestId } });
        response.writeHead(204, responseHeaders);
        response.end();
        return;
      }
      if (!(method === "GET" && base.length === 1 && base[0] === "health")) rateLimiter?.check(apiRequest.rateLimitKey);
      if (method === "GET" && base.length === 1 && base[0] === "health") return send(response, 200, { data: { ok: true, service: "voidcaller-api" }, requestId }, responseHeaders);
      if (method === "GET" && base.length === 2 && base[0] === "health" && base[1] === "ready") {
        const data = await service.getOperationalHealth();
        return send(response, data.ok ? 200 : 503, { data, requestId }, responseHeaders);
      }
      if (method === "GET" && base[0] === "media" && base.length === 2) {
        if (!mediaGateway) throw new ApiError(503, "MEDIA_GATEWAY_UNAVAILABLE", "Protected media gateway is unavailable.");
        return sendMedia(response, await mediaGateway.openMedia({ request: apiRequest, grantId: base[1] }), responseHeaders);
      }
      let data;
      if (method === "GET" && base[0] === "artists" && base.length === 1) data = await service.listArtists({ ...Object.fromEntries(url.searchParams), requestId });
      else if (method === "GET" && base[0] === "indexer" && base[1] === "health" && base.length === 2) data = await service.getIndexerHealth({ chainId: url.searchParams.get("chainId") });
      else if (method === "GET" && base[0] === "artists" && base.length === 2) data = await service.getArtist({ idOrSlug: base[1] });
      else if (method === "GET" && base[0] === "releases" && base.length === 1) data = await service.listReleases({ ...Object.fromEntries(url.searchParams) });
      else if (method === "GET" && base[0] === "releases" && base.length === 2) data = await service.getRelease({ idOrSlug: base[1] });
      else if (method === "GET" && base[0] === "editions" && base.length === 1) data = await service.listEditions({ ...Object.fromEntries(url.searchParams) });
      else if (method === "GET" && base[0] === "editions" && base.length === 2) data = await service.getEdition({ id: base[1] });
      else if (method === "GET" && base[0] === "experiences" && base.length === 1) data = await service.listExperiences({ ...Object.fromEntries(url.searchParams) });
      else if (method === "GET" && base[0] === "experiences" && base.length === 2) data = await service.getExperience({ id: base[1] });
      else if (method === "GET" && base[0] === "listings" && base.length === 1) data = await service.listListings({ ...Object.fromEntries(url.searchParams) });
      else if (method === "GET" && base[0] === "listings" && base.length === 4) data = await service.getIndexedListing({ chainId: base[1], marketplaceAddress: base[2], listingId: base[3] });
      else if (method === "GET" && base[0] === "marketplace" && base[1] === "transactions" && base.length === 4) data = await service.getMarketplaceTransaction({ chainId: base[2], transactionHash: base[3] });
      else if (method === "GET" && base[0] === "collectors" && base.length === 2) data = await service.getCollector({ request: apiRequest, wallet: base[1] });
      else if (method === "GET" && base[0] === "collection" && base[1] === "activity") data = await service.collectionActivity({ request: apiRequest, wallet: url.searchParams.get("wallet"), limit: url.searchParams.get("limit"), offset: url.searchParams.get("offset") });
      else {
        const body = await readJson(request);
        if (method === "POST" && base.join("/") === "auth/nonce") {
          if (!authService) throw new ApiError(503, "AUTH_UNAVAILABLE", "Wallet authentication is unavailable.");
          data = await authService.createChallenge({ ...body, requestId });
        }
        else if (method === "POST" && base.join("/") === "auth/verify") {
          if (!authService) throw new ApiError(503, "AUTH_UNAVAILABLE", "Wallet authentication is unavailable.");
          data = await authService.verifyChallenge({ ...body, requestId });
        }
        else if (method === "POST" && base.join("/") === "listings") data = await service.createListing({ request: apiRequest, input: body });
        else if (method === "POST" && base.join("/") === "listings/cancel") data = await service.cancelListing({ request: apiRequest, input: body });
        else if (method === "POST" && base.join("/") === "purchases/intents") data = await service.createPurchaseIntent({ request: apiRequest, input: body });
        else if (method === "POST" && base.join("/") === "purchases/submitted") data = await service.recordPurchaseSubmission({ request: apiRequest, input: body });
        else if (method === "POST" && base.join("/") === "purchases/verify") data = await service.verifyPurchase({ request: apiRequest, input: body });
        else if (method === "POST" && base.join("/") === "media/grants") {
          if (!mediaGateway) throw new ApiError(503, "MEDIA_GATEWAY_UNAVAILABLE", "Protected media gateway is unavailable.");
          data = await mediaGateway.issueGrant({ request: apiRequest, input: body });
        }
        else if (method === "POST" && base.join("/") === "media/grants/revoke") {
          if (!mediaGateway) throw new ApiError(503, "MEDIA_GATEWAY_UNAVAILABLE", "Protected media gateway is unavailable.");
          data = await mediaGateway.revokeGrant({ request: apiRequest, input: body });
        }
        else if (method === "POST" && base.join("/") === "experiences/grants") data = await service.issueExperienceGrant({ request: apiRequest, input: body });
        else if (method === "POST" && base.join("/") === "experiences/redeem") data = await service.redeemExperience({ request: apiRequest, input: body });
        else if (method === "POST" && base.join("/") === "studio/artists") {
          if (!studioService) throw new ApiError(503, "ARTIST_STUDIO_UNAVAILABLE", "Artist Studio is unavailable.");
          data = await studioService.createArtist({ request: apiRequest, input: body });
        }
        else if (method === "PATCH" && base[0] === "studio" && base[1] === "artists" && base.length === 3) {
          if (!studioService) throw new ApiError(503, "ARTIST_STUDIO_UNAVAILABLE", "Artist Studio is unavailable.");
          data = await studioService.updateArtist({ request: apiRequest, artistId: base[2], input: body });
        }
        else if (method === "POST" && base[0] === "studio" && base[1] === "artists" && base[3] === "releases" && base.length === 4) {
          if (!studioService) throw new ApiError(503, "ARTIST_STUDIO_UNAVAILABLE", "Artist Studio is unavailable.");
          data = await studioService.createRelease({ request: apiRequest, artistId: base[2], input: body });
        }
        else if (method === "PATCH" && base[0] === "studio" && base[1] === "releases" && base.length === 3) {
          if (!studioService) throw new ApiError(503, "ARTIST_STUDIO_UNAVAILABLE", "Artist Studio is unavailable.");
          data = await studioService.updateRelease({ request: apiRequest, releaseId: base[2], input: body });
        }
        else if (method === "POST" && base[0] === "studio" && base[1] === "releases" && base[3] === "editions" && base.length === 4) {
          if (!studioService) throw new ApiError(503, "ARTIST_STUDIO_UNAVAILABLE", "Artist Studio is unavailable.");
          data = await studioService.createEdition({ request: apiRequest, releaseId: base[2], input: body });
        }
        else if (method === "PATCH" && base[0] === "studio" && base[1] === "editions" && base.length === 3) {
          if (!studioService) throw new ApiError(503, "ARTIST_STUDIO_UNAVAILABLE", "Artist Studio is unavailable.");
          data = await studioService.updateEdition({ request: apiRequest, editionId: base[2], input: body });
        }
        else if (method === "POST" && base[0] === "studio" && base[1] === "editions" && base[3] === "experiences" && base.length === 4) {
          if (!studioService) throw new ApiError(503, "ARTIST_STUDIO_UNAVAILABLE", "Artist Studio is unavailable.");
          data = await studioService.createExperience({ request: apiRequest, editionId: base[2], input: body });
        }
        else if (method === "PATCH" && base[0] === "studio" && base[1] === "experiences" && base.length === 3) {
          if (!studioService) throw new ApiError(503, "ARTIST_STUDIO_UNAVAILABLE", "Artist Studio is unavailable.");
          data = await studioService.updateExperience({ request: apiRequest, experienceId: base[2], input: body });
        }
        else throw Object.assign(new Error("Route not found."), { code: "NOT_FOUND", status: 404 });
      }
      return send(response, 200, { data, requestId }, responseHeaders);
    } catch (error) {
      const normalized = apiErrorFrom(error);
      if (error?.code === "INVALID_JSON") normalized.status = 400, normalized.code = "INVALID_JSON", normalized.message = error.message;
      if (error?.code === "NOT_FOUND") normalized.status = 404, normalized.code = "NOT_FOUND", normalized.message = error.message;
      logger.error?.("api.http.error", { requestId, path: url.pathname, method, code: normalized.code });
      return send(response, normalized.status, errorResponse(normalized, requestId), responseHeaders);
    }
  };
}

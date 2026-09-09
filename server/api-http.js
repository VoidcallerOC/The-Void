import { Buffer } from "node:buffer";
import { createRequestId } from "./api-runtime.js";
import { apiErrorFrom, errorResponse } from "./api-errors.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new (class extends Error { constructor() { super("Request body must be valid JSON."); this.code = "INVALID_JSON"; } })(); }
}

function send(response, status, body) {
  response.writeHead(status, JSON_HEADERS);
  response.end(JSON.stringify(body));
}

function pathParts(pathname) { return pathname.replace(/^\/|\/$/g, "").split("/").filter(Boolean); }

export function createApiHandler({ service, logger = console } = {}) {
  if (!service) throw new TypeError("createApiHandler requires an ApiService.");
  return async function handle(request, response) {
    const requestId = request.headers["x-request-id"] || createRequestId();
    const url = new URL(request.url || "/", "http://localhost");
    const parts = pathParts(url.pathname);
    const method = request.method || "GET";
    const base = parts[0] === "api" ? parts.slice(1) : parts;
    const apiRequest = { requestId, method, path: url.pathname, headers: request.headers, ip: request.socket?.remoteAddress, rateLimitKey: request.headers["x-forwarded-for"] || request.socket?.remoteAddress || "anonymous" };
    try {
      if (method === "GET" && base.length === 1 && base[0] === "health") return send(response, 200, { data: { ok: true, service: "voidcaller-api" }, requestId });
      let data;
      if (method === "GET" && base[0] === "artists" && base.length === 1) data = await service.listArtists({ ...Object.fromEntries(url.searchParams), requestId });
      else if (method === "GET" && base[0] === "artists" && base.length === 2) data = await service.getArtist({ idOrSlug: base[1] });
      else if (method === "GET" && base[0] === "releases" && base.length === 1) data = await service.listReleases({ ...Object.fromEntries(url.searchParams) });
      else if (method === "GET" && base[0] === "releases" && base.length === 2) data = await service.getRelease({ idOrSlug: base[1] });
      else if (method === "GET" && base[0] === "editions" && base.length === 1) data = await service.listEditions({ ...Object.fromEntries(url.searchParams) });
      else if (method === "GET" && base[0] === "editions" && base.length === 2) data = await service.getEdition({ id: base[1] });
      else if (method === "GET" && base[0] === "experiences" && base.length === 1) data = await service.listExperiences({ ...Object.fromEntries(url.searchParams) });
      else if (method === "GET" && base[0] === "experiences" && base.length === 2) data = await service.getExperience({ id: base[1] });
      else if (method === "GET" && base[0] === "listings" && base.length === 1) data = await service.listListings({ ...Object.fromEntries(url.searchParams) });
      else if (method === "GET" && base[0] === "collectors" && base.length === 2) data = await service.getCollector({ request: apiRequest, wallet: base[1] });
      else if (method === "GET" && base[0] === "collection" && base[1] === "activity") data = await service.collectionActivity({ request: apiRequest, wallet: url.searchParams.get("wallet"), limit: url.searchParams.get("limit"), offset: url.searchParams.get("offset") });
      else {
        const body = await readJson(request);
        if (method === "POST" && base.join("/") === "listings") data = await service.createListing({ request: apiRequest, input: body });
        else if (method === "POST" && base.join("/") === "listings/cancel") data = await service.cancelListing({ request: apiRequest, input: body });
        else if (method === "POST" && base.join("/") === "purchases/intents") data = await service.createPurchaseIntent({ request: apiRequest, input: body });
        else if (method === "POST" && base.join("/") === "purchases/verify") data = await service.verifyPurchase({ request: apiRequest, input: body });
        else if (method === "POST" && base.join("/") === "experiences/grants") data = await service.issueExperienceGrant({ request: apiRequest, input: body });
        else if (method === "POST" && base.join("/") === "experiences/redeem") data = await service.redeemExperience({ request: apiRequest, input: body });
        else throw Object.assign(new Error("Route not found."), { code: "NOT_FOUND", status: 404 });
      }
      return send(response, 200, { data, requestId });
    } catch (error) {
      const normalized = apiErrorFrom(error);
      if (error?.code === "INVALID_JSON") normalized.status = 400, normalized.code = "INVALID_JSON", normalized.message = error.message;
      if (error?.code === "NOT_FOUND") normalized.status = 404, normalized.code = "NOT_FOUND", normalized.message = error.message;
      logger.error?.("api.http.error", { requestId, path: url.pathname, method, code: normalized.code });
      return send(response, normalized.status, errorResponse(normalized, requestId));
    }
  };
}

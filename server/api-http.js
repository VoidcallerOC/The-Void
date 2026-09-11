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

function corsHeaders(request) {
  const headers = { ...JSON_HEADERS };
  const origin = request?.headers?.origin;
  if (origin && request.allowedOrigins?.includes(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-methods"] = "GET,POST,OPTIONS";
    headers["access-control-allow-headers"] = "content-type,authorization,x-request-id";
    headers.vary = "origin";
  }
  return headers;
}

function send(response, status, body, request = null) {
  response.writeHead(status, corsHeaders(request));
  response.end(JSON.stringify(body));
}

function pathParts(pathname) { return pathname.replace(/^\/|\/$/g, "").split("/").filter(Boolean); }

function requirePersistence(service, name) {
  const fn = service[name];
  if (typeof fn !== "function") throw Object.assign(new Error("Persistence layer is not configured."), { code: "DATABASE_NOT_CONFIGURED", status: 503 });
  return fn.bind(service);
}

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
      apiRequest.allowedOrigins = service.allowedOrigins || [];
      if (method === "OPTIONS") {
        response.writeHead(204, corsHeaders(apiRequest));
        response.end();
        return;
      }
      if (method === "GET" && base.length === 1 && base[0] === "health") return send(response, 200, { data: { ok: true, service: "voidcaller-api" }, requestId }, apiRequest);
      if (method === "GET" && base.length === 2 && base[0] === "health" && base[1] === "ready") {
        const readiness = typeof service.readiness === "function" ? await service.readiness() : { ok: false, status: "not_ready", error: "Readiness checker is not configured." };
        return send(response, readiness.ok ? 200 : 503, { data: readiness, requestId }, apiRequest);
      }
      let data;
      if (method === "GET" && base[0] === "artists" && base.length === 1) data = await requirePersistence(service, "listArtists")({ ...Object.fromEntries(url.searchParams), requestId });
      else if (method === "GET" && base[0] === "artists" && base.length === 2) data = await requirePersistence(service, "getArtist")({ idOrSlug: base[1] });
      else if (method === "GET" && base[0] === "releases" && base.length === 1) data = await requirePersistence(service, "listReleases")({ ...Object.fromEntries(url.searchParams) });
      else if (method === "GET" && base[0] === "releases" && base.length === 2) data = await requirePersistence(service, "getRelease")({ idOrSlug: base[1] });
      else if (method === "GET" && base[0] === "editions" && base.length === 1) data = await requirePersistence(service, "listEditions")({ ...Object.fromEntries(url.searchParams) });
      else if (method === "GET" && base[0] === "editions" && base.length === 2) data = await requirePersistence(service, "getEdition")({ id: base[1] });
      else if (method === "GET" && base[0] === "experiences" && base.length === 1) data = await requirePersistence(service, "listExperiences")({ ...Object.fromEntries(url.searchParams) });
      else if (method === "GET" && base[0] === "experiences" && base.length === 2) data = await requirePersistence(service, "getExperience")({ id: base[1] });
      else if (method === "GET" && base[0] === "listings" && base.length === 1) data = await requirePersistence(service, "listListings")({ ...Object.fromEntries(url.searchParams) });
      else if (method === "GET" && base[0] === "collectors" && base.length === 2) data = await requirePersistence(service, "getCollector")({ request: apiRequest, wallet: base[1] });
      else if (method === "GET" && base[0] === "collection" && base[1] === "activity") data = await requirePersistence(service, "collectionActivity")({ request: apiRequest, wallet: url.searchParams.get("wallet"), limit: url.searchParams.get("limit"), offset: url.searchParams.get("offset") });
      else {
        const body = await readJson(request);
        if (method === "POST" && base.join("/") === "listings") data = await requirePersistence(service, "createListing")({ request: apiRequest, input: body });
        else if (method === "POST" && base.join("/") === "listings/cancel") data = await requirePersistence(service, "cancelListing")({ request: apiRequest, input: body });
        else if (method === "POST" && base.join("/") === "purchases/intents") data = await requirePersistence(service, "createPurchaseIntent")({ request: apiRequest, input: body });
        else if (method === "POST" && base.join("/") === "purchases/verify") data = await requirePersistence(service, "verifyPurchase")({ request: apiRequest, input: body });
        else if (method === "POST" && base.join("/") === "experiences/grants") data = await requirePersistence(service, "issueExperienceGrant")({ request: apiRequest, input: body });
        else if (method === "POST" && base.join("/") === "experiences/redeem") data = await requirePersistence(service, "redeemExperience")({ request: apiRequest, input: body });
        else throw Object.assign(new Error("Route not found."), { code: "NOT_FOUND", status: 404 });
      }
      return send(response, 200, { data, requestId }, apiRequest);
    } catch (error) {
      const normalized = apiErrorFrom(error);
      if (error?.code === "INVALID_JSON") normalized.status = 400, normalized.code = "INVALID_JSON", normalized.message = error.message;
      if (error?.code === "NOT_FOUND") normalized.status = 404, normalized.code = "NOT_FOUND", normalized.message = error.message;
      if (error?.code === "DATABASE_NOT_CONFIGURED") normalized.status = 503, normalized.code = "DATABASE_NOT_CONFIGURED", normalized.message = error.message;
      logger.error?.("api.http.error", { requestId, path: url.pathname, method, code: normalized.code });
      return send(response, normalized.status, errorResponse(normalized, requestId), apiRequest);
    }
  };
}

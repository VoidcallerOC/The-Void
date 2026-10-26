import process from "node:process";
import { Buffer } from "node:buffer";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiHandler } from "./api-http.js";
import { PrivateMediaStorage } from "./media-storage.js";

const servers = [];
async function listen(handler) {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => { s.closeAllConnections?.(); return new Promise((r) => s.close(r)); })); });

async function relay(upstreamUrl, logger) {
  const mediaGateway = { openMedia: vi.fn(async () => PrivateMediaStorage.prototype.streamSignedObject.call({}, { url: upstreamUrl, contentType: "audio/mpeg" })) };
  const handle = createApiHandler({ service: {}, mediaGateway, logger });
  return listen((req, res) => { handle(req, res); });
}

function watchProcess() {
  const seen = [];
  const onRejection = (error) => seen.push(error);
  process.on("unhandledRejection", onRejection);
  return { seen, stop: () => process.off("unhandledRejection", onRejection) };
}

describe("protected media relay stream failures", () => {
  it("client closing mid-stream aborts the upstream, logs info, and does not crash", async () => {
    let upstreamClosed;
    const upstreamGone = new Promise((r) => { upstreamClosed = r; });
    const upstream = await listen((req, res) => {
      res.writeHead(200, { "content-type": "audio/mpeg", "content-length": "1000000" });
      res.write(Buffer.alloc(1024, 1));
      res.on("close", () => upstreamClosed(true));
    });
    const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
    const api = await relay(upstream, logger);
    const guard = watchProcess();
    try {
      await new Promise((resolve) => {
        const req = httpRequest(`${api}/api/media/grant-1`, (res) => {
          expect(res.statusCode).toBe(200);
          res.once("data", () => { req.destroy(); resolve(); });
        });
        req.on("error", () => {});
        req.end();
      });
      await expect(upstreamGone).resolves.toBe(true);
      await vi.waitFor(() => expect(logger.info).toHaveBeenCalledWith("api.media.client_closed", expect.objectContaining({ reason: "MEDIA_CLIENT_CLOSED" })));
      await new Promise((r) => setTimeout(r, 50));
      expect(guard.seen).toEqual([]);
      expect(logger.error).not.toHaveBeenCalled();
    } finally { guard.stop(); }
  });

  it("upstream failing mid-stream logs an error, destroys the response, and does not crash", async () => {
    const upstream = await listen((req, res) => {
      res.writeHead(200, { "content-type": "audio/mpeg", "content-length": "1000000" });
      res.write(Buffer.alloc(1024, 1), () => setTimeout(() => res.socket.destroy(), 20));
    });
    const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
    const api = await relay(upstream, logger);
    const guard = watchProcess();
    try {
      const outcome = await new Promise((resolve) => {
        const req = httpRequest(`${api}/api/media/grant-1`, (res) => {
          res.on("data", () => {});
          res.on("aborted", () => resolve("aborted"));
          res.on("error", () => resolve("aborted"));
          res.on("end", () => resolve("ended"));
        });
        req.on("error", () => resolve("aborted"));
        req.end();
      });
      expect(outcome).toBe("aborted");
      await vi.waitFor(() => expect(logger.error).toHaveBeenCalledWith("api.media.upstream_failed", expect.objectContaining({ reason: "MEDIA_UPSTREAM_STREAM_FAILED" })));
      expect(guard.seen).toEqual([]);
      // The API server is still serving.
      const health = await fetch(`${api}/api/media/grant-1`).then((r) => r.status).catch(() => "down");
      expect(health).not.toBe("down");
    } finally { guard.stop(); }
  });
});

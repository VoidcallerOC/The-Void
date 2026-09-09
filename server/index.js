import process from "node:process";
import { createServer } from "node:http";
import { createApiHandler } from "./api-http.js";
import { createStructuredLogger, createRateLimiter } from "./api-runtime.js";
import { loadServerConfig } from "./config.js";
import { createDatabasePool } from "./db.js";
import { createPersistenceRepository } from "./repositories.js";
import { ApiService } from "./api-service.js";

export function createApiServer({ config = loadServerConfig(), db = null, authenticator = null, ownershipVerifier = null, blockchainVerifier = null, logger = createStructuredLogger() } = {}) {
  const pool = db || createDatabasePool(config);
  const repository = createPersistenceRepository(pool);
  const service = new ApiService({ db: pool, repository, authenticator, ownershipVerifier, blockchainVerifier, rateLimiter: createRateLimiter(), logger });
  const server = createServer(createApiHandler({ service, logger }));
  return { server, pool, service };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 8787);
  const { server } = createApiServer();
  server.listen(port, () => console.log(JSON.stringify({ event: "api.started", port })));
}

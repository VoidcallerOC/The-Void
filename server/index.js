import process from "node:process";
import { createServer } from "node:http";
import { createApiHandler } from "./api-http.js";
import { createStructuredLogger, createRateLimiter } from "./api-runtime.js";
import { loadServerConfig } from "./config.js";
import { createDatabasePool } from "./db.js";
import { createPersistenceRepository } from "./repositories.js";
import { ApiService } from "./api-service.js";
import { createReadinessChecker } from "./readiness.js";
import { createWalletAuthenticator } from "./wallet-auth.js";
import { createPrivateMediaStore } from "./media-storage.js";
import { createMediaService } from "./media-service.js";

export function createApiServer({ config = loadServerConfig(), db = null, authenticator = null, ownershipVerifier = null, blockchainVerifier = null, logger = createStructuredLogger() } = {}) {
  const pool = db || (config.databaseUrl ? createDatabasePool(config) : null);
  const repository = pool ? createPersistenceRepository(pool) : null;
  const walletAuth = pool ? createWalletAuthenticator({ db: pool, config }) : null;
  const media = pool && walletAuth ? createMediaService({ db: pool, repository, authenticator: authenticator || walletAuth.authenticate, storage: createPrivateMediaStore(), ownershipVerifier }) : null;
  const service = pool
    ? new ApiService({ db: pool, repository, authenticator: authenticator || walletAuth?.authenticate, walletAuth, ownershipVerifier, blockchainVerifier, rateLimiter: createRateLimiter(), logger })
    : { persistenceConfigured: false };
  service.allowedOrigins = config.allowedOrigins;
  service.readiness = createReadinessChecker({ pool, config });
  service.walletAuth = walletAuth;
  service.media = media;
  const handler = createApiHandler({ service, logger });
  const server = createServer(handler);
  return { server, pool, service, handler, config };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 8787);
  const { server } = createApiServer();
  server.listen(port, () => console.log(JSON.stringify({ event: "api.started", port })));
}

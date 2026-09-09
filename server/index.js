import process from "node:process";
import { createServer } from "node:http";
import { createApiHandler } from "./api-http.js";
import { createStructuredLogger, createRateLimiter } from "./api-runtime.js";
import { loadMediaConfig, loadServerConfig } from "./config.js";
import { closeDatabasePool, createDatabasePool } from "./db.js";
import { createPersistenceRepository } from "./repositories.js";
import { ApiService } from "./api-service.js";
import { WalletAuthService, createWalletAuthenticator } from "./auth.js";
import { createIndexerStore } from "./indexer-store.js";
import { createPrivateMediaStorage } from "./media-storage.js";
import { createProtectedMediaGateway } from "./media-gateway.js";
import { createIndexedOwnershipVerifier } from "./ownership.js";
import { createArtistStudioService } from "./studio-service.js";

export function createApiServer({ config = loadServerConfig(), mediaConfig = null, db = null, authenticator = null, authService = null, ownershipVerifier = null, blockchainVerifier = null, mediaGateway = null, logger = createStructuredLogger() } = {}) {
  const pool = db || createDatabasePool(config);
  const repository = createPersistenceRepository(pool);
  const indexerStore = createIndexerStore(pool);
  const resolvedAuthService = authService || new WalletAuthService({ repository, config });
  const resolvedAuthenticator = authenticator || createWalletAuthenticator(resolvedAuthService);
  const resolvedOwnershipVerifier = ownershipVerifier || createIndexedOwnershipVerifier({ db: pool, config });
  const rateLimiter = createRateLimiter();
  const service = new ApiService({ db: pool, repository, authenticator: resolvedAuthenticator, ownershipVerifier: resolvedOwnershipVerifier, blockchainVerifier, indexerStore, rateLimiter, logger });
  const resolvedMediaConfig = mediaConfig || loadMediaConfig();
  const resolvedMediaGateway = mediaGateway || createProtectedMediaGateway({ db: pool, repository, authenticator: resolvedAuthenticator, ownershipVerifier: resolvedOwnershipVerifier, storage: createPrivateMediaStorage({ config: resolvedMediaConfig }), mediaConfig: resolvedMediaConfig });
  const studioService = createArtistStudioService({ db: pool, repository, authenticator: resolvedAuthenticator, logger });
  const server = createServer(createApiHandler({ service, authService: resolvedAuthService, mediaGateway: resolvedMediaGateway, studioService, rateLimiter, allowedOrigins: config.apiAllowedOrigins, logger }));
  return { server, pool, service, authService: resolvedAuthService, mediaGateway: resolvedMediaGateway, studioService };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 8787);
  const config = loadServerConfig();
  const { server, pool } = createApiServer({ config });
  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(JSON.stringify({ event: "api.shutdown.started", signal }));
    const deadline = new Promise((resolve) => setTimeout(resolve, config.shutdownTimeoutMs));
    Promise.race([
      new Promise((resolve) => server.close(resolve)),
      deadline,
    ]).then(() => closeDatabasePool(pool)).then(() => {
      console.log(JSON.stringify({ event: "api.shutdown.completed", signal }));
    }).catch((error) => {
      console.error(JSON.stringify({ event: "api.shutdown.failed", error: error.message }));
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  server.listen(port, () => console.log(JSON.stringify({ event: "api.started", port, environment: config.appEnvironment })));
}

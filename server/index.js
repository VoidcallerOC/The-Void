import process from "node:process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createApiHandler } from "./api-http.js";
import { createStructuredLogger, createRateLimiter } from "./api-runtime.js";
import { loadIndexerConfig, loadMediaConfig, loadMetadataConfig, loadServerConfig } from "./config.js";
import { closeDatabasePool, createDatabasePool } from "./db.js";
import { createPersistenceRepository } from "./repositories.js";
import { ApiService } from "./api-service.js";
import { WalletAuthService, createWalletAuthenticator } from "./auth.js";
import { createIndexerStore } from "./indexer-store.js";
import { createPrivateMediaStorage } from "./media-storage.js";
import { createProtectedMediaGateway } from "./media-gateway.js";
import { createIndexedOwnershipVerifier } from "./ownership.js";
import { createArtistStudioService } from "./studio-service.js";
import { createArtistVerificationService } from "./verification-service.js";
import { createMarketplacePresentationService } from "./marketplace-presentation-service.js";
import { createLocalMarketplaceHeroStore } from "./marketplace-hero-storage.js";
import { createLocalArtistPortfolioStore } from "./artist-portfolio-storage.js";
import { createNotificationStore, createVerificationNotifier } from "./verification-notifier.js";
import { createXDmClient, loadXDmConfig } from "./x-dm.js";
import { createContractOwnerVerificationService } from "./contract-owner-verification.js";
import { createPinataMetadataStorage } from "./metadata-storage.js";
import { createPinataArtworkUploader } from "./artwork-storage.js";
import { createProvenanceAnchorService, loadProvenanceAnchorConfig } from "./provenance-anchor.js";
import { createIpfsMetadataFetcher } from "./publication-anchor.js";
import { ProvenanceRecords } from "./provenance-records.js";
import { createGenesisClaimService, loadGenesisClaimConfig } from "./genesis-claim.js";

export function createApiServer({ config = loadServerConfig(), mediaConfig = null, db = null, authenticator = null, authService = null, ownershipVerifier = null, blockchainVerifier = null, mediaGateway = null, logger = createStructuredLogger() } = {}) {
  const pool = db || createDatabasePool(config);
  const repository = createPersistenceRepository(pool);
  const indexerStore = createIndexerStore(pool);
  const resolvedAuthService = authService || new WalletAuthService({ repository, config });
  const resolvedAuthenticator = authenticator || createWalletAuthenticator(resolvedAuthService);
  const metadataConfig = loadMetadataConfig();
  const metadataStorage = metadataConfig.driver === "pinata" ? createPinataMetadataStorage({ config: metadataConfig, logger }) : null;
  const artworkUploader = metadataConfig.driver === "pinata" ? createPinataArtworkUploader({ jwt: metadataConfig.jwt }) : null;
  const resolvedOwnershipVerifier = ownershipVerifier || createIndexedOwnershipVerifier({ db: pool, config });
  const rateLimiter = createRateLimiter();
  const indexerConfig = config.indexer || loadIndexerConfig(process.env, { requireConfiguration: false });
  const service = new ApiService({ db: pool, repository, authenticator: resolvedAuthenticator, ownershipVerifier: resolvedOwnershipVerifier, blockchainVerifier, indexerStore, indexerConfig, rateLimiter, logger });
  let resolvedMediaGateway = mediaGateway;
  let mediaUploader = null;
  let directMediaUploads = null;
  if (!resolvedMediaGateway) {
    try {
      const resolvedMediaConfig = mediaConfig || loadMediaConfig();
      const storage = createPrivateMediaStorage({ config: resolvedMediaConfig });
      mediaUploader = (input) => storage.put(input);
      if (resolvedMediaConfig.driver === "pinata") directMediaUploads = { maxBytes: resolvedMediaConfig.maxBytes, sign: (input) => storage.createSignedUpload(input), get: (input) => storage.getPrivateUpload(input), sha256: (input) => storage.sha256OfPrivateObject(input) };
      resolvedMediaGateway = createProtectedMediaGateway({ db: pool, repository, authenticator: resolvedAuthenticator, ownershipVerifier: resolvedOwnershipVerifier, storage, mediaConfig: resolvedMediaConfig });
    } catch (error) {
      if (String(process.env.VERCEL || "") !== "1") throw error;
      logger.warn?.("api.media.disabled", { error: error.message });
    }
  }
  const provenanceRecords = new ProvenanceRecords({ db: pool });
  const metadataFetcher = createIpfsMetadataFetcher({ gateway: process.env.IPFS_GATEWAY });
  // Profile pictures and banners are local site files. Release artwork still uses artworkUploader (Pinata).
  const artistPortfolioStore = createLocalArtistPortfolioStore({ root: fileURLToPath(new URL("../public/assets/artist-portfolio", import.meta.url)), db: pool });
  const studioService = createArtistStudioService({ db: pool, repository, authenticator: resolvedAuthenticator, metadataStorage, mediaUploader, directMediaUploads, artworkUploader, portfolioStore: artistPortfolioStore, provenanceRecords, metadataFetcher, logger });
  // Reviewer alerts: X DM to the server-configured reviewer account. Missing
  // X configuration is reported (startup log + per-alert CONFIG_MISSING), never fatal.
  const xDmConfig = loadXDmConfig(process.env);
  if (!xDmConfig.configured) logger.error?.("X_DM_CONFIG_MISSING", { missing: [...xDmConfig.missing, ...xDmConfig.invalid], recipient: `@${xDmConfig.recipientUsername}` });
  const verificationNotifier = createVerificationNotifier({ store: createNotificationStore(pool), xClient: createXDmClient({ config: xDmConfig }), xConfig: xDmConfig, publicAppUrl: config.publicAppUrl || process.env.PUBLIC_APP_URL || "", logger });
  const verificationService = createArtistVerificationService({ db: pool, authenticator: resolvedAuthenticator, notifier: verificationNotifier, logger });
  const contractOwnerVerification = createContractOwnerVerificationService({ db: pool, config, logger });
  let genesisClaim = null;
  try {
    genesisClaim = createGenesisClaimService({ config: loadGenesisClaimConfig(process.env) });
  } catch (error) {
    logger.error?.("genesis.claim.disabled", { error: error.message });
  }
  // Header art is a local site file. Release artwork still uses artworkUploader (Pinata).
  const marketplaceHeroStore = createLocalMarketplaceHeroStore({ root: fileURLToPath(new URL("../public/assets/marketplace-heroes", import.meta.url)), db: pool });
  const marketplacePresentation = createMarketplacePresentationService({ db: pool, authenticator: resolvedAuthenticator, heroStore: marketplaceHeroStore });
  const provenanceAnchor = createProvenanceAnchorService({ db: pool, authenticator: resolvedAuthenticator, config: loadProvenanceAnchorConfig(process.env) });
  const handler = createApiHandler({ service, authService: resolvedAuthService, mediaGateway: resolvedMediaGateway, studioService, verificationService, marketplacePresentation, contractOwnerVerification, provenanceAnchor, genesisClaim, rateLimiter, allowedOrigins: config.apiAllowedOrigins, logger });
  const server = createServer(handler);
  return { server, handler, pool, service, authService: resolvedAuthService, mediaGateway: resolvedMediaGateway, studioService, verificationService, verificationNotifier, genesisClaim };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 8787);
  const config = loadServerConfig();
  const { server, pool, verificationNotifier } = createApiServer({ config });
  // Retry sweep for reviewer alerts (backoff, missing-config re-checks, backstop).
  const notificationSweep = setInterval(() => {
    verificationNotifier.processDue().catch((error) => console.error(JSON.stringify({ event: "X_DM_FAILED", code: "SWEEP_ERROR", detail: error.message })));
  }, 60_000);
  notificationSweep.unref();
  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    clearInterval(notificationSweep);
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

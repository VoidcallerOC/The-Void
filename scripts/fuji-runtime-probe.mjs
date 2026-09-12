import { Buffer } from "node:buffer";
import { loadServerConfig } from "../server/config.js";
import { createApiServer } from "../server/index.js";
import { createIndexerWorker } from "../server/indexer-worker.js";

function responseDouble() {
  return { status: null, headers: null, body: "", writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
}
function requestDouble(url) {
  return { method: "GET", url, headers: {}, socket: { remoteAddress: "127.0.0.1" }, async *[Symbol.asyncIterator]() { yield Buffer.from(""); } };
}
const config = loadServerConfig({ NODE_ENV: "development", PUBLIC_APP_URL: "https://the-void-alpha.vercel.app", API_ALLOWED_ORIGINS: "https://the-void-alpha.vercel.app" }, { allowMissingDatabase: true });
const { handler } = createApiServer({ config, logger: { info() {}, warn() {}, error() {} } });
for (const path of ["/api/health", "/api/health/ready"]) {
  const response = responseDouble();
  await handler(requestDouble(path), response);
  const payload = JSON.parse(response.body);
  console.log(JSON.stringify({ path, status: response.status, payload }));
}
const workerConfig = loadServerConfig({ NODE_ENV: "production", DATABASE_URL: "postgres://redacted.invalid/fuji", PUBLIC_APP_URL: "https://staging.example.com", API_ALLOWED_ORIGINS: "https://staging.example.com", AUTH_DOMAIN: "https://staging.example.com", AUTH_URI: "https://staging.example.com/login", INDEXER_RPC_URL: "https://api.avax-test.network/ext/bc/C/rpc", INDEXER_CHAIN_ID: "43113", INDEXER_CONTRACTS_JSON: JSON.stringify([{ address: "0x0000000000000000000000000000000000000001", contractType: "ERC1155", startBlock: 0 }]) }, { requireIndexerContracts: true });
try {
  const worker = createIndexerWorker({ config: workerConfig, pool: { query: async () => ({ rows: [] }) }, logger: { info() {}, warn() {}, error() {} } });
  console.log(JSON.stringify({ indexerWorkerConfig: "validated", chainId: workerConfig.indexer.chainId, rpcUrl: workerConfig.indexer.rpcUrl }));
  await worker.stop();
} catch (error) {
  console.error(JSON.stringify({ indexerWorkerConfig: "failed", error: error.message }));
  process.exitCode = 1;
}

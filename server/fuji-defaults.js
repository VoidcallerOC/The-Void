import process from "node:process";
import deployment from "../config/fuji-release.json" with { type: "json" };

export const FUJI_RELEASE_DEPLOYMENT = Object.freeze(deployment);

export const FUJI_FRONTEND_ORIGINS = [
  "https://the-void-alpha.vercel.app",
  "https://voidcaller-site.vercel.app",
  "https://voidcaller.enterthegrotto.xyz",
  "https://the-void-nickhsousa96-8307s-projects.vercel.app",
];

export const FUJI_PUBLIC_RPC = FUJI_RELEASE_DEPLOYMENT.rpcUrl;

export function applyFujiRuntimeDefaults(env = process.env) {
  const frontend = String(env.PUBLIC_APP_URL || FUJI_FRONTEND_ORIGINS[0]).replace(/\/$/, "");
  env.PUBLIC_APP_URL ||= frontend;
  env.AUTH_DOMAIN ||= frontend;
  env.AUTH_URI ||= `${frontend}/reliquary`;
  env.API_ALLOWED_ORIGINS ||= [...new Set([frontend, ...FUJI_FRONTEND_ORIGINS])].join(",");
  env.INDEXER_RPC_URL ||= FUJI_PUBLIC_RPC;
  env.INDEXER_CHAIN_ID ||= String(FUJI_RELEASE_DEPLOYMENT.chainId);
  env.INDEXER_CONFIRMATIONS ||= "12";
  env.INDEXER_POLL_INTERVAL_MS ||= "15000";
  env.DATABASE_SSL ||= "true";
  return env;
}

import fuji from "./fuji-release.json" with { type: "json" };
import mainnet from "./mainnet-release.json" with { type: "json" };

// One deployment per environment. Fuji is the default; mainnet is an explicit
// opt-in (VITE_RELEASE_NETWORK in the web build, RELEASE_NETWORK on the server)
// and refuses to load until config/mainnet-release.json holds deployed addresses.
export const RELEASE_DEPLOYMENTS = Object.freeze({ fuji, mainnet });

function requestedNetwork() {
  const web = typeof import.meta !== "undefined" ? import.meta.env?.VITE_RELEASE_NETWORK : undefined;
  const node = globalThis.process?.env?.RELEASE_NETWORK;
  return String(web || node || "fuji").trim().toLowerCase();
}

export function releaseDeploymentFor(network) {
  const name = String(network || "fuji").trim().toLowerCase();
  const deployment = RELEASE_DEPLOYMENTS[name];
  if (!deployment) throw new Error(`Unknown release network "${network}". Use "fuji" or "mainnet".`);
  if (name === "mainnet" && (!deployment.deployed || !deployment.contractAddress || !deployment.primarySaleAddress)) {
    throw new Error("Mainnet release contracts are not deployed yet: config/mainnet-release.json has no contract addresses.");
  }
  return deployment;
}

export const RELEASE_NETWORK = requestedNetwork();
export const RELEASE_DEPLOYMENT = releaseDeploymentFor(RELEASE_NETWORK);
export const IS_MAINNET_RELEASE = RELEASE_DEPLOYMENT.chainId === 43114;

import fuji from "./fuji-release.json" with { type: "json" };
import fujiPerContract from "./fuji-release-per-contract.json" with { type: "json" };
import fujiPerContractV2 from "./fuji-release-per-contract-v2.json" with { type: "json" };
import mainnet from "./mainnet-release.json" with { type: "json" };
import mainnetPerContract from "./mainnet-release-per-contract.json" with { type: "json" };

// One deployment per environment. Fuji is the default; mainnet is an explicit
// opt-in (VITE_RELEASE_NETWORK in the web build, RELEASE_NETWORK on the server).
// RELEASE_DEPLOYMENTS describes the legacy shared VoidRelease1155V2 contract; mainnet has none
// (contractAddress null), and the release-per-contract manifests below carry the product.
export const RELEASE_DEPLOYMENTS = Object.freeze({ fuji, mainnet });
// Release-per-contract (factory) manifest per network. Mainnet stays deployed:false with null
// addresses until its factory and marketplace are deployed and recorded here.
export const RELEASE_PER_CONTRACT_MANIFESTS = Object.freeze({ fuji: Object.freeze(fujiPerContractV2), mainnet: Object.freeze(mainnetPerContract) });
// Individual release addresses are discovered from this factory at runtime;
// this manifest contains only public infrastructure addresses.
export const FUJI_RELEASE_PER_CONTRACT = Object.freeze(fujiPerContract);
// V2 is separate from the existing immutable V1 deployment. Provisioning remains
// disabled until a future, separately authorized deployment is configured.
export const FUJI_RELEASE_PER_CONTRACT_V2 = Object.freeze(fujiPerContractV2);

// Factory V3 (ReleaseCreated version 3) clones VoidRelease1155V5, which records the provenance
// root inside the edition-creating transaction and is its own provenance anchor. Releases from
// version 2 factories keep the separate VoidProvenanceAnchor transaction.
export const PROVENANCE_AT_CREATION_RELEASE_VERSION = 3;
export function anchorsProvenanceAtCreation(releaseVersion) {
  const version = Number(releaseVersion);
  return Number.isSafeInteger(version) && version >= PROVENANCE_AT_CREATION_RELEASE_VERSION;
}

// Every release-per-contract deployment of one manifest: the active (album-capable) factory first,
// then historical ones. Factory clones are immutable and each ReleaseMarketplaceV3 accepts only
// its own factory's releases, so a release always trades on the marketplace of the factory that
// created it. Historical deployments stay fully supported for the releases they already hold.
// A manifest without a factory address (mainnet before deployment) contributes nothing.
function manifestDeployments(manifest) {
  if (!manifest?.factoryAddress) return Object.freeze([]);
  return Object.freeze([
    { factoryAddress: manifest.factoryAddress, implementationAddress: manifest.implementationAddress, marketplaceAddress: manifest.marketplaceAddress, factoryDeploymentBlock: manifest.factoryDeploymentBlock, marketplaceDeploymentBlock: manifest.marketplaceDeploymentBlock, releaseVersion: manifest.releaseVersion, albumCapable: manifest.albumCapable === true, active: true },
    ...(manifest.historicalDeployments || []).map((deployment) => ({ ...deployment, albumCapable: deployment.albumCapable === true, active: false })),
  ].map((deployment) => Object.freeze({ ...deployment, chainId: Number(manifest.chainId), provenanceAtCreation: anchorsProvenanceAtCreation(deployment.releaseVersion) })));
}
export const FUJI_RELEASE_PER_CONTRACT_V2_DEPLOYMENTS = manifestDeployments(fujiPerContractV2);
// Every recorded deployment on every network. Factory and marketplace addresses are unique per
// chain, and each entry carries its chainId.
export const RELEASE_PER_CONTRACT_DEPLOYMENTS = Object.freeze([...FUJI_RELEASE_PER_CONTRACT_V2_DEPLOYMENTS, ...manifestDeployments(mainnetPerContract)]);

const sameAddress = (a, b) => typeof a === "string" && typeof b === "string" && a.trim().toLowerCase() === b.trim().toLowerCase() && a.trim() !== "";

export function releaseDeploymentForFactory(factoryAddress) {
  return RELEASE_PER_CONTRACT_DEPLOYMENTS.find((deployment) => sameAddress(deployment.factoryAddress, factoryAddress)) || null;
}

export function releaseDeploymentForMarketplace(marketplaceAddress) {
  return RELEASE_PER_CONTRACT_DEPLOYMENTS.find((deployment) => sameAddress(deployment.marketplaceAddress, marketplaceAddress)) || null;
}

function requestedNetwork() {
  const web = typeof import.meta !== "undefined" ? import.meta.env?.VITE_RELEASE_NETWORK : undefined;
  const node = globalThis.process?.env?.RELEASE_NETWORK;
  return String(web || node || "fuji").trim().toLowerCase();
}

export function releaseDeploymentFor(network) {
  const name = String(network || "fuji").trim().toLowerCase();
  const deployment = RELEASE_DEPLOYMENTS[name];
  if (!deployment) throw new Error(`Unknown release network "${network}". Use "fuji" or "mainnet".`);
  // Mainnet has no legacy shared contract: contractAddress and primarySaleAddress stay null and
  // every legacy-shared path treats that as "no shared release" instead of failing at import.
  return deployment;
}

export function releasePerContractManifestFor(network) {
  const name = String(network || "fuji").trim().toLowerCase();
  const manifest = RELEASE_PER_CONTRACT_MANIFESTS[name];
  if (!manifest) throw new Error(`Unknown release network "${network}". Use "fuji" or "mainnet".`);
  return manifest;
}

export const RELEASE_NETWORK = requestedNetwork();
export const RELEASE_DEPLOYMENT = releaseDeploymentFor(RELEASE_NETWORK);
export const IS_MAINNET_RELEASE = RELEASE_DEPLOYMENT.chainId === 43114;
// The release-per-contract manifest of the selected network: Fuji's V2 factory by default, the
// mainnet manifest with RELEASE_NETWORK=mainnet / VITE_RELEASE_NETWORK=mainnet.
export const RELEASE_PER_CONTRACT = releasePerContractManifestFor(RELEASE_NETWORK);
// Deployments of the selected network only.
export const ACTIVE_RELEASE_PER_CONTRACT_DEPLOYMENTS = Object.freeze(RELEASE_PER_CONTRACT_DEPLOYMENTS.filter((deployment) => deployment.chainId === Number(RELEASE_PER_CONTRACT.chainId)));

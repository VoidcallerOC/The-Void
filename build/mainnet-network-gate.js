// Mainnet web build only (VITE_RELEASE_NETWORK=mainnet): the Fuji deployment manifests in config/
// are replaced with inert stubs, so no Fuji (43113) chain, contract or RPC configuration ships in
// the mainnet bundle. Selection already resolves to the mainnet manifests at runtime; the stubs
// keep the shared modules' imports and exports intact. The server and the Fuji build are unchanged.

export const FUJI_MANIFESTS = Object.freeze(["fuji-release.json", "fuji-release-per-contract.json", "fuji-release-per-contract-v2.json"]);

// Same keys the shared modules read. No factory address, so config/release-network.js derives no
// Fuji deployments; null chain IDs match no edition.
export const FUJI_MANIFEST_STUB = Object.freeze({
  network: "fuji",
  networkName: "Avalanche Fuji",
  chainId: null,
  chainHexId: null,
  contractAddress: null,
  primarySaleAddress: null,
  factoryAddress: null,
  implementationAddress: null,
  marketplaceAddress: null,
  rpcUrl: null,
  explorer: null,
  abi: [],
  primarySaleAbi: [],
  historicalDeployments: [],
  excludedFromBuild: true,
});

const PREFIX = "\0mainnet-gate:fuji-manifest:";

export function mainnetNetworkGate({ network } = {}) {
  const enabled = String(network || "").trim().toLowerCase() === "mainnet";
  return {
    name: "mainnet-network-gate",
    enforce: "pre",
    resolveId(source, importer) {
      if (!enabled || !importer) return null;
      const file = source.replace(/^\.\//, "");
      if (!FUJI_MANIFESTS.includes(file) || !/[\\/]config[\\/]release-network\.js$/.test(importer)) return null;
      return `${PREFIX}${file}`;
    },
    load(id) {
      if (!id.startsWith(PREFIX)) return null;
      // The import carries `with { type: "json" }`, so the stub is served as JSON text.
      return JSON.stringify(FUJI_MANIFEST_STUB);
    },
  };
}

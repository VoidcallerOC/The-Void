import { MAINNET_CHAIN_ID, MAINNET_DEPLOYER } from "./mainnet-signing-requests.mjs";

// The two networks the owner signing page runs on. A page is built for exactly one profile and never
// switches the wallet's network: it loads only its own network's approved plans, offers only that
// profile's plan kinds, and refuses a plan, an RPC or a wallet on any other chain. Browser-safe.
export const NETWORK_PROFILES = Object.freeze({
  mainnet: Object.freeze({
    network: "mainnet",
    chainId: MAINNET_CHAIN_ID,
    name: "Avalanche C-Chain",
    rpc: "https://api.avax.network/ext/bc/C/rpc",
    explorer: "https://snowtrace.io",
    deployer: MAINNET_DEPLOYER,
    kinds: Object.freeze(["release-per-contract-mainnet", "genesis-claim-mainnet"]),
    plansDir: "deploy/mainnet/approved-plans",
  }),
  // Test only. Same Rabby deployer account, so the test exercises the account that will sign mainnet,
  // but a Fuji-only plan kind, chain and nonce: no Fuji plan can bind, predict or sign a mainnet
  // transaction, and no mainnet plan is accepted here.
  fuji: Object.freeze({
    network: "fuji",
    chainId: 43113,
    name: "Avalanche Fuji testnet",
    rpc: "https://api.avax-test.network/ext/bc/C/rpc",
    explorer: "https://testnet.snowtrace.io",
    deployer: MAINNET_DEPLOYER,
    kinds: Object.freeze(["rabby-probe-fuji", "genesis-claim-fuji"]),
    plansDir: "deploy/fuji/approved-plans",
  }),
});

export class NetworkProfileError extends Error {}

export function profileFor(network) {
  const profile = NETWORK_PROFILES[network];
  if (!profile) throw new NetworkProfileError(`Unknown network ${network}.`);
  return profile;
}

/** The single profile whose plan kinds include `kind`. */
export function profileOfKind(kind) {
  const profile = Object.values(NETWORK_PROFILES).find((item) => item.kinds.includes(kind));
  if (!profile) throw new NetworkProfileError(`Unknown plan kind ${kind}.`);
  return profile;
}

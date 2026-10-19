import { RELEASE_DEPLOYMENT } from "../../config/release-network.js";
import { CHAINS } from "./web3.js";

/**
 * Wallet chain helpers for the selected release network (Fuji by default,
 * Avalanche C-Chain when VITE_RELEASE_NETWORK=mainnet).
 *
 * Connect and mainnet-only actions must call ensureReleaseChain / ensureWalletOnChain
 * so Rabby (and peers) are asked to switch or add the correct Avalanche network
 * instead of staying on Ethereum.
 */

export function toChainHexId(chainId) {
  const id = Number(chainId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError("chainId must be a positive integer.");
  return `0x${id.toString(16)}`;
}

export function releaseChainDescriptor(deployment = RELEASE_DEPLOYMENT) {
  const chainId = Number(deployment?.chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new TypeError("Release deployment is missing a valid chainId.");
  const hexId = String(deployment.chainHexId || toChainHexId(chainId)).toLowerCase();
  const networkName = String(deployment.networkName || deployment.network || `Chain ${chainId}`);
  const rpcUrl = String(deployment.rpcUrl || "").trim();
  const explorer = String(deployment.explorer || "").trim();
  const token = "AVAX";
  return Object.freeze({
    id: chainId,
    chainId,
    hexId,
    name: networkName,
    networkName,
    rpc: rpcUrl,
    rpcUrl,
    explorer,
    token,
    addEthereumChainParameter: Object.freeze({
      chainId: hexId,
      chainName: networkName,
      nativeCurrency: Object.freeze({ name: token, symbol: token, decimals: 18 }),
      rpcUrls: rpcUrl ? Object.freeze([rpcUrl]) : Object.freeze([]),
      blockExplorerUrls: explorer ? Object.freeze([explorer]) : Object.freeze([]),
    }),
  });
}

/** Resolve switch/add metadata from a marketplace `chain` object or known catalogs. */
export function resolveChainDescriptor(chain) {
  const chainId = Number(chain?.id ?? chain?.chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw Object.assign(new Error("A target chain id is required."), { code: "CHAIN_TARGET_MISSING" });

  const fromRelease = releaseChainDescriptor(RELEASE_DEPLOYMENT);
  if (chainId === fromRelease.chainId) {
    return Object.freeze({
      ...fromRelease,
      hexId: String(chain?.hexId || fromRelease.hexId).toLowerCase(),
      networkName: String(chain?.name || chain?.networkName || fromRelease.networkName),
      rpcUrl: String(chain?.rpc || chain?.rpcUrl || fromRelease.rpcUrl),
      explorer: String(chain?.explorer || fromRelease.explorer),
      token: String(chain?.token || fromRelease.token),
    });
  }

  const fromKnown = Object.values(CHAINS).find((item) => item.id === chainId);
  if (fromKnown) {
    return Object.freeze({
      chainId: fromKnown.id,
      hexId: String(chain?.hexId || fromKnown.hexId).toLowerCase(),
      networkName: String(chain?.name || fromKnown.name),
      rpcUrl: String(chain?.rpc || fromKnown.rpc),
      explorer: String(chain?.explorer || fromKnown.explorer || ""),
      token: String(chain?.token || fromKnown.token || "AVAX"),
    });
  }

  return Object.freeze({
    chainId,
    hexId: String(chain?.hexId || toChainHexId(chainId)).toLowerCase(),
    networkName: String(chain?.name || chain?.networkName || `Chain ${chainId}`),
    rpcUrl: String(chain?.rpc || chain?.rpcUrl || ""),
    explorer: String(chain?.explorer || ""),
    token: String(chain?.token || "AVAX"),
  });
}

export async function readWalletChainId(provider) {
  if (!provider || typeof provider.request !== "function") {
    throw Object.assign(new Error("A wallet provider is required."), { code: "WALLET_PROVIDER_REQUIRED" });
  }
  const raw = await provider.request({ method: "eth_chainId" });
  return Number(BigInt(raw));
}

export async function assertWalletChainId(provider, expectedChainId, networkName = `chain ${expectedChainId}`) {
  const actual = await readWalletChainId(provider);
  if (actual !== Number(expectedChainId)) {
    throw Object.assign(
      new Error(`Switch your wallet to ${networkName} (${expectedChainId}) before continuing.`),
      { code: "WRONG_CHAIN", expectedChainId: Number(expectedChainId), currentChainId: actual },
    );
  }
  return actual;
}

/** True when the wallet reports the build-selected release chain. */
export function isOnReleaseChain(chainId, deployment = RELEASE_DEPLOYMENT) {
  return Number(chainId) === Number(deployment.chainId);
}

/** User-facing copy: Avalanche (or Fuji) is required — never present Ethereum as intended. */
export function releaseNetworkRequiredMessage(deployment = RELEASE_DEPLOYMENT, { action = "continue" } = {}) {
  const name = deployment.networkName || deployment.network || `chain ${deployment.chainId}`;
  return `${name} (${deployment.chainId}) is required to ${action}. Ethereum is not supported.`;
}

/** The production release network. Only this network is ever advertised to collectors. */
export const PRODUCTION_RELEASE_CHAIN_ID = 43114;

export function isProductionReleaseDeployment(deployment = RELEASE_DEPLOYMENT) {
  return Number(deployment?.chainId) === PRODUCTION_RELEASE_CHAIN_ID;
}

function isDevServer() {
  // Vite dev server only (`vite`); every `vite build` output, previews included, is false.
  return typeof import.meta !== "undefined" && import.meta.env ? import.meta.env.DEV === true : false;
}

/**
 * Whether the collector-facing UI may offer a one-click wallet network switch. The mainnet build
 * offers "SWITCH TO AVALANCHE" (the wallet still has to approve the switch). A testnet build never
 * advertises the testnet to collectors: its switch control exists only on the Vite dev server, so
 * Fuji and preview deployments show a wrong-network notice instead.
 */
export function releaseNetworkSwitchAllowed(deployment = RELEASE_DEPLOYMENT, { dev = isDevServer() } = {}) {
  if (isProductionReleaseDeployment(deployment)) return true;
  return dev === true;
}

/** Wallet-button copy for a wrong-chain wallet. Never names a testnet. */
export function releaseNetworkSwitchLabel(deployment = RELEASE_DEPLOYMENT, { allowSwitch = releaseNetworkSwitchAllowed(deployment) } = {}) {
  if (!allowSwitch) return "WRONG NETWORK";
  if (isProductionReleaseDeployment(deployment)) return "SWITCH TO AVALANCHE";
  return "SWITCH NETWORK";
}

/** Codes that mean permission may exist but the wallet is not on the release chain. */
export const RELEASE_CHAIN_GATE_CODES = Object.freeze([
  "WRONG_CHAIN",
  "CHAIN_SWITCH_REJECTED",
  "CHAIN_ADD_REJECTED",
  "CHAIN_SWITCH_FAILED",
  "CHAIN_ADD_FAILED",
]);

export function isReleaseChainGateError(error) {
  return RELEASE_CHAIN_GATE_CODES.includes(error?.code);
}

function isUserRejection(error) {
  const code = error?.code;
  const message = String(error?.message || "");
  return code === 4001 || code === "ACTION_REJECTED" || /user rejected|user denied|rejected the request/i.test(message);
}

function isMissingChain(error) {
  return error?.code === 4902 || /unrecognized chain|unknown chain|chain.*not added|try adding the chain/i.test(String(error?.message || ""));
}

/**
 * Switch the wallet to `descriptor`, adding the network when the wallet does
 * not know it. Always re-reads eth_chainId and refuses to continue on mismatch
 * or user rejection.
 */
export async function ensureWalletOnChain(provider, chainOrDescriptor) {
  const descriptor = resolveChainDescriptor(chainOrDescriptor);
  if (!descriptor.rpcUrl) {
    throw Object.assign(new Error(`No RPC URL is configured for ${descriptor.networkName} (${descriptor.chainId}).`), { code: "CHAIN_RPC_MISSING" });
  }

  let current;
  try {
    current = await readWalletChainId(provider);
  } catch (error) {
    throw Object.assign(new Error("The wallet network could not be read."), { code: "CHAIN_READ_FAILED", cause: error });
  }
  if (current === descriptor.chainId) return descriptor.chainId;

  const switchParams = [{ chainId: descriptor.hexId }];
  const addParams = [{
    chainId: descriptor.hexId,
    chainName: descriptor.networkName,
    nativeCurrency: { name: descriptor.token, symbol: descriptor.token, decimals: 18 },
    rpcUrls: [descriptor.rpcUrl],
    ...(descriptor.explorer ? { blockExplorerUrls: [descriptor.explorer] } : {}),
  }];

  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: switchParams });
  } catch (error) {
    if (isUserRejection(error)) {
      throw Object.assign(
        new Error(`Switch to ${descriptor.networkName} (${descriptor.chainId}) was rejected. The app will not continue on the wrong network.`),
        { code: "CHAIN_SWITCH_REJECTED", cause: error, expectedChainId: descriptor.chainId },
      );
    }
    if (!isMissingChain(error)) {
      throw Object.assign(
        new Error(`Could not switch the wallet to ${descriptor.networkName} (${descriptor.chainId}).`),
        { code: "CHAIN_SWITCH_FAILED", cause: error, expectedChainId: descriptor.chainId },
      );
    }
    try {
      await provider.request({ method: "wallet_addEthereumChain", params: addParams });
    } catch (addError) {
      if (isUserRejection(addError)) {
        throw Object.assign(
          new Error(`Adding ${descriptor.networkName} (${descriptor.chainId}) was rejected. The app will not continue on the wrong network.`),
          { code: "CHAIN_ADD_REJECTED", cause: addError, expectedChainId: descriptor.chainId },
        );
      }
      throw Object.assign(
        new Error(`Could not add ${descriptor.networkName} (${descriptor.chainId}) to the wallet.`),
        { code: "CHAIN_ADD_FAILED", cause: addError, expectedChainId: descriptor.chainId },
      );
    }
    // Some wallets add without switching; request the switch again.
    try {
      const afterAdd = await readWalletChainId(provider);
      if (afterAdd !== descriptor.chainId) {
        await provider.request({ method: "wallet_switchEthereumChain", params: switchParams });
      }
    } catch (switchAfterAddError) {
      if (isUserRejection(switchAfterAddError)) {
        throw Object.assign(
          new Error(`Switch to ${descriptor.networkName} (${descriptor.chainId}) was rejected. The app will not continue on the wrong network.`),
          { code: "CHAIN_SWITCH_REJECTED", cause: switchAfterAddError, expectedChainId: descriptor.chainId },
        );
      }
      // Fall through to final assert.
    }
  }

  return assertWalletChainId(provider, descriptor.chainId, descriptor.networkName);
}

/** Ensure the wallet is on the build-selected release network (mainnet or Fuji). */
export async function ensureReleaseChain(provider, deployment = RELEASE_DEPLOYMENT) {
  return ensureWalletOnChain(provider, releaseChainDescriptor(deployment));
}

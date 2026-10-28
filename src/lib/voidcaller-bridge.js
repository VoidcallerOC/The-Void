// Bridge-specific implementation ported from the live VOIDCALLER bridge bundle.
// Keep this isolated from the shared Studio Web3 helpers so the bridge can be
// audited and updated without changing marketplace or claim behavior.

export const BRIDGE_CONTRACTS = Object.freeze({
  voidcaller: "0xd1b4367dd9f235f9ee61878019d66e31511e98ee",
  grottoRelics: "0x0d6Fa9968aa57295217737379c44eBbc1130B1Fa",
  relayer: "0x9c1d2140bad125bacf4a0dff1efa94265056988e",
  registry: "0xE329B5Ff445E4976821FdCa99D6897EC43891A6c",
  teleporter: "0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf",
  bridgeSource: "0x68539f95FB2758327A9C7EdEDa1002b0F3Ec8992",
  bridgeRemote: "0x0d6Fa9968aa57295217737379c44eBbc1130B1Fa",
});

export const BRIDGE_CHAINS = Object.freeze({
  cchain: Object.freeze({
    key: "cchain", id: 43114, hexId: "0xa86a", name: "Avalanche C-Chain", short: "C-CHAIN",
    rpc: "https://api.avax.network/ext/bc/C/rpc", explorer: "https://snowtrace.io", token: "AVAX",
    contract: BRIDGE_CONTRACTS.voidcaller,
    blockchainIdHex: "0x0427d4b22a2a78bcddd456742caf91b56badbff985ee19aef14573e7343fd652",
  }),
  grotto: Object.freeze({
    key: "grotto", id: 36463, hexId: "0x8e6f", name: "The Grotto", short: "GROTTO",
    rpc: "https://subnets.avax.network/thegrotto/mainnet/rpc", explorer: "", token: "HERESY",
    contract: BRIDGE_CONTRACTS.grottoRelics,
    blockchainIdHex: "0x4d17dde28b48d8261d0e157ff214900e6575600325f02d6efb416eebdbde4ba9",
  }),
});

export const BRIDGE_TOKEN_IDS = Object.freeze([0, 1, 2, 3]);
export const BRIDGE_SELECTORS = Object.freeze({
  balanceOf: "0x00fdd58e",
  setApprovalForAll: "0xa22cb465",
  bridgeTokens: "0xb33fecbf",
  bridgeBack: "0xf7c65f85",
});

function padAddress(value) { return value.toLowerCase().replace("0x", "").padStart(64, "0"); }
function padUint(value) { return BigInt(value).toString(16).padStart(64, "0"); }
function decodeUint(value) { return BigInt(`0x${value}`); }

export function bridgeDirection(direction) {
  if (direction === "cchain-to-grotto") return { from: BRIDGE_CHAINS.cchain, to: BRIDGE_CHAINS.grotto };
  if (direction === "grotto-to-cchain") return { from: BRIDGE_CHAINS.grotto, to: BRIDGE_CHAINS.cchain };
  throw new Error("Invalid bridge direction.");
}

export function encodeApproval() {
  return `${BRIDGE_SELECTORS.setApprovalForAll}${padAddress(BRIDGE_CONTRACTS.bridgeSource)}${padUint(1)}`;
}

function encodeBridgeArguments(tokenIds, amounts, recipient) {
  if (!Array.isArray(tokenIds) || !Array.isArray(amounts) || tokenIds.length === 0 || tokenIds.length !== amounts.length) {
    throw new Error("Token IDs and amounts must be non-empty arrays of equal length.");
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(recipient)) throw new Error("Invalid bridge recipient.");
  if (!tokenIds.every((id) => Number.isInteger(id) && id >= 0)) throw new Error("Invalid token ID.");
  if (!amounts.every((amount) => Number.isInteger(amount) && amount > 0)) throw new Error("Invalid relic amounts.");
  let data = `${padUint(96)}${padUint(128 + tokenIds.length * 32)}${padAddress(recipient)}${padUint(tokenIds.length)}`;
  for (const id of tokenIds) data += padUint(id);
  data += padUint(amounts.length);
  for (const amount of amounts) data += padUint(amount);
  return data;
}

export function encodeBridgeCall(direction, tokenIds, amounts, recipient) {
  const selector = direction === "cchain-to-grotto" ? BRIDGE_SELECTORS.bridgeTokens : BRIDGE_SELECTORS.bridgeBack;
  if (!["cchain-to-grotto", "grotto-to-cchain"].includes(direction)) throw new Error("Invalid bridge direction.");
  return `${selector}${encodeBridgeArguments(tokenIds, amounts, recipient)}`;
}

export async function bridgeRpcCall(rpcUrl, to, data) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_call", params: [{ to, data }, "latest"], id: 1 }),
  });
  const json = await response.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

export async function readBridgeBalances(account, { rpc = bridgeRpcCall } = {}) {
  const balances = { cchain: new Map(), grotto: new Map() };
  if (!/^0x[a-fA-F0-9]{40}$/.test(account || "")) return balances;
  await Promise.all(Object.entries(BRIDGE_CHAINS).map(async ([key, chain]) => {
    await Promise.all(BRIDGE_TOKEN_IDS.map(async (tokenId) => {
      try {
        const result = await rpc(chain.rpc, chain.contract, `${BRIDGE_SELECTORS.balanceOf}${padAddress(account)}${padUint(tokenId)}`);
        const amount = decodeUint(result.slice(2));
        if (amount > 0n) balances[key].set(tokenId, Number(amount));
      } catch { /* unavailable RPCs are non-fatal; the live app behaves the same way */ }
    }));
  }));
  return balances;
}

export async function switchBridgeChain(provider, chainKey) {
  const chain = BRIDGE_CHAINS[chainKey];
  if (!provider || !chain) throw new Error("Bridge wallet or chain is unavailable.");
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chain.hexId }] });
  } catch (error) {
    if (error?.code !== 4902) throw error;
    await provider.request({ method: "wallet_addEthereumChain", params: [{
      chainId: chain.hexId,
      chainName: chain.name,
      nativeCurrency: { name: chain.token, symbol: chain.token, decimals: 18 },
      rpcUrls: [chain.rpc],
    }] });
  }
}

export async function waitForBridgeReceipt(provider, txHash, { timeoutMs = 120000, intervalMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const receipt = await provider.request({ method: "eth_getTransactionReceipt", params: [txHash] });
    if (receipt) return receipt;
    if (Date.now() + intervalMs >= deadline) throw new Error("Timed out waiting for confirmation.");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function sendBridgeTransaction(provider, account, to, data, options = {}) {
  const txHash = await provider.request({ method: "eth_sendTransaction", params: [{ from: account, to, data }] });
  const receipt = await waitForBridgeReceipt(provider, txHash, options);
  if (receipt.status === "0x0") throw new Error("Transaction reverted on-chain.");
  return { txHash, receipt };
}

export async function executeBridge({ provider, account, direction, tokenIds, amounts, onStep = () => {}, receiptOptions } = {}) {
  if (!provider) throw new Error("No wallet connected.");
  if (!/^0x[a-fA-F0-9]{40}$/.test(account || "")) throw new Error("No wallet connected.");
  const { from, to } = bridgeDirection(direction);
  if (!Array.isArray(tokenIds) || !tokenIds.length) throw new Error("No relics selected.");
  if (!Array.isArray(amounts) || amounts.length !== tokenIds.length || !amounts.every((amount) => Number.isInteger(amount) && amount > 0)) throw new Error("Invalid relic amounts.");
  let step = 0;
  const send = (toAddress, data) => sendBridgeTransaction(provider, account, toAddress, data, receiptOptions);
  if (direction === "cchain-to-grotto") {
    onStep(step, "active");
    await send(BRIDGE_CONTRACTS.voidcaller, encodeApproval());
    onStep(step, "done");
    step += 1;
    onStep(step, "active");
    await send(BRIDGE_CONTRACTS.bridgeSource, encodeBridgeCall(direction, tokenIds, amounts, account));
    onStep(step, "done");
  } else {
    onStep(step, "active");
    await send(BRIDGE_CONTRACTS.bridgeRemote, encodeBridgeCall(direction, tokenIds, amounts, account));
    onStep(step, "done");
  }
  step += 1;
  onStep(step, "active");
  return { from, to };
}

// ===========================================================================
// VOIDCALLER — on-chain layer
// Dependency-free web3: raw provider.request() + hand-rolled ABI encoding.
// Ported from the original dev's app.js — ownership, transfer, and the
// Avalanche ICM cross-chain bridge between C-Chain and The Grotto.
// ===========================================================================

export const CONTRACTS = {
  // Voidcaller ERC-1155 on Avalanche C-Chain (the released self-titled EP).
  voidcaller: "0xd1b4367dd9f235f9ee61878019d66e31511e98ee",
  // Wrapped relics live here on The Grotto (the bridge remote also IS the
  // ERC-1155 on Grotto). Read-only for balances; also the bridge-back target.
  grottoRelics: "0x0d6Fa9968aa57295217737379c44eBbc1130B1Fa",
  // ICM relay infrastructure on C-Chain.
  relayer: "0x9c1d2140bad125bacf4a0dff1efa94265056988e",
  registry: "0xE329B5Ff445E4976821FdCa99D6897EC43891A6c",
  teleporter: "0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf",
  // Cross-chain bridge endpoints.
  // bridgeSource: VoidcallerNFTBridge on C-Chain (locks relics, emits ICM msg).
  bridgeSource: "0x68539f95FB2758327A9C7EdEDa1002b0F3Ec8992",
  // bridgeRemote: VoidcallerNFTRemote on Grotto — also the ERC-1155 on Grotto.
  bridgeRemote: "0x0d6Fa9968aa57295217737379c44eBbc1130B1Fa",
};

export const CHAINS = {
  cchain: {
    key: "cchain",
    id: 43114,
    hexId: "0xa86a",
    name: "Avalanche C-Chain",
    short: "C-CHAIN",
    rpc: "https://api.avax.network/ext/bc/C/rpc",
    explorer: "https://snowtrace.io",
    token: "AVAX",
    contract: CONTRACTS.voidcaller,
    blockchainIdHex: "0x0427d4b22a2a78bcddd456742caf91b56badbff985ee19aef14573e7343fd652",
  },
  grotto: {
    key: "grotto",
    id: 36463,
    hexId: "0x8e6f",
    name: "The Grotto",
    short: "GROTTO",
    rpc: "https://subnets.avax.network/thegrotto/mainnet/rpc",
    explorer: "",
    token: "HERESY",
    contract: CONTRACTS.grottoRelics,
    blockchainIdHex: "0x4d17dde28b48d8261d0e157ff214900e6575600325f02d6efb416eebdbde4ba9",
  },
};

// Released collection lives at token ids 0–3 on C-Chain.
export const RELIC_TOKEN_IDS = [0, 1, 2, 3];

const IPFS_GATEWAY = "https://gateway.pinata.cloud/ipfs/";
const IPFS_BASE_CID = "bafybeigft5uayq6i6ada64mc33if7yxs74kfes7pxa3a7umjr2s6njdxte";

// ERC-1155 selectors
const SEL = {
  balanceOf: "0x00fdd58e", // balanceOf(address,uint256)
  safeTransferFrom: "0xf242432a", // safeTransferFrom(address,address,uint256,uint256,bytes)
  setApprovalForAll: "0xa22cb465", // setApprovalForAll(address,bool)
};

// Bridge contract selectors
const BRIDGE_SEL = {
  // VoidcallerNFTBridge (C-Chain): bridgeTokens(uint256[],uint256[],address)
  bridgeTokens: "0xb33fecbf",
  // VoidcallerNFTRemote (Grotto): bridgeBack(uint256[],uint256[],address)
  bridgeBack: "0xf7c65f85",
};

// Hardcoded metadata so the reliquary still renders if IPFS is unreachable.
export const FALLBACK_METADATA = [
  { tokenId: 0, name: "Enough", image: "ipfs://QmfCKKX55HdmKw6cFiM1qCFeLhXc3UNrs3rmHfG8CjMbJP/0.gif", animation_url: "ipfs://QmfCKKX55HdmKw6cFiM1qCFeLhXc3UNrs3rmHfG8CjMbJP/0.mp3" },
  { tokenId: 1, name: "The Hollow", image: "ipfs://QmfCKKX55HdmKw6cFiM1qCFeLhXc3UNrs3rmHfG8CjMbJP/1.gif", animation_url: "ipfs://QmfCKKX55HdmKw6cFiM1qCFeLhXc3UNrs3rmHfG8CjMbJP/1.mp3" },
  { tokenId: 2, name: "Don't Look Down", image: "ipfs://QmeR8MoKr3PYDUVvVy1PzhXzBNPFtNZjoioGMBapYqBePs", animation_url: "ipfs://QmT4MVGxkxaxyQWn2Hk7LZVEALGDykVqcaWecx5KNV3Hkn" },
  { tokenId: 3, name: "Complex", image: "ipfs://bafybeic2idq4wqbh5kt7sibfypedj4mejgvos2mh76x2wk3ezxuiljxjaa/3.gif", animation_url: "ipfs://bafybeic2idq4wqbh5kt7sibfypedj4mejgvos2mh76x2wk3ezxuiljxjaa/3.wav" },
];

// ---------- IPFS ----------
export function ipfsToHttp(uri) {
  if (!uri) return "";
  if (uri.startsWith("ipfs://")) return IPFS_GATEWAY + uri.slice(7);
  return uri;
}

// ---------- ABI encode/decode ----------
function padAddr(addr) {
  return addr.toLowerCase().replace("0x", "").padStart(64, "0");
}
function padUint(num) {
  return BigInt(num).toString(16).padStart(64, "0");
}
function decodeUint(hex) {
  return BigInt("0x" + hex);
}

// ---------- RPC ----------
export async function rpcCall(rpcUrl, to, data) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_call", params: [{ to, data }, "latest"], id: 1 }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

// ---------- Metadata ----------
async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchAllMetadata() {
  const fetches = RELIC_TOKEN_IDS.map(async (id) => {
    try {
      const resp = await fetchWithTimeout(`${IPFS_GATEWAY}${IPFS_BASE_CID}/${id}`, 12000);
      if (!resp.ok) return null;
      const data = await resp.json();
      return { ...data, tokenId: id };
    } catch {
      return null;
    }
  });
  const results = (await Promise.all(fetches)).filter(Boolean);
  return results.length ? results : FALLBACK_METADATA;
}

// ---------- Ownership ----------
// Returns { cchain: Set<tokenId>, grotto: Set<tokenId> } for an address.
export async function checkOwnership(account) {
  const owned = { cchain: new Set(), grotto: new Set() };
  if (!account) return owned;

  const readChain = async (chain, set) => {
    await Promise.all(
      RELIC_TOKEN_IDS.map(async (id) => {
        try {
          const data = SEL.balanceOf + padAddr(account) + padUint(id);
          const result = await rpcCall(chain.rpc, chain.contract, data);
          if (decodeUint(result.slice(2)) > 0n) set.add(id);
        } catch {
          // individual / chain failure is non-fatal (e.g. Grotto not minted)
        }
      })
    );
  };

  await Promise.all([
    readChain(CHAINS.cchain, owned.cchain),
    readChain(CHAINS.grotto, owned.grotto),
  ]);
  return owned;
}

export function isOwned(owned, tokenId) {
  if (!owned) return false;
  return owned.cchain.has(tokenId) || owned.grotto.has(tokenId);
}

// ---------- Chain switching ----------
export async function switchChain(provider, chainKey) {
  const c = CHAINS[chainKey];
  if (!provider || !c) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: c.hexId }] });
  } catch (err) {
    if (err.code === 4902) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: c.hexId,
          chainName: c.name,
          nativeCurrency: { name: c.token, symbol: c.token, decimals: 18 },
          rpcUrls: [c.rpc],
        }],
      });
    } else {
      throw err;
    }
  }
}

// ---------- Transaction receipt ----------
// Poll eth_getTransactionReceipt via an EIP-1193 provider until the tx is
// mined or we time out. Resolves with the receipt (status "0x1" = success,
// "0x0" = reverted); throws if no receipt appears before the deadline.
export async function waitForReceipt(provider, txHash, { timeoutMs = 120000, intervalMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const receipt = await provider.request({
      method: "eth_getTransactionReceipt",
      params: [txHash],
    });
    if (receipt) return receipt;
    if (Date.now() + intervalMs >= deadline) {
      throw new Error("Timed out waiting for confirmation.");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// ---------- Transfer ----------
// safeTransferFrom(from, to, id, 1, "") on the chain's ERC-1155.
export function encodeTransfer(from, to, tokenId) {
  return (
    SEL.safeTransferFrom +
    padAddr(from) +
    padAddr(to) +
    padUint(tokenId) +
    padUint(1) +
    padUint(160) + // offset to bytes data (5 * 32)
    padUint(0) // bytes length = 0
  );
}

export function shortAddr(addr) {
  if (!addr) return "";
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

export function isValidAddress(addr) {
  return /^0x[a-fA-F0-9]{40}$/.test(addr);
}

// ---------- Bridge ----------
// approve(bridgeSource, true) on the C-Chain ERC-1155 — required once before
// the first lock-and-send so the bridge contract can pull the relic.
export function encodeBridgeApproval() {
  return SEL.setApprovalForAll + padAddr(CONTRACTS.bridgeSource) + padUint(1);
}

// Shared ABI encoding for fn(uint256[] tokenIds, uint256[] amounts, address recipient).
// Layout: offset_tokenIds | offset_amounts | recipient | tokenIds_len | ...tokenIds | amounts_len | ...amounts
function encodeBridgeArgs(tokenIds, amounts, recipient) {
  const tokenIdsOffset = 3 * 32; // head is 3 slots: two offsets + recipient
  const amountsOffset = tokenIdsOffset + 32 + tokenIds.length * 32;

  let data = padUint(tokenIdsOffset) + padUint(amountsOffset) + padAddr(recipient);
  data += padUint(tokenIds.length);
  for (const id of tokenIds) data += padUint(id);
  data += padUint(amounts.length);
  for (const amt of amounts) data += padUint(amt);
  return data;
}

// bridgeTokens(uint256[],uint256[],address) on the C-Chain bridge — locks
// relics and emits the ICM message that mints their wrapped form on Grotto.
export function encodeBridgeTokens(tokenIds, recipient) {
  const amounts = tokenIds.map(() => 1);
  return BRIDGE_SEL.bridgeTokens + encodeBridgeArgs(tokenIds, amounts, recipient);
}

// bridgeBack(uint256[],uint256[],address) on the Grotto remote — burns the
// wrapped relics and emits the ICM message that unlocks them on C-Chain.
export function encodeBridgeBack(tokenIds, recipient) {
  const amounts = tokenIds.map(() => 1);
  return BRIDGE_SEL.bridgeBack + encodeBridgeArgs(tokenIds, amounts, recipient);
}

// direction is "cchain-to-grotto" or "grotto-to-cchain".
export function bridgeRoute(direction) {
  return direction === "cchain-to-grotto"
    ? { from: CHAINS.cchain, to: CHAINS.grotto }
    : { from: CHAINS.grotto, to: CHAINS.cchain };
}

// Runs the full bridge flow for the selected relics and reports progress via
// onStep(stepIndex, status) where status is "active" | "done" | "error".
// Resolves once the lock/burn transaction (and approval, if needed) confirm
// on the source chain — the ICM relay to the destination happens off-chain
// and is reported as a final informational step.
export async function executeBridge({ provider, account, direction, tokenIds, onStep }) {
  if (!provider) throw new Error("No wallet connected.");
  if (!tokenIds.length) throw new Error("No relics selected.");

  const { from, to } = bridgeRoute(direction);
  const isOutbound = direction === "cchain-to-grotto";
  let step = 0;

  const send = async (to_, data) => {
    const txHash = await provider.request({
      method: "eth_sendTransaction",
      params: [{ from: account, to: to_, data }],
    });
    const receipt = await waitForReceipt(provider, txHash);
    if (receipt.status === "0x0") throw new Error("Transaction reverted on-chain.");
    return receipt;
  };

  if (isOutbound) {
    onStep(step, "active");
    await send(CONTRACTS.voidcaller, encodeBridgeApproval());
    onStep(step, "done");
    step += 1;

    onStep(step, "active");
    await send(CONTRACTS.bridgeSource, encodeBridgeTokens(tokenIds, account));
    onStep(step, "done");
  } else {
    onStep(step, "active");
    await send(CONTRACTS.bridgeRemote, encodeBridgeBack(tokenIds, account));
    onStep(step, "done");
  }
  step += 1;

  // ICM relay step is informational only — the receiving chain mints/unlocks
  // once Avalanche's Teleporter relays the message, typically within ~15s.
  onStep(step, "active");
  return { from, to };
}

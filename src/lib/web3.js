// ===========================================================================
// VOIDCALLER — on-chain layer
// Dependency-free web3: raw provider.request() + hand-rolled ABI encoding.
// Ported from the original dev's app.js, stripped to ownership + transfer
// (the cross-chain bridge is intentionally left out for now).
// ===========================================================================

export const CONTRACTS = {
  // Voidcaller ERC-1155 on Avalanche C-Chain (the released self-titled EP).
  voidcaller: "0xd1b4367dd9f235f9ee61878019d66e31511e98ee",
  // Wrapped relics live here on The Grotto (the bridge remote also IS the
  // ERC-1155 on Grotto). Read-only here — we only check balances.
  grottoRelics: "0x0d6Fa9968aa57295217737379c44eBbc1130B1Fa",
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
  },
};

// Released collection lives at token ids 0–3 on C-Chain.
// Any one of these is a Chapter I relic and unlocks the full EP.
export const RELIC_TOKEN_IDS = [0, 1, 2, 3];

const IPFS_GATEWAY = "https://gateway.pinata.cloud/ipfs/";
const IPFS_BASE_CID = "bafybeigft5uayq6i6ada64mc33if7yxs74kfes7pxa3a7umjr2s6njdxte";

// ERC-1155 selectors
const SEL = {
  balanceOf: "0x00fdd58e", // balanceOf(address,uint256)
  safeTransferFrom: "0xf242432a", // safeTransferFrom(address,address,uint256,uint256,bytes)
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

export function ownedIds(owned) {
  return new Set([...(owned?.cchain || []), ...(owned?.grotto || [])]);
}

export function isOwned(owned, tokenId) {
  if (!owned) return false;
  return owned.cchain.has(tokenId) || owned.grotto.has(tokenId);
}

export function holdsChapterI(owned) {
  return RELIC_TOKEN_IDS.some((id) => isOwned(owned, id));
}

// Computed marks. No new token — the relics are the identity.
export function choirIdentity(owned) {
  const ids = ownedIds(owned);
  const chapterICount = RELIC_TOKEN_IDS.filter((id) => ids.has(id)).length;
  const witness = chapterICount > 0;
  const choir = chapterICount === RELIC_TOKEN_IDS.length;
  const crossed = (owned?.grotto?.size || 0) > 0;
  const marks = [
    witness && "WITNESS",
    choir && "CHOIR",
    crossed && "CROSSED",
  ].filter(Boolean);
  return {
    witness,
    bearer: witness,
    choir,
    crossed,
    firstCall: false,
    chapterICount,
    marks,
  };
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

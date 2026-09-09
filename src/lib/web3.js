// Music-native platform on-chain layer.
// Dependency-free Web3: raw provider.request() + hand-rolled ABI encoding.

export const CONTRACTS = {
  voidcaller: "0xd1b4367dd9f235f9ee61878019d66e31511e98ee",
  grottoRelics: "0x0d6Fa9968aa57295217737379c44eBbc1130B1Fa",
};

export const CHAINS = {
  cchain: { key: "cchain", id: 43114, hexId: "0xa86a", name: "Avalanche C-Chain", short: "C-CHAIN", rpc: "https://api.avax.network/ext/bc/C/rpc", explorer: "https://snowtrace.io", token: "AVAX", contract: CONTRACTS.voidcaller },
  grotto: { key: "grotto", id: 36463, hexId: "0x8e6f", name: "The Grotto", short: "GROTTO", rpc: "https://subnets.avax.network/thegrotto/mainnet/rpc", explorer: "", token: "HERESY", contract: CONTRACTS.grottoRelics },
};

export const RELIC_TOKEN_IDS = [0, 1, 2, 3];
const IPFS_GATEWAY = "https://gateway.pinata.cloud/ipfs/";
const IPFS_BASE_CID = "bafybeigft5uayq6i6ada64mc33if7yxs74kfes7pxa3a7umjr2s6njdxte";
export const DEFAULT_COLLECTION_CONFIG = { chains: CHAINS, tokenIds: RELIC_TOKEN_IDS, metadata: { gateway: IPFS_GATEWAY, baseCid: IPFS_BASE_CID } };

const SEL = { balanceOf: "0x00fdd58e", safeTransferFrom: "0xf242432a" };
export const FALLBACK_METADATA = [
  { tokenId: 0, name: "Enough", image: "ipfs://QmfCKKX55HdmKw6cFiM1qCFeLhXc3UNrs3rmHfG8CjMbJP/0.gif", animation_url: "ipfs://QmfCKKX55HdmKw6cFiM1qCFeLhXc3UNrs3rmHfG8CjMbJP/0.mp3" },
  { tokenId: 1, name: "The Hollow", image: "ipfs://QmfCKKX55HdmKw6cFiM1qCFeLhXc3UNrs3rmHfG8CjMbJP/1.gif", animation_url: "ipfs://QmfCKKX55HdmKw6cFiM1qCFeLhXc3UNrs3rmHfG8CjMbJP/1.mp3" },
  { tokenId: 2, name: "Don't Look Down", image: "ipfs://QmeR8MoKr3PYDUVvVy1PzhXzBNPFtNZjoioGMBapYqBePs", animation_url: "ipfs://QmT4MVGxkxaxyQWn2Hk7LZVEALGDykVqcaWecx5KNV3Hkn" },
  { tokenId: 3, name: "Complex", image: "ipfs://bafybeic2idq4wqbh5kt7sibfypedj4mejgvos2mh76x2wk3ezxuiljxjaa/3.gif", animation_url: "ipfs://bafybeic2idq4wqbh5kt7sibfypedj4mejgvos2mh76x2wk3ezxuiljxjaa/3.wav" },
];

export function ipfsToHttp(uri, gateway = IPFS_GATEWAY) { if (!uri) return ""; return uri.startsWith("ipfs://") ? gateway + uri.slice(7) : uri; }
function padAddr(addr) { return addr.toLowerCase().replace("0x", "").padStart(64, "0"); }
function padUint(num) { return BigInt(num).toString(16).padStart(64, "0"); }
function decodeUint(hex) { return BigInt("0x" + hex); }

export async function rpcCall(rpcUrl, to, data) {
  const res = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "eth_call", params: [{ to, data }, "latest"], id: 1 }) });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}
async function fetchWithTimeout(url, ms) { const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), ms); try { return await fetch(url, { signal: ctrl.signal }); } finally { clearTimeout(timer); } }

export async function fetchTokenMetadata({ tokenIds = RELIC_TOKEN_IDS, gateway = IPFS_GATEWAY, baseCid = IPFS_BASE_CID, fallback = FALLBACK_METADATA } = {}) {
  const results = (await Promise.all(tokenIds.map(async (id) => {
    try { const resp = await fetchWithTimeout(`${gateway}${baseCid}/${id}`, 12000); if (!resp.ok) return null; return { ...(await resp.json()), tokenId: id }; } catch { return null; }
  }))).filter(Boolean);
  return results.length ? results : fallback;
}
export const fetchAllMetadata = (options = {}) => fetchTokenMetadata({ tokenIds: RELIC_TOKEN_IDS, gateway: IPFS_GATEWAY, baseCid: IPFS_BASE_CID, fallback: FALLBACK_METADATA, ...options });

export async function checkCollectionOwnership(account, { chains = CHAINS, tokenIds = RELIC_TOKEN_IDS } = {}) {
  const owned = Object.fromEntries(Object.keys(chains).map((key) => [key, new Set()]));
  if (!account) return owned;
  await Promise.all(Object.entries(chains).map(async ([key, chain]) => {
    await Promise.all(tokenIds.map(async (id) => {
      try { const result = await rpcCall(chain.rpc, chain.contract, SEL.balanceOf + padAddr(account) + padUint(id)); if (decodeUint(result.slice(2)) > 0n) owned[key].add(id); } catch { /* an unavailable chain is non-fatal */ }
    }));
  }));
  return owned;
}
export const checkOwnership = (account, options = {}) => checkCollectionOwnership(account, { chains: CHAINS, tokenIds: RELIC_TOKEN_IDS, ...options });
export async function checkCollectionOwnershipRecords(account, { chains = CHAINS, tokenIds = RELIC_TOKEN_IDS, contracts = null, rpc = rpcCall } = {}) {
  if (!account) return [];
  const records = [];
  await Promise.all(Object.entries(chains).map(async ([key, chain]) => {
    const contract = contracts?.[key] || chain.contract;
    await Promise.all(tokenIds.map(async (id) => {
      try {
        const result = await rpc(chain.rpc, contract, SEL.balanceOf + padAddr(account) + padUint(id));
        const amount = decodeUint(result.slice(2));
        if (amount > 0n) records.push({ wallet: account.toLowerCase(), contract: contract.toLowerCase(), tokenId: String(id), amount: Number(amount), chain: { key, id: chain.id, name: chain.name }, updatedAt: Date.now() });
      } catch { /* an unavailable chain is non-fatal */ }
    }));
  }));
  return records;
}
export const checkOwnershipRecords = (account, options = {}) => checkCollectionOwnershipRecords(account, { chains: CHAINS, tokenIds: RELIC_TOKEN_IDS, ...options });
export function ownedIds(owned) { return new Set(Object.values(owned || {}).flatMap((ids) => [...(ids || [])])); }
export function isOwned(owned, tokenId) { return ownedIds(owned).has(tokenId); }
export function holdsChapterI(owned) { return RELIC_TOKEN_IDS.some((id) => isOwned(owned, id)); }
export function choirIdentity(owned) { const ids = ownedIds(owned); const chapterICount = RELIC_TOKEN_IDS.filter((id) => ids.has(id)).length; const witness = chapterICount > 0; const choir = chapterICount === RELIC_TOKEN_IDS.length; const crossed = (owned?.grotto?.size || 0) > 0; return { witness, bearer: witness, choir, crossed, firstCall: false, chapterICount, marks: [witness && "WITNESS", choir && "CHOIR", crossed && "CROSSED"].filter(Boolean) }; }

export function createCollectionClient(config = {}) {
  const collection = { ...DEFAULT_COLLECTION_CONFIG, ...config, metadata: { ...DEFAULT_COLLECTION_CONFIG.metadata, ...(config.metadata || {}) } };
  return { fetchMetadata: (options = {}) => fetchTokenMetadata({ ...collection.metadata, fallback: collection.fallback || FALLBACK_METADATA, ...options }), checkOwnership: (account) => checkCollectionOwnership(account, collection), switchChain: (provider, key) => switchChain(provider, key, collection.chains) };
}
export async function switchChain(provider, chainKey, chains = CHAINS) { const c = chains[chainKey]; if (!provider || !c) return; try { await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: c.hexId }] }); } catch (err) { if (err.code !== 4902) throw err; await provider.request({ method: "wallet_addEthereumChain", params: [{ chainId: c.hexId, chainName: c.name, nativeCurrency: { name: c.token, symbol: c.token, decimals: 18 }, rpcUrls: [c.rpc] }] }); } }
export async function waitForReceipt(provider, txHash, { timeoutMs = 120000, intervalMs = 3000 } = {}) { const deadline = Date.now() + timeoutMs; for (;;) { const receipt = await provider.request({ method: "eth_getTransactionReceipt", params: [txHash] }); if (receipt) return receipt; if (Date.now() + intervalMs >= deadline) throw new Error("Timed out waiting for confirmation."); await new Promise((resolve) => setTimeout(resolve, intervalMs)); } }
export function encodeTransfer(from, to, tokenId, amount = 1, data = "") { const bytes = data.replace(/^0x/, ""); return SEL.safeTransferFrom + padAddr(from) + padAddr(to) + padUint(tokenId) + padUint(amount) + padUint(160) + padUint(bytes ? bytes.length / 2 : 0) + (bytes ? bytes.padEnd(64, "0") : ""); }
export function shortAddr(addr) { if (!addr) return ""; return addr.slice(0, 6) + "…" + addr.slice(-4); }
export function isValidAddress(addr) { return /^0x[a-fA-F0-9]{40}$/.test(addr); }

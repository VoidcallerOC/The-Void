import { ethers } from "ethers";
import { RELEASE_DEPLOYMENT as deployment } from "../../config/release-network.js";
import { FUJI_RELEASE_PER_CONTRACT, FUJI_RELEASE_PER_CONTRACT_V2 } from "../../config/release-network.js";
import { waitForReceipt } from "./web3.js";

export const FUJI_RELEASE_CONFIG = Object.freeze({ ...deployment, network: deployment.networkName });
export const FUJI_RELEASE_FACTORY_CONFIG = Object.freeze({ ...FUJI_RELEASE_PER_CONTRACT, network: FUJI_RELEASE_PER_CONTRACT.networkName });
export const FUJI_RELEASE_FACTORY_V2_CONFIG = Object.freeze({ ...FUJI_RELEASE_PER_CONTRACT_V2, network: FUJI_RELEASE_PER_CONTRACT_V2.networkName });
export const FUJI_RELEASE_ABI = Object.freeze(deployment.abi);

export const FUJI_ROLES = Object.freeze({
  DEFAULT_ADMIN_ROLE: `0x${"00".repeat(32)}`,
  ARTIST_ROLE: ethers.keccak256(ethers.toUtf8Bytes("ARTIST_ROLE")),
  ISSUER_ROLE: ethers.keccak256(ethers.toUtf8Bytes("ISSUER_ROLE")),
});

// Each E2E run mints one copy into its own fresh one-copy edition. Catalog
// slugs are [a-z0-9-] only, so the colon in this release identifier keeps E2E
// token IDs out of the catalog's ID space.
export const FUJI_E2E_MINT = Object.freeze({
  wallet: "0xabd3746e8b852f55be52fc44fab6cab908b1c174",
  releaseId: "the-void:e2e-mint",
  quantity: 1n,
  maxSupply: 1n,
  // Published catalog edition "Marketplace Fuji E2E Test", already minted by
  // 0xb383e31e…; the earlier control reused it and reverted (0x40836461…).
  retiredTokenIds: Object.freeze([69621777096996404494569967715110965261109496187347335164928263396549073080909n]),
});

const FUJI_E2E_EDITION_ID = /^run:[0-9a-z]{1,13}-[0-9a-f]{12}$/;

export function fujiSlug(value, name = "id") {
  const slug = String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) throw new Error(name.toLowerCase().includes("release") ? "Enter a release title before publishing." : "A name is required before publishing.");
  if (slug.length > 31) throw new Error(`${name} must be at most 31 characters for the certified Fuji path.`);
  return slug;
}

export function isCertifiedFujiEdition(edition) {
  return Boolean(edition)
    && String(edition.contractAddress || "").toLowerCase() === FUJI_RELEASE_CONFIG.contractAddress.toLowerCase()
    && Number(edition.chainId) === FUJI_RELEASE_CONFIG.chainId;
}

const iface = new ethers.Interface(FUJI_RELEASE_ABI);
const editionIface = new ethers.Interface([
  "function edition(uint256) view returns (tuple(bytes32 releaseId, bytes32 editionId, address artist, uint256 maxSupply, uint256 mintedSupply, string metadataUri, bool exists))",
  "error EditionNotFound(uint256 tokenId)",
  "event EditionCreated(uint256 indexed tokenId, bytes32 indexed releaseId, bytes32 indexed editionId, address artist, uint256 maxSupply, string metadataUri)",
]);
const mintIface = new ethers.Interface([
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
]);
const releaseFactoryV2Iface = new ethers.Interface([
  "function createRelease(bytes32 applicationReleaseId,bytes32 releaseKey,string name,string symbol,string contractURI) returns (address releaseContract,address primarySale,address provenanceAnchor)",
  "function releaseContractOf(bytes32 releaseKey) view returns(address)",
  "event ReleaseCreated(address indexed releaseContract,bytes32 indexed releaseKey,address indexed artist,address primarySale,address provenanceAnchor,address implementation,uint256 index,uint16 version)",
]);
const releaseCloneInitIface = new ethers.Interface([
  "function owner() view returns(address)",
  "function releaseKey() view returns(bytes32)",
  "function name() view returns(string)",
  "function symbol() view returns(string)",
  "function contractURI() view returns(string)",
]);
const bytes32 = (value, name) => {
  const text = String(value || "").trim();
  if (!text || text.length > 31) throw new Error(`${name} must be non-empty and at most 31 bytes.`);
  return ethers.encodeBytes32String(text);
};

export function fujiIds(releaseId, editionId) {
  return { releaseId: bytes32(releaseId, "releaseId"), editionId: bytes32(editionId, "editionId") };
}

function assertReleaseFactoryV2Configured() {
  const config = FUJI_RELEASE_FACTORY_V2_CONFIG;
  if (config.provisioningEnabled !== true || config.deploymentAuthorized !== true || !ethers.isAddress(config.factoryAddress || "") || ethers.getAddress(config.factoryAddress) === ethers.ZeroAddress) {
    throw new Error("Artist-paid release creation is not enabled: the separately authorized Factory V2 deployment has not been configured. The old Factory will not be used.");
  }
  return { ...config, factoryAddress: ethers.getAddress(config.factoryAddress) };
}

export function encodeArtistReleaseCreation({ applicationReleaseId, releaseKey, name, symbol, contractURI = "" }) {
  if (!/^0x[0-9a-f]{64}$/i.test(String(applicationReleaseId || "")) || /^0x0{64}$/i.test(String(applicationReleaseId))) throw new Error("A non-zero application release digest is required.");
  if (!/^0x[0-9a-f]{64}$/i.test(String(releaseKey || "")) || /^0x0{64}$/i.test(String(releaseKey))) throw new Error("A non-zero deterministic release key is required.");
  const releaseName = String(name || "").trim();
  const releaseSymbol = String(symbol || "").trim();
  if (!releaseName || !releaseSymbol) throw new Error("The exact release name and symbol are required.");
  const normalizedURI = String(contractURI || "");
  return { data: releaseFactoryV2Iface.encodeFunctionData("createRelease", [applicationReleaseId, releaseKey, releaseName, releaseSymbol, normalizedURI]), applicationReleaseId: String(applicationReleaseId).toLowerCase(), releaseKey: String(releaseKey).toLowerCase(), name: releaseName, symbol: releaseSymbol, contractURI: normalizedURI };
}

/** Broadcasts from the artist's connected wallet. No backend or platform signer is involved. */
export async function submitArtistReleaseCreation({ provider, from, payload }) {
  const config = assertReleaseFactoryV2Configured();
  await assertFujiProvider(provider);
  if (!ethers.isAddress(from) || ethers.getAddress(from) === ethers.ZeroAddress) throw new Error("Connect the canonical artist OWNER wallet before creating this release.");
  const encoded = encodeArtistReleaseCreation(payload);
  const transaction = { from: ethers.getAddress(from), to: config.factoryAddress, data: encoded.data };
  // Simulate the exact call before opening the wallet confirmation.
  await provider.request({ method: "eth_call", params: [transaction, "latest"] });
  const hash = await requestWithTimeout(provider, { method: "eth_sendTransaction", params: [transaction] });
  if (!/^0x[0-9a-f]{64}$/i.test(String(hash || ""))) throw new Error("The wallet returned an invalid release creation transaction hash.");
  return { hash, factoryAddress: config.factoryAddress, chainId: Number(config.chainId), releaseKey: encoded.releaseKey, gasPayer: ethers.getAddress(from) };
}

async function readReleaseCloneValue(provider, address, fragment) {
  const data = releaseCloneInitIface.encodeFunctionData(fragment);
  const result = await provider.request({ method: "eth_call", params: [{ to: address, data }, "latest"] });
  return releaseCloneInitIface.decodeFunctionResult(fragment, result)[0];
}

/** Waits for a mined receipt and verifies the emitting V2 Factory, event, registry and clone initialization. */
export async function verifyArtistReleaseCreation(provider, { transactionHash, expected }) {
  const config = assertReleaseFactoryV2Configured();
  await assertFujiProvider(provider);
  if (Number(expected.chainId) !== Number(config.chainId) || String(expected.factoryAddress).toLowerCase() !== config.factoryAddress.toLowerCase()) throw new Error("The prepared release authorization targets a different chain or Factory.");
  const expectedKey = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256", "address", "bytes32", "address"], ["the-void:studio-release:v2", BigInt(config.chainId), config.factoryAddress, expected.applicationReleaseId, expected.artistWallet]));
  if (expectedKey.toLowerCase() !== String(expected.releaseKey).toLowerCase()) throw new Error("The prepared release key does not commit to the application ID, artist, chain, and Factory.");
  const receipt = await waitForReceipt(provider, transactionHash);
  if (!receipt || receipt.status !== "0x1") throw Object.assign(new Error("The artist-paid release creation transaction did not receive a successful Fuji receipt."), { transactionHash });
  const event = (receipt.logs || []).filter((log) => String(log.address || "").toLowerCase() === config.factoryAddress.toLowerCase()).map((log) => {
    try { return releaseFactoryV2Iface.parseLog(log); } catch { return null; }
  }).find((parsed) => parsed?.name === "ReleaseCreated" && String(parsed.args.releaseKey).toLowerCase() === String(expected.releaseKey).toLowerCase());
  if (!event || String(event.args.artist).toLowerCase() !== String(expected.artistWallet).toLowerCase() || BigInt(event.args.version) !== 2n) throw new Error("The confirmed transaction did not emit the exact V2 ReleaseCreated event for this artist and release key.");
  const releaseContractAddress = ethers.getAddress(event.args.releaseContract);
  const primarySaleAddress = ethers.getAddress(event.args.primarySale);
  const provenanceAnchorAddress = ethers.getAddress(event.args.provenanceAnchor);
  const registered = await provider.request({ method: "eth_call", params: [{ to: config.factoryAddress, data: releaseFactoryV2Iface.encodeFunctionData("releaseContractOf", [expected.releaseKey]) }, "latest"] });
  const registeredAddress = releaseFactoryV2Iface.decodeFunctionResult("releaseContractOf", registered)[0];
  if (String(registeredAddress).toLowerCase() !== releaseContractAddress.toLowerCase()) throw new Error("Factory registry does not point to the ReleaseCreated contract.");
  const [owner, key, name, symbol, contractURI] = await Promise.all(["owner", "releaseKey", "name", "symbol", "contractURI"].map((field) => readReleaseCloneValue(provider, releaseContractAddress, field)));
  if (String(owner).toLowerCase() !== String(expected.artistWallet).toLowerCase() || String(key).toLowerCase() !== String(expected.releaseKey).toLowerCase() || name !== expected.name || symbol !== expected.symbol || contractURI !== String(expected.contractURI || "")) {
    throw new Error("The deployed clone's owner, key, name, symbol, or contract URI differs from the exact parameters shown in Studio.");
  }
  return { receipt, releaseContractAddress, primarySaleAddress, provenanceAnchorAddress, releaseKey: expected.releaseKey, artistWallet: expected.artistWallet, factoryAddress: config.factoryAddress, chainId: Number(config.chainId), implementationAddress: ethers.getAddress(event.args.implementation), version: Number(event.args.version) };
}

export function fujiTokenId(releaseId, editionId) {
  const ids = fujiIds(releaseId, editionId);
  const digest = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32", "bytes32"], ["the-void:edition:v1", ids.releaseId, ids.editionId]));
  const tokenId = BigInt(digest);
  return tokenId === 0n ? 1n : tokenId;
}

/** The VoidRoleGranter that lets reviewers grant publishing roles, or "" until it is deployed. */
export function fujiRoleGranterAddress() {
  const value = String(FUJI_RELEASE_CONFIG.roleGranterAddress || "").trim();
  if (!ethers.isAddress(value) || ethers.getAddress(value) === ethers.ZeroAddress) return "";
  return ethers.getAddress(value);
}

export function assertFujiTransactionTarget(address) {
  if (!ethers.isAddress(address)) throw new Error("Only the certified Fuji release or its primary sale contract is allowed for this path.");
  const target = ethers.getAddress(address);
  if (target.toLowerCase() === FUJI_RELEASE_CONFIG.contractAddress.toLowerCase()) return ethers.getAddress(FUJI_RELEASE_CONFIG.contractAddress);
  const sale = String(FUJI_RELEASE_CONFIG.primarySaleAddress || "");
  if (ethers.isAddress(sale) && ethers.getAddress(sale) !== ethers.ZeroAddress && target.toLowerCase() === sale.toLowerCase()) return ethers.getAddress(sale);
  const granter = fujiRoleGranterAddress();
  if (granter && target.toLowerCase() === granter.toLowerCase()) return granter;
  throw new Error("Only the certified Fuji release or its primary sale contract is allowed for this path.");
}

export function assertFujiAddress(address) {
  if (!ethers.isAddress(address) || address.toLowerCase() !== FUJI_RELEASE_CONFIG.contractAddress.toLowerCase()) throw new Error("Only the certified Fuji VoidRelease1155 contract is allowed for this path.");
  return FUJI_RELEASE_CONFIG.contractAddress;
}

export async function assertFujiProvider(provider) {
  if (!provider?.request) throw new Error("Connect a wallet before using the Fuji release.");
  const chain = await requestWithTimeout(provider, { method: "eth_chainId" });
  const chainId = Number.parseInt(chain, 16);
  if (chainId !== FUJI_RELEASE_CONFIG.chainId) throw Object.assign(new Error(`Switch your wallet to ${FUJI_RELEASE_CONFIG.network} (chain ${FUJI_RELEASE_CONFIG.chainId}).`), { code: "CHAIN_MISMATCH", chainId });
  return chainId;
}

export const PROVIDER_REQUEST_TIMEOUT_MS = 120_000;

export async function requestWithTimeout(provider, request, timeoutMs = PROVIDER_REQUEST_TIMEOUT_MS) {
  if (!provider?.request) throw new Error("The provider is unavailable.");
  let timer;
  try {
    return await Promise.race([
      provider.request(request),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`The wallet provider timed out while handling ${request.method}.`), { code: "PROVIDER_REQUEST_TIMEOUT", method: request.method })), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const v2CreateIface = new ethers.Interface([
  "function createEdition(bytes32 releaseId, bytes32 editionId, uint256 maxSupply, string metadataUri, address payout, uint96 royaltyBps) returns (uint256 tokenId)",
]);
const v4CreateIface = new ethers.Interface([
  "function createEdition(bytes32 releaseId, bytes32 editionId, uint256 maxSupply, string metadataUri, address payout, uint96 royaltyBps) returns (uint256 tokenId)",
]);
const v4AlbumIface = new ethers.Interface(["function createAlbum(bytes32 releaseId)"]);
const v4AlbumTrackIface = new ethers.Interface([
  "function createAlbumTrack(bytes32 releaseId, bytes32 editionId, uint256 maxSupply, string metadataUri, address payout, uint96 royaltyBps, bool single, uint64 mintEnd) returns (uint256 tokenId)",
]);

// Every custom error the deployed VoidRelease1155V2 can revert createEdition with,
// so a revert (from a pre-broadcast eth_call simulation or a failed receipt) can be
// decoded to a specific, actionable reason instead of a generic "reverted".
const fujiErrorIface = new ethers.Interface([
  "error AccessDenied(bytes32 role, address account)",
  "error AlreadyInitialized(uint256 tokenId)",
  "error InvalidAddress()",
  "error InvalidSupply()",
  "error InvalidIdentifier()",
  "error RoyaltyTooHigh(uint96 bps, uint96 cap)",
  "error ContractPaused()",
  "error EditionNotFound(uint256 tokenId)",
  "error InactiveEdition(uint256 tokenId)",
  "error ExceedsSupply(uint256 tokenId, uint256 available, uint256 requested)",
  "error InsufficientBalance(address account, uint256 tokenId, uint256 available, uint256 requested)",
  "error LengthMismatch()",
  "error ZeroQuantity()",
  "error UnsafeRecipient()",
]);

function extractFujiRevertData(error) {
  const candidates = [error?.data, error?.error?.data, error?.info?.error?.data, error?.cause?.data, error?.data?.data, error?.cause?.error?.data];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && /^0x[0-9a-fA-F]{8,}$/.test(candidate)) return candidate;
  }
  const match = String(error?.shortMessage || error?.message || error || "").match(/0x[0-9a-fA-F]{8,}/);
  return match ? match[0] : null;
}

// Decode a revert into { name, args, data }. name is null when the selector is
// unknown or no revert data is present.
export function decodeFujiRevert(error) {
  const data = extractFujiRevertData(error);
  if (data) {
    try {
      const parsed = fujiErrorIface.parseError(data);
      if (parsed) return { name: parsed.name, args: parsed.args, data };
    } catch { /* Unknown selector: fall through to a generic result. */ }
  }
  return { name: null, args: null, data: data || null };
}

// Map a createEdition revert (or wallet rejection) to a user-facing message while
// preserving the decoded error code and raw revert data for debugging. Returns a
// null message when the reason is unknown, so callers keep their generic fallback.
export function explainFujiEditionError(error) {
  const decoded = decodeFujiRevert(error);
  const { name, data } = decoded;
  const base = { code: name, revertData: data || null };
  switch (name) {
    case "AccessDenied":
      return { ...base, message: "Connected wallet is not authorized to create Fuji editions (missing ARTIST_ROLE)." };
    case "AlreadyInitialized":
      return { ...base, message: "This edition already exists on Fuji. Load the existing edition instead of publishing it again." };
    case "ContractPaused":
      return { ...base, message: "The Fuji release contract is currently paused. Publishing is disabled until an admin unpauses it." };
    case "InvalidSupply":
      return { ...base, message: "Maximum supply must be greater than zero." };
    case "InvalidIdentifier":
      return { ...base, message: "Release and edition identifiers must each be non-empty." };
    case "InvalidAddress":
      return { ...base, message: "The edition payout address is invalid." };
    case "RoyaltyTooHigh":
      return { ...base, message: "Royalty exceeds the 10% (1000 basis points) cap." };
    case "EditionNotFound":
      return { ...base, message: "This token's edition does not exist on Fuji yet. Publish the release before minting it." };
    case "InactiveEdition":
      return { ...base, message: "This edition is not active on Fuji, so it cannot be minted." };
    case "ExceedsSupply":
      return { ...base, message: `Mint exceeds the edition's remaining supply (${String(decoded.args?.[1] ?? "?")} left).` };
    case "ZeroQuantity":
      return { ...base, message: "Mint quantity must be at least 1." };
    case "UnsafeRecipient":
      return { ...base, message: "The receiving wallet is a contract that cannot accept ERC-1155 tokens." };
    default: {
      const code = error?.code ?? error?.info?.error?.code ?? error?.cause?.code;
      const message = String(error?.shortMessage || error?.message || "");
      if (code === 4001 || code === "ACTION_REJECTED" || /user rejected|user denied|rejected the request/i.test(message)) {
        return { code: "ACTION_REJECTED", revertData: null, message: "Transaction rejected in the wallet. Nothing was published." };
      }
      return { code: name || "REVERTED", revertData: data || null, message: null };
    }
  }
}

// Static, read-only simulation of the exact createEdition calldata from the exact
// connected wallet, BEFORE broadcasting. On revert it decodes the custom error and
// throws a specific message, so a doomed transaction is never sent to the wallet.
export async function simulateCreateFujiEdition(provider, { from, data }) {
  await assertFujiProvider(provider);
  if (!ethers.isAddress(from)) throw new Error("A connected wallet is required.");
  const to = assertFujiAddress(FUJI_RELEASE_CONFIG.contractAddress);
  try {
    await provider.request({ method: "eth_call", params: [{ from, to, data }, "latest"] });
  } catch (error) {
    const explained = explainFujiEditionError(error);
    if (explained.message) {
      throw Object.assign(new Error(explained.message), { code: explained.code, revertData: explained.revertData, cause: error });
    }
    throw error;
  }
}

// Blank or 0 is an open edition (unlimited). A positive whole number is a cap.
export function editionMaxSupply(maxSupply) {
  if (maxSupply === null || maxSupply === undefined || String(maxSupply).trim() === "") return 0n;
  let supply;
  try {
    supply = BigInt(maxSupply);
  } catch {
    throw new Error("Edition supply must be a whole number, or blank or 0 for unlimited.");
  }
  if (supply < 0n) throw new Error("Edition supply must be a whole number, or blank or 0 for unlimited.");
  return supply;
}

export function encodeCreateFujiEdition({ releaseId, editionId, maxSupply, metadataUri, payout, royaltyBps }) {
  if (!metadataUri || !String(metadataUri).trim()) throw new Error("Metadata URI is required.");
  const supply = editionMaxSupply(maxSupply);
  const ids = fujiIds(releaseId, editionId);
  const tokenId = fujiTokenId(releaseId, editionId);
  if (payout === undefined && royaltyBps === undefined) {
    return { tokenId, data: iface.encodeFunctionData("createEdition(bytes32,bytes32,uint256,string)", [ids.releaseId, ids.editionId, supply, metadataUri]) };
  }
  if (!ethers.isAddress(payout) || ethers.getAddress(payout) === ethers.ZeroAddress) throw new Error("Edition payout must be a wallet address.");
  const bps = BigInt(royaltyBps ?? 0);
  if (bps > 1000n) throw new Error("Royalty must be between 0 and 1000 basis points (10%).");
  return { tokenId, data: v2CreateIface.encodeFunctionData("createEdition", [ids.releaseId, ids.editionId, supply, metadataUri, ethers.getAddress(payout), bps]) };
}

/** Encode a createEdition call for one factory-created V4 clone. V4 derives
 * token IDs from the edition ID alone and rejects a mismatched release key. */
export function encodeCreateReleaseEdition({ releaseKey, editionId, maxSupply, metadataUri, payout, royaltyBps = 0 }) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(releaseKey || ""))) throw new Error("A factory release key is required for this release.");
  if (!metadataUri || !String(metadataUri).trim()) throw new Error("Metadata URI is required.");
  if (!ethers.isAddress(payout) || ethers.getAddress(payout) === ethers.ZeroAddress) throw new Error("Edition payout must be a wallet address.");
  const bps = BigInt(royaltyBps ?? 0);
  if (bps > 1000n) throw new Error("Royalty must be between 0 and 1000 basis points (10%).");
  const edition = bytes32(editionId, "editionId");
  const digest = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32"], ["the-void:release-edition:v1", edition]));
  const tokenId = BigInt(digest);
  return { tokenId: tokenId === 0n ? 1n : tokenId, data: v4CreateIface.encodeFunctionData("createEdition", [releaseKey, edition, editionMaxSupply(maxSupply), metadataUri, ethers.getAddress(payout), bps]) };
}

// Dry-run a release-contract call from this wallet so a revert surfaces its
// decoded reason before anything is broadcast.
/** Explicitly opts a Factory V2 V4 clone into Album Contract semantics. */
export function encodeCreateReleaseAlbum({ releaseKey }) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(releaseKey || ""))) throw new Error("A factory release key is required for album activation.");
  return { data: v4AlbumIface.encodeFunctionData("createAlbum", [releaseKey]) };
}

export function encodeCreateReleaseAlbumTrack({ releaseKey, editionId, maxSupply, metadataUri, payout, royaltyBps = 0, single = false, mintEnd = 0 }) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(releaseKey || ""))) throw new Error("A factory release key is required for album tracks.");
  if (!metadataUri || !String(metadataUri).trim()) throw new Error("Metadata URI is required.");
  if (!ethers.isAddress(payout) || ethers.getAddress(payout) === ethers.ZeroAddress) throw new Error("Edition payout must be a wallet address.");
  const bps = BigInt(royaltyBps ?? 0);
  if (bps > 1000n) throw new Error("Royalty must be between 0 and 1000 basis points (10%).");
  const edition = bytes32(editionId, "editionId");
  const digest = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32"], ["the-void:release-edition:v1", edition]));
  const tokenId = BigInt(digest);
  return { tokenId: tokenId === 0n ? 1n : tokenId, data: v4AlbumTrackIface.encodeFunctionData("createAlbumTrack", [releaseKey, edition, editionMaxSupply(maxSupply), metadataUri, ethers.getAddress(payout), bps, Boolean(single), BigInt(mintEnd || 0)]) };
}

export async function simulateFujiCall(provider, { from, to, data }) {
  await assertFujiProvider(provider);
  const target = assertFujiTransactionTarget(to || FUJI_RELEASE_CONFIG.contractAddress);
  try {
    await provider.request({ method: "eth_call", params: [{ from, to: target, data }, "latest"] });
  } catch (error) {
    const explained = explainFujiEditionError(error);
    throw Object.assign(new Error(explained.message || `This transaction would revert on Fuji${explained.code ? ` (${explained.code})` : ""}. Nothing was sent.`), { code: explained.code || "SIMULATION_REVERTED", revertData: explained.revertData, cause: error });
  }
}

/** Simulate a transaction against an address discovered from VoidReleaseFactory. */
export async function simulateReleaseCall(provider, { from, to, data, chainId = FUJI_RELEASE_FACTORY_CONFIG.chainId }) {
  if (Number(chainId) !== FUJI_RELEASE_FACTORY_CONFIG.chainId) throw new Error("Release contracts must run on Fuji.");
  await assertFujiProvider(provider);
  if (!ethers.isAddress(to) || ethers.getAddress(to) === ethers.ZeroAddress) throw new Error("The indexed release contract address is invalid.");
  if (!ethers.isAddress(from)) throw new Error("A connected wallet is required.");
  try {
    await provider.request({ method: "eth_call", params: [{ from, to: ethers.getAddress(to), data }, "latest"] });
  } catch (error) {
    const explained = explainFujiEditionError(error);
    throw Object.assign(new Error(explained.message || "This release transaction would revert on Fuji. Nothing was sent."), { code: explained.code || "SIMULATION_REVERTED", revertData: explained.revertData, cause: error });
  }
}

export function encodeFujiMint({ to, tokenId, amount = 1 }) {
  if (!ethers.isAddress(to) || ethers.getAddress(to) === ethers.ZeroAddress) throw new Error("A valid recipient wallet is required.");
  if (BigInt(amount) <= 0n) throw new Error("Mint amount must be greater than zero.");
  return iface.encodeFunctionData("mint", [to, BigInt(tokenId), BigInt(amount), "0x"]);
}

function randomHex(bytes) {
  const values = globalThis.crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
}

// A plan names the fresh edition one E2E run creates and mints into. The edition
// ID combines the time with 48 random bits, so runs never derive the same token.
export function createFujiE2EMintPlan({ now = Date.now(), random = randomHex } = {}) {
  const editionId = `run:${Number(now).toString(36)}-${random(6)}`;
  const metadataUri = `data:application/json,${encodeURIComponent(JSON.stringify({ name: `The Void E2E test copy ${editionId}`, description: "Temporary Fuji E2E control edition. Test only; not a catalog edition." }))}`;
  return assertFujiE2EMintPlan({ releaseId: FUJI_E2E_MINT.releaseId, editionId, tokenId: fujiTokenId(FUJI_E2E_MINT.releaseId, editionId), quantity: FUJI_E2E_MINT.quantity, maxSupply: FUJI_E2E_MINT.maxSupply, metadataUri });
}

export function assertFujiE2EMintPlan(plan) {
  if (!plan || plan.releaseId !== FUJI_E2E_MINT.releaseId || !FUJI_E2E_EDITION_ID.test(String(plan.editionId))) throw new Error("The E2E mint needs a fresh E2E test edition plan.");
  if (plan.tokenId !== fujiTokenId(plan.releaseId, plan.editionId)) throw new Error("The E2E plan token ID does not match its edition identity.");
  if (FUJI_E2E_MINT.retiredTokenIds.includes(plan.tokenId)) throw new Error("The E2E plan reuses a retired, already-minted token ID.");
  if (plan.quantity !== FUJI_E2E_MINT.quantity || plan.maxSupply !== FUJI_E2E_MINT.maxSupply) throw new Error("The E2E plan must create and mint exactly one copy.");
  if (!String(plan.metadataUri || "").startsWith("data:application/json,")) throw new Error("The E2E plan needs its inline test metadata.");
  return Object.freeze({ ...plan });
}

export function encodeFujiE2ECreateEdition(plan) {
  const checked = assertFujiE2EMintPlan(plan);
  return encodeCreateFujiEdition({ releaseId: checked.releaseId, editionId: checked.editionId, maxSupply: checked.maxSupply, metadataUri: checked.metadataUri });
}

export function encodeFujiE2EMint(plan) {
  const checked = assertFujiE2EMintPlan(plan);
  return encodeFujiMint({ to: FUJI_E2E_MINT.wallet, tokenId: checked.tokenId, amount: checked.quantity });
}

// Read-only. Returns stage "create" when the plan's edition does not exist yet,
// or "mint" when this wallet created it and nothing has been minted. Any other
// on-chain state blocks the run, so a minted edition is never minted again.
export async function readFujiE2EMintPreflight(provider, account, plan) {
  await assertFujiProvider(provider);
  const connected = ethers.getAddress(account || ethers.ZeroAddress);
  if (connected.toLowerCase() !== FUJI_E2E_MINT.wallet) throw new Error("The E2E mint control is restricted to the authorized Fuji admin wallet.");
  const checked = assertFujiE2EMintPlan(plan);
  const [artist, issuer, paused, edition] = await Promise.all([
    readFujiRole(provider, FUJI_ROLES.ARTIST_ROLE, connected),
    readFujiRole(provider, FUJI_ROLES.ISSUER_ROLE, connected),
    readFujiPaused(provider),
    readFujiEdition(provider, checked.tokenId),
  ]);
  if (!artist) throw new Error("The connected wallet does not have ARTIST_ROLE on the Fuji V2 contract, so it cannot create the E2E test edition.");
  if (!issuer) throw new Error("The connected wallet does not have ISSUER_ROLE on the Fuji V2 contract.");
  if (paused) throw new Error("The Fuji V2 contract is paused.");
  const base = { chainId: FUJI_RELEASE_CONFIG.chainId, contractAddress: FUJI_RELEASE_CONFIG.contractAddress, account: connected, plan: checked, tokenId: checked.tokenId, quantity: checked.quantity };
  if (!edition) return { ...base, stage: "create", edition: null };
  const ids = fujiIds(checked.releaseId, checked.editionId);
  if (edition.releaseId !== ids.releaseId || edition.editionId !== ids.editionId || edition.artist.toLowerCase() !== FUJI_E2E_MINT.wallet) throw new Error("The E2E token ID belongs to an edition this control did not create.");
  if (BigInt(edition.maxSupply) !== checked.maxSupply) throw new Error(`The E2E test edition max supply is ${edition.maxSupply}, expected 1.`);
  if (BigInt(edition.mintedSupply) !== 0n) throw new Error(`The E2E test edition already has minted supply ${edition.mintedSupply}; start a new E2E run instead of minting it again.`);
  return { ...base, stage: "mint", edition };
}

export async function verifyFujiE2EMint(provider, { transactionHash, plan }) {
  await assertFujiProvider(provider);
  const checked = assertFujiE2EMintPlan(plan);
  const receipt = await provider.request({ method: "eth_getTransactionReceipt", params: [transactionHash] });
  if (!receipt || receipt.status !== "0x1") throw new Error("The E2E mint did not receive a successful Fuji receipt.");
  const event = (receipt.logs || []).filter((log) => log.address?.toLowerCase() === FUJI_RELEASE_CONFIG.contractAddress.toLowerCase()).map((log) => {
    try { return mintIface.parseLog(log); } catch { return null; }
  }).find((parsed) => parsed?.name === "TransferSingle" && parsed.args.from === ethers.ZeroAddress && parsed.args.to.toLowerCase() === FUJI_E2E_MINT.wallet && parsed.args.id === checked.tokenId && parsed.args.value === checked.quantity);
  if (!event) throw new Error("The successful E2E mint receipt did not contain the expected TransferSingle event.");
  const balance = await readFujiBalance(provider, FUJI_E2E_MINT.wallet, checked.tokenId);
  if (balance !== checked.quantity) throw new Error(`E2E mint receipt succeeded, but seller balance is ${balance} instead of 1.`);
  return { receipt, event, balance };
}

export function isFujiEditionNotFoundError(error) {
  const revertData = error?.data || error?.originalError?.data || error?.cause?.data;
  if (revertData) {
    try {
      if (editionIface.parseError(revertData)?.name === "EditionNotFound") return true;
    } catch { /* Fall through to the provider's generic revert message. */ }
  }
  return /execution reverted/i.test(String(error?.message || error));
}

export function encodeFujiApproval(operator, approved = true) { return iface.encodeFunctionData("setApprovalForAll", [operator, approved]); }
export function encodeFujiTransfer(from, to, tokenId, amount = 1) { return iface.encodeFunctionData("safeTransferFrom", [from, to, BigInt(tokenId), BigInt(amount), "0x"]); }

export function assertProvenanceAnchorTarget(address) {
  if (!ethers.isAddress(address)) throw new Error("The provenance anchor contract address is invalid.");
  const target = ethers.getAddress(address);
  if (target.toLowerCase() === FUJI_RELEASE_CONFIG.contractAddress.toLowerCase()) throw new Error("The provenance anchor cannot be the release contract.");
  const sale = String(FUJI_RELEASE_CONFIG.primarySaleAddress || "");
  if (ethers.isAddress(sale) && ethers.getAddress(sale) !== ethers.ZeroAddress && target.toLowerCase() === sale.toLowerCase()) throw new Error("The provenance anchor cannot be the sale contract.");
  return target;
}

export async function sendFujiTransaction({ provider, from, data, to, value, anchorAddress = null, assumeFujiChain = false, receiptProvider = provider }) {
  if (!assumeFujiChain) await assertFujiProvider(provider);
  if (!ethers.isAddress(from)) throw new Error("A connected wallet is required.");
  const target = anchorAddress ? assertProvenanceAnchorTarget(anchorAddress) : assertFujiTransactionTarget(to || FUJI_RELEASE_CONFIG.contractAddress);
  if (anchorAddress && to && ethers.getAddress(to) !== target) throw new Error("The provenance transaction target does not match the configured anchor.");
  const tx = { from, to: target, data };
  if (value !== undefined && value !== null && BigInt(value) > 0n) tx.value = ethers.toQuantity(BigInt(value));
  let hash;
  try {
    hash = await requestWithTimeout(provider, { method: "eth_sendTransaction", params: [tx] });
  } catch (error) {
    if (error?.code === "PROVIDER_REQUEST_TIMEOUT") throw error;
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: error?.code || "TRANSACTION_SUBMISSION_FAILED" });
  }
  const receipt = await waitForReceipt(receiptProvider, hash);
  if (!receipt || receipt.status !== "0x1") {
    // Best-effort: replay the same call read-only to recover the revert reason, and
    // always preserve the transaction hash so the failure can be inspected on-chain.
    let message = "Fuji transaction reverted or did not receive a successful receipt.";
    let code = "TX_REVERTED";
    let revertData = null;
    try {
      await provider.request({ method: "eth_call", params: [{ ...tx }, "latest"] });
    } catch (callError) {
      const explained = explainFujiEditionError(callError);
      if (explained.message) message = explained.message;
      if (explained.code) code = explained.code;
      revertData = explained.revertData;
    }
    const blockNumber = receipt?.blockNumber ? Number.parseInt(receipt.blockNumber, 16) : null;
    // Preserve every piece of on-chain evidence so the failure can be inspected
    // later (the hash was previously discarded, leaving nothing to look up).
    throw Object.assign(new Error(message), {
      code,
      revertData,
      transactionHash: hash,
      contractAddress: target,
      chainId: FUJI_RELEASE_CONFIG.chainId,
      receiptStatus: receipt?.status ?? null,
      blockNumber,
      explorerUrl: fujiExplorerUrl("tx", hash),
      receipt,
    });
  }
  return { hash, receipt, blockNumber: receipt.blockNumber ? Number.parseInt(receipt.blockNumber, 16) : null };
}

export async function sendReleaseTransaction({ provider, from, to, data, receiptProvider = provider }) {
  await assertFujiProvider(provider);
  if (!ethers.isAddress(to) || ethers.getAddress(to) === ethers.ZeroAddress) throw new Error("The indexed release contract address is invalid.");
  if (!ethers.isAddress(from)) throw new Error("A connected wallet is required.");
  const target = ethers.getAddress(to);
  const hash = await requestWithTimeout(provider, { method: "eth_sendTransaction", params: [{ from, to: target, data }] });
  const receipt = await waitForReceipt(receiptProvider, hash);
  if (!receipt || receipt.status !== "0x1") throw Object.assign(new Error("The release transaction did not receive a successful Fuji receipt."), { transactionHash: hash, contractAddress: target, chainId: FUJI_RELEASE_FACTORY_CONFIG.chainId, receipt });
  return { hash, receipt, blockNumber: receipt.blockNumber ? Number.parseInt(receipt.blockNumber, 16) : null };
}

export async function readFujiBalance(provider, account, tokenId) {
  await assertFujiProvider(provider);
  const data = iface.encodeFunctionData("balanceOf", [account, BigInt(tokenId)]);
  const result = await provider.request({ method: "eth_call", params: [{ to: assertFujiAddress(FUJI_RELEASE_CONFIG.contractAddress), data }, "latest"] });
  return BigInt(iface.decodeFunctionResult("balanceOf", result)[0]);
}

export async function readFujiRole(provider, role, account) {
  await assertFujiProvider(provider);
  const data = iface.encodeFunctionData("hasRole", [role, account]);
  const result = await provider.request({ method: "eth_call", params: [{ to: assertFujiAddress(FUJI_RELEASE_CONFIG.contractAddress), data }, "latest"] });
  return Boolean(iface.decodeFunctionResult("hasRole", result)[0]);
}

export async function readFujiPaused(provider) {
  await assertFujiProvider(provider);
  const data = iface.encodeFunctionData("paused", []);
  const result = await provider.request({ method: "eth_call", params: [{ to: assertFujiAddress(FUJI_RELEASE_CONFIG.contractAddress), data }, "latest"] });
  return Boolean(iface.decodeFunctionResult("paused", result)[0]);
}

export async function readFujiEdition(provider, tokenId) {
  await assertFujiProvider(provider);
  const data = editionIface.encodeFunctionData("edition", [BigInt(tokenId)]);
  try {
    const result = await provider.request({ method: "eth_call", params: [{ to: assertFujiAddress(FUJI_RELEASE_CONFIG.contractAddress), data }, "latest"] });
    const [edition] = editionIface.decodeFunctionResult("edition", result);
    return { releaseId: edition.releaseId, editionId: edition.editionId, artist: edition.artist, maxSupply: edition.maxSupply, mintedSupply: edition.mintedSupply, metadataUri: edition.metadataUri, exists: Boolean(edition.exists) };
  } catch (error) {
    const revertData = error?.data || error?.originalError?.data || error?.cause?.data;
    if (revertData) {
      try {
        const parsed = editionIface.parseError(revertData);
        if (parsed?.name === "EditionNotFound") return null;
      } catch { /* Preserve the provider error for unknown failures. */ }
    }
    throw error;
  }
}

export async function readReleaseEdition(provider, { releaseContractAddress, tokenId, chainId = FUJI_RELEASE_FACTORY_V2_CONFIG.chainId }) {
  if (Number(chainId) !== Number(FUJI_RELEASE_FACTORY_V2_CONFIG.chainId)) throw new Error("The bound release is on a different chain.");
  await assertFujiProvider(provider);
  if (!ethers.isAddress(releaseContractAddress) || ethers.getAddress(releaseContractAddress) === ethers.ZeroAddress) throw new Error("The bound release contract address is invalid.");
  const data = editionIface.encodeFunctionData("edition", [BigInt(tokenId)]);
  const result = await provider.request({ method: "eth_call", params: [{ to: ethers.getAddress(releaseContractAddress), data }, "latest"] });
  try {
    const [edition] = editionIface.decodeFunctionResult("edition", result);
    return { releaseId: edition.releaseId, editionId: edition.editionId, artist: edition.artist, maxSupply: edition.maxSupply, mintedSupply: edition.mintedSupply, metadataUri: edition.metadataUri, exists: Boolean(edition.exists) };
  } catch (error) {
    const revertData = error?.data || error?.originalError?.data || error?.cause?.data;
    if (revertData) {
      try { if (editionIface.parseError(revertData)?.name === "EditionNotFound") return null; } catch { /* Preserve the provider error. */ }
    }
    throw error;
  }
}

export async function assertFujiGas(provider, { from, data }) {
  await assertFujiProvider(provider);
  const to = assertFujiAddress(FUJI_RELEASE_CONFIG.contractAddress);
  const [gasHex, gasPriceHex, balanceHex] = await Promise.all([
    provider.request({ method: "eth_estimateGas", params: [{ from, to, data }] }),
    provider.request({ method: "eth_gasPrice" }),
    provider.request({ method: "eth_getBalance", params: [from, "latest"] }),
  ]);
  const gas = BigInt(gasHex);
  const gasPrice = BigInt(gasPriceHex);
  const balance = BigInt(balanceHex);
  const required = gas * gasPrice;
  if (balance < required) {
    throw new Error(`Insufficient Fuji AVAX for gas. Estimated requirement is ${ethers.formatEther(required)} AVAX; wallet balance is ${ethers.formatEther(balance)} AVAX.`);
  }
  return { gas, gasPrice, balance, required };
}

export async function verifyFujiEditionCreation(provider, { transactionHash, releaseId, editionId, tokenId }) {
  await assertFujiProvider(provider);
  const receipt = await provider.request({ method: "eth_getTransactionReceipt", params: [transactionHash] });
  if (!receipt || receipt.status !== "0x1") throw new Error("Create Edition did not receive a successful Fuji receipt.");
  const expectedTokenId = BigInt(tokenId).toString();
  const expectedReleaseId = fujiIds(releaseId, editionId).releaseId;
  const expectedEditionId = fujiIds(releaseId, editionId).editionId;
  const event = (receipt.logs || []).filter((log) => log.address?.toLowerCase() === FUJI_RELEASE_CONFIG.contractAddress.toLowerCase()).map((log) => {
    try { return editionIface.parseLog(log); } catch { return null; }
  }).find((parsed) => parsed?.name === "EditionCreated" && parsed.args.tokenId.toString() === expectedTokenId && parsed.args.releaseId === expectedReleaseId && parsed.args.editionId === expectedEditionId);
  if (!event) throw new Error("Create Edition receipt succeeded, but the expected EditionCreated event was not found.");
  const edition = await readFujiEdition(provider, tokenId);
  if (!edition?.exists) throw new Error("EditionCreated was emitted, but edition(tokenId) is not available on Fuji.");
  return { receipt, event, edition };
}

export async function verifyReleaseEditionCreation(provider, { transactionHash, releaseContractAddress, releaseKey, editionId, tokenId }) {
  await assertFujiProvider(provider);
  if (!ethers.isAddress(releaseContractAddress) || !/^0x[0-9a-fA-F]{64}$/.test(String(releaseKey || ""))) throw new Error("The indexed release identity is incomplete.");
  const receipt = await provider.request({ method: "eth_getTransactionReceipt", params: [transactionHash] });
  if (!receipt || receipt.status !== "0x1") throw new Error("Create Edition did not receive a successful Fuji receipt.");
  const expectedEditionId = bytes32(editionId, "editionId");
  const event = (receipt.logs || []).filter((log) => log.address?.toLowerCase() === releaseContractAddress.toLowerCase()).map((log) => {
    try { return editionIface.parseLog(log); } catch { return null; }
  }).find((parsed) => parsed?.name === "EditionCreated" && parsed.args.tokenId === BigInt(tokenId) && parsed.args.releaseId.toLowerCase() === String(releaseKey).toLowerCase() && parsed.args.editionId === expectedEditionId);
  if (!event) throw new Error("Create Edition receipt succeeded, but the expected release-local EditionCreated event was not found.");
  return { receipt, event };
}

export function fujiExplorerUrl(kind, value) { return `${FUJI_RELEASE_CONFIG.explorer}/${kind}/${value}`; }

// Reviewer tooling: grant a verified artist's wallet the roles the certified
// Fuji contract requires to publish (ARTIST_ROLE) and mint (ISSUER_ROLE).
// Signed by the connected wallet, which must hold DEFAULT_ADMIN_ROLE; no
// server-side key is involved.
const roleAdminIface = new ethers.Interface(["function grantRole(bytes32 role, address account)"]);
export const PUBLISHING_ROLES = Object.freeze([["ARTIST_ROLE", FUJI_ROLES.ARTIST_ROLE], ["ISSUER_ROLE", FUJI_ROLES.ISSUER_ROLE]]);

export function encodeFujiGrantRole(role, account) {
  if (!ethers.isAddress(account)) throw new Error("The artist wallet address is invalid.");
  return roleAdminIface.encodeFunctionData("grantRole", [role, ethers.getAddress(account)]);
}

/** Current publishing roles of `account`: { ARTIST_ROLE: bool, ISSUER_ROLE: bool }. */
export async function readPublishingRoles(provider, account) {
  const entries = await Promise.all(PUBLISHING_ROLES.map(async ([name, role]) => [name, await readFujiRole(provider, role, account)]));
  return Object.fromEntries(entries);
}

/** Grant and revoke of on-chain publishing roles require DEFAULT_ADMIN_ROLE on the certified Fuji release. */
export function canMutateFujiPublishingRoles(hasDefaultAdminRole) {
  return hasDefaultAdminRole === true;
}

/** Grants each missing publishing role to `account`, one transaction per role. */
const roleGranterIface = new ethers.Interface([
  "function isReviewer(address) view returns (bool)",
  "function grantPublishingRoles(address artist)",
  "error NotReviewer(address caller)",
  "error SelfGrant(address reviewer)",
  "error InvalidAddress()",
]);

/** True when `account` is a listed reviewer on the deployed VoidRoleGranter. */
export async function readRoleGranterReviewer(provider, account, granterAddress = fujiRoleGranterAddress()) {
  if (!granterAddress || !ethers.isAddress(account)) return false;
  await assertFujiProvider(provider);
  const result = await provider.request({ method: "eth_call", params: [{ to: granterAddress, data: roleGranterIface.encodeFunctionData("isReviewer", [account]) }, "latest"] });
  return Boolean(roleGranterIface.decodeFunctionResult("isReviewer", result)[0]);
}

// A verification reviewer (not a contract admin) grants both roles in one
// transaction through VoidRoleGranter, which alone holds the admin role and
// can only ever grant ARTIST_ROLE and ISSUER_ROLE.
async function grantThroughRoleGranter({ provider, from, account, onProgress, granterAddress }) {
  const data = roleGranterIface.encodeFunctionData("grantPublishingRoles", [account]);
  try {
    await provider.request({ method: "eth_call", params: [{ from, to: granterAddress, data }, "latest"] });
  } catch (error) {
    let reason = "";
    try { reason = roleGranterIface.parseError(extractFujiRevertData(error))?.name || ""; } catch { /* unknown revert */ }
    if (reason === "SelfGrant") throw new Error("A reviewer cannot grant publishing roles to their own wallet.", { cause: error });
    if (reason === "NotReviewer") throw new Error("This wallet is not a reviewer on the role granter.", { cause: error });
    throw new Error("The role granter would reject this grant. It may not hold the release contract's admin role yet.", { cause: error });
  }
  onProgress?.("Confirm granting ARTIST_ROLE and ISSUER_ROLE in your wallet…");
  const transaction = await sendFujiTransaction({ provider, from, to: granterAddress, data });
  return [{ role: "ARTIST_ROLE + ISSUER_ROLE", hash: transaction.hash }];
}

export async function grantPublishingRoles({ provider, from, account, onProgress, granterAddress = fujiRoleGranterAddress() }) {
  if (!(await readFujiRole(provider, FUJI_ROLES.DEFAULT_ADMIN_ROLE, from))) {
    const held = await readPublishingRoles(provider, account);
    if (held.ARTIST_ROLE && held.ISSUER_ROLE) return PUBLISHING_ROLES.map(([name]) => ({ role: name, alreadyHeld: true }));
    if (await readRoleGranterReviewer(provider, from, granterAddress)) return grantThroughRoleGranter({ provider, from, account, onProgress, granterAddress });
    throw new Error(granterAddress
      ? "The connected wallet is neither a reviewer on the role granter nor an admin of the Fuji release contract, so it cannot grant roles."
      : "The connected wallet is not an admin of the Fuji release contract, and the reviewer role granter is not deployed yet, so it cannot grant roles.");
  }
  const results = [];
  for (const [name, role] of PUBLISHING_ROLES) {
    if (await readFujiRole(provider, role, account)) { results.push({ role: name, alreadyHeld: true }); continue; }
    onProgress?.(`Confirm granting ${name} in your wallet…`);
    const transaction = await sendFujiTransaction({ provider, from, data: encodeFujiGrantRole(role, account) });
    results.push({ role: name, hash: transaction.hash });
  }
  return results;
}

import { Interface, getAddress } from "ethers";

const MARKETPLACE_ABI = [
  "event ListingCreated(uint256 indexed listingId, address indexed seller, address indexed tokenContract, uint256 tokenId, uint256 amount, uint256 price, uint64 expiresAt)",
  "event ListingCancelled(uint256 indexed listingId)",
  "event ListingExpired(uint256 indexed listingId)",
  "event ListingSold(uint256 indexed listingId, address indexed buyer, address indexed seller, address tokenContract, uint256 tokenId, uint256 amount, uint256 price, uint256 platformFee, uint256 royalty)",
  "function getListing(uint256 listingId) view returns (uint256 listingId, address seller, address tokenContract, uint256 tokenId, uint256 amount, uint256 price, uint64 createdAt, uint64 expiresAt, uint8 status)",
];

export const marketplaceInterface = new Interface(MARKETPLACE_ABI);
export const MARKETPLACE_EVENT_TOPICS = Object.freeze(Object.fromEntries(["ListingCreated", "ListingCancelled", "ListingExpired", "ListingSold"].map((name) => [name, marketplaceInterface.getEvent(name).topicHash.toLowerCase()])));
export const MARKETPLACE_LISTING_STATUSES = Object.freeze(["ACTIVE", "SOLD", "CANCELLED", "EXPIRED"]);
export const MARKETPLACE_CHAIN_IDS = Object.freeze([43113, 43114]);

export class MarketplaceEventError extends Error {
  constructor(message, code = "MARKETPLACE_EVENT_INVALID") {
    super(message);
    this.name = "MarketplaceEventError";
    this.code = code;
  }
}

function normalizedAddress(value, label) {
  try { return getAddress(String(value)).toLowerCase(); } catch { throw new MarketplaceEventError(`${label} must be a valid EVM address.`); }
}

function uint(value, label, { positive = false } = {}) {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n || positive && parsed === 0n) throw new Error();
    return parsed.toString();
  } catch {
    throw new MarketplaceEventError(`${label} must be a ${positive ? "positive" : "non-negative"} integer.`);
  }
}

function blockReference(log, expectedAddress) {
  const chainId = Number(log?.chainId);
  const blockNumber = Number(log?.blockNumber);
  const logIndex = Number(log?.logIndex);
  const transactionHash = String(log?.transactionHash || "").toLowerCase();
  const blockHash = String(log?.blockHash || "").toLowerCase();
  if (!MARKETPLACE_CHAIN_IDS.includes(chainId)) throw new MarketplaceEventError("Marketplace reconciliation supports Avalanche Fuji or C-Chain only.");
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0 || !Number.isSafeInteger(logIndex) || logIndex < 0 || !/^0x[0-9a-f]{64}$/.test(transactionHash) || !/^0x[0-9a-f]{64}$/.test(blockHash)) throw new MarketplaceEventError("Marketplace event is missing a valid transaction, block, or log reference.");
  const marketplaceAddress = normalizedAddress(log.address, "Marketplace contract");
  if (expectedAddress && marketplaceAddress !== normalizedAddress(expectedAddress, "Configured marketplace contract")) throw new MarketplaceEventError("Marketplace event address does not match the configured contract.");
  return { chainId, marketplaceAddress, transactionHash, blockNumber, blockHash, logIndex };
}

function timestamp(value) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new MarketplaceEventError("Marketplace event block timestamp is invalid.");
  return parsed;
}

export function decodeMarketplaceLog(log, { chainId, expectedAddress = null, blockTimestamp = null, platformFeeBps = null } = {}) {
  let decoded;
  try { decoded = marketplaceInterface.parseLog({ topics: log?.topics, data: log?.data }); } catch { throw new MarketplaceEventError("Marketplace log does not match the supported contract ABI."); }
  if (!decoded || !MARKETPLACE_EVENT_TOPICS[decoded.name]) throw new MarketplaceEventError("Marketplace log event is not supported.");
  const reference = blockReference({ ...log, chainId: chainId ?? log?.chainId }, expectedAddress);
  const common = { ...reference, eventType: decoded.name, blockTimestamp: timestamp(blockTimestamp ?? log?.blockTimestamp) };
  const args = decoded.args;
  const listingId = uint(args.listingId, "listingId", { positive: true });

  if (decoded.name === "ListingCreated") {
    const amount = uint(args.amount, "amount", { positive: true });
    const priceWei = uint(args.price, "price", { positive: true });
    const expiry = uint(args.expiresAt, "expiresAt");
    return { ...common, listingId, sellerWallet: normalizedAddress(args.seller, "seller"), tokenContractAddress: normalizedAddress(args.tokenContract, "token contract"), tokenId: uint(args.tokenId, "tokenId"), amount, remainingAmount: amount, priceWei, currency: "native", expiresAt: expiry === "0" ? null : new Date(Number(expiry) * 1000), status: "ACTIVE" };
  }
  if (decoded.name === "ListingCancelled") return { ...common, listingId, status: "CANCELLED" };
  if (decoded.name === "ListingExpired") return { ...common, listingId, status: "EXPIRED" };

  const amount = uint(args.amount, "amount", { positive: true });
  const salePriceWei = uint(args.price, "sale price", { positive: true });
  const platformFeeWei = uint(args.platformFee, "platform fee");
  const royaltyWei = uint(args.royalty, "royalty");
  if (BigInt(platformFeeWei) > BigInt(salePriceWei) || BigInt(royaltyWei) > BigInt(salePriceWei) - BigInt(platformFeeWei)) throw new MarketplaceEventError("Marketplace settlement fee or royalty exceeds the sale price.");
  if (platformFeeBps !== null) {
    const feeBps = Number(platformFeeBps);
    if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) throw new MarketplaceEventError("Configured marketplace platform fee basis points are invalid.");
    if (BigInt(platformFeeWei) !== (BigInt(salePriceWei) * BigInt(feeBps)) / 10_000n) throw new MarketplaceEventError("Marketplace settlement platform fee does not match configured basis points.");
  }
  return { ...common, listingId, buyerWallet: normalizedAddress(args.buyer, "buyer"), sellerWallet: normalizedAddress(args.seller, "seller"), tokenContractAddress: normalizedAddress(args.tokenContract, "token contract"), tokenId: uint(args.tokenId, "tokenId"), quantity: amount, salePriceWei, platformFeeWei, royaltyWei, currency: "native" };
}

export function decodeMarketplaceListingResult(result) {
  let decoded;
  try { decoded = marketplaceInterface.decodeFunctionResult("getListing", result); } catch { throw new MarketplaceEventError("Marketplace getListing response is malformed.", "MARKETPLACE_LISTING_MALFORMED"); }
  const listingId = uint(decoded.listingId, "listingId");
  if (listingId === "0") return null;
  const statusIndex = Number(decoded.status);
  const status = MARKETPLACE_LISTING_STATUSES[statusIndex];
  if (!status) throw new MarketplaceEventError("Marketplace listing status is invalid.", "MARKETPLACE_LISTING_MALFORMED");
  const expiresAt = uint(decoded.expiresAt, "expiresAt");
  return {
    listingId,
    sellerWallet: normalizedAddress(decoded.seller, "seller"),
    tokenContractAddress: normalizedAddress(decoded.tokenContract, "token contract"),
    tokenId: uint(decoded.tokenId, "tokenId"),
    remainingAmount: uint(decoded.amount, "amount"),
    priceWei: uint(decoded.price, "price", { positive: true }),
    createdAt: new Date(Number(uint(decoded.createdAt, "createdAt")) * 1000),
    expiresAt: expiresAt === "0" ? null : new Date(Number(expiresAt) * 1000),
    status,
    currency: "native",
  };
}

import { isValidAddress, switchChain, waitForReceipt } from "./web3.js";

export const LISTING_STATUS = Object.freeze({ ACTIVE: "ACTIVE", SOLD: "SOLD", CANCELLED: "CANCELLED", EXPIRED: "EXPIRED" });
export const PURCHASE_STATE = Object.freeze({ READY: "READY", WALLET_CONFIRMATION: "WALLET_CONFIRMATION", SUBMITTED: "SUBMITTED", PENDING: "PENDING", CONFIRMED: "CONFIRMED", FAILED: "FAILED", REJECTED: "REJECTED", EXPIRED: "EXPIRED" });
export const MARKETPLACE_CONFIG = Object.freeze({ address: "", feeBps: 0, currency: "native", enabled: false });
const SELECTORS = { createListing: "0x5201ea65", cancelListing: "0x305a67a8", buy: "0xd96a094a", getListing: "0x107a274a", approval: "0xa22cb465", approved: "0xe985e9c5" };
const LISTING_CREATED_TOPIC = "0x554519707eb9698fba7b6c6299f6150020147337a27abcf083732c531e423ca2";
const LISTING_SOLD_TOPIC = "0x2b7afc2686848b44bb9d680f07613f88a940454a6a60984a092cd305a781e811";
const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const addressWord = (address) => address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const boolWord = (value) => word(value ? 1 : 0);
const decodeUint = (value) => BigInt(`0x${value}`);
const decodeAddress = (value) => `0x${value.slice(-40)}`;

export function createListingRecord({ listingId = "", seller, chain, contract, tokenId, amount, price, currency = "native", status = LISTING_STATUS.ACTIVE, createdAt = Date.now(), expiresAt = null }) { return { listingId, seller, chain, contract, tokenId: Number(tokenId), amount: Number(amount), price: String(price), currency, status, createdAt, expiresAt }; }
export function validateListingDraft({ seller, contract, tokenId, amount, price, currency = "native", expiresAt = 0, now = Date.now() }) {
  if (!isValidAddress(seller)) return "Connect a valid seller wallet.";
  if (!isValidAddress(contract)) return "This edition does not have a valid ERC-1155 contract.";
  if (!Number.isInteger(Number(tokenId)) || Number(tokenId) < 0) return "Token ID must be a non-negative integer.";
  if (!Number.isInteger(Number(amount)) || Number(amount) <= 0) return "Quantity must be a positive integer.";
  if (!/^[0-9]+$/.test(String(price)) || BigInt(price) <= 0n) return "Price must be a positive whole-unit amount.";
  if (currency !== "native") return "Only native currency listings are supported in this phase.";
  if (expiresAt && Number(expiresAt) <= now) return "Expiration must be in the future.";
  return null;
}
export function encodeCreateListing({ contract, seller, tokenId, amount, price, expiresAt = 0 }) { return SELECTORS.createListing + addressWord(contract) + addressWord(seller) + word(tokenId) + word(amount) + word(price) + word(expiresAt); }
export function encodeCancelListing(listingId) { return SELECTORS.cancelListing + word(listingId); }
export function encodeBuy(listingId) { return SELECTORS.buy + word(listingId); }
export function encodeApproval(marketplace, approved = true) { return SELECTORS.approval + addressWord(marketplace) + boolWord(approved); }
export function encodeApprovalCheck(owner, marketplace) { return SELECTORS.approved + addressWord(owner) + addressWord(marketplace); }

export async function submitApproval({ provider, owner, tokenContract, marketplace, chain, chainId }) {
  if (chainId !== chain.id) await switchChain(provider, chain.key);
  const txHash = await provider.request({ method: "eth_sendTransaction", params: [{ from: owner, to: tokenContract, data: encodeApproval(marketplace, true) }] });
  return waitForReceipt(provider, txHash);
}
export async function submitListing({ provider, owner, edition, marketplace, chain, chainId, tokenId, amount, price, expiresAt }) {
  const error = validateListingDraft({ seller: owner, contract: edition.contractAddress, tokenId, amount, price, expiresAt: expiresAt * 1000 });
  if (error) throw new Error(error);
  if (chainId !== chain.id) await switchChain(provider, chain.key);
  const txHash = await provider.request({ method: "eth_sendTransaction", params: [{ from: owner, to: marketplace, data: encodeCreateListing({ contract: edition.contractAddress, seller: owner, tokenId, amount, price, expiresAt }) }] });
  return waitForReceipt(provider, txHash);
}
export function listingIdFromReceipt(receipt) { const log = receipt?.logs?.find((item) => item.topics?.[0]?.toLowerCase() === LISTING_CREATED_TOPIC); return log?.topics?.[1] ? BigInt(log.topics[1]).toString() : null; }
export async function submitCancel({ provider, owner, marketplace, listingId }) { const txHash = await provider.request({ method: "eth_sendTransaction", params: [{ from: owner, to: marketplace, data: encodeCancelListing(listingId) }] }); return waitForReceipt(provider, txHash); }

export async function readListing({ provider, marketplace, listingId }) {
  const result = await provider.request({ method: "eth_call", params: [{ to: marketplace, data: SELECTORS.getListing + word(listingId) }, "latest"] });
  const words = result.replace(/^0x/, "").match(/.{64}/g) || [];
  if (words.length < 9) throw new Error("Marketplace returned an invalid listing.");
  return { listingId: decodeUint(words[0]).toString(), seller: decodeAddress(words[1]), tokenContract: decodeAddress(words[2]), tokenId: decodeUint(words[3]).toString(), amount: decodeUint(words[4]).toString(), price: decodeUint(words[5]).toString(), createdAt: Number(decodeUint(words[6])), expiresAt: Number(decodeUint(words[7])), status: [LISTING_STATUS.ACTIVE, LISTING_STATUS.SOLD, LISTING_STATUS.CANCELLED, LISTING_STATUS.EXPIRED][Number(decodeUint(words[8]))] || "UNKNOWN" };
}
export function validatePurchase({ listing, buyer, now = Math.floor(Date.now() / 1000) }) {
  if (!listing || listing.status !== LISTING_STATUS.ACTIVE) return "This listing is no longer active.";
  if (listing.expiresAt && now > listing.expiresAt) return "This listing has expired.";
  if (!isValidAddress(buyer)) return "Connect a valid buyer wallet.";
  if (!/^[0-9]+$/.test(String(listing.price)) || BigInt(listing.price) <= 0n) return "The listing has an invalid price.";
  if (!/^[0-9]+$/.test(String(listing.amount)) || BigInt(listing.amount) <= 0n) return "The listing has an invalid quantity.";
  return null;
}
export function verifyPurchaseReceipt(receipt, { listing, buyer, marketplace }) {
  if (!receipt || receipt.status !== "0x1") throw new Error("Purchase transaction did not succeed.");
  if (receipt.to && receipt.to.toLowerCase() !== marketplace.toLowerCase()) throw new Error("Receipt target did not match the marketplace.");
  const log = receipt.logs?.find((item) => item.topics?.[0]?.toLowerCase() === LISTING_SOLD_TOPIC);
  if (!log) throw new Error("Purchase receipt did not contain a marketplace settlement event.");
  const data = log.data.replace(/^0x/, "").match(/.{64}/g) || [];
  const actual = { listingId: BigInt(log.topics[1]).toString(), buyer: decodeAddress(log.topics[2]), seller: decodeAddress(log.topics[3]), tokenContract: decodeAddress(data[0]), tokenId: decodeUint(data[1]).toString(), amount: decodeUint(data[2]).toString(), price: decodeUint(data[3]).toString() };
  for (const [key, expected] of Object.entries({ listingId: String(listing.listingId), buyer, seller: listing.seller, tokenContract: listing.tokenContract, tokenId: String(listing.tokenId), amount: String(listing.amount), price: String(listing.price) })) {
    const normalizedExpected = typeof expected === "string" && expected.startsWith("0x") ? expected.toLowerCase() : String(expected);
    if (String(actual[key]).toLowerCase() !== normalizedExpected) throw new Error(`Settlement verification failed for ${key}.`);
  }
  return actual;
}
export async function submitPurchase({ provider, buyer, marketplace, listing, chain, chainId }) {
  const validationError = validatePurchase({ listing, buyer });
  if (validationError) throw Object.assign(new Error(validationError), { code: listing?.expiresAt && Math.floor(Date.now() / 1000) > listing.expiresAt ? "EXPIRED" : "INVALID_LISTING" });
  if (chainId !== chain.id) await switchChain(provider, chain.key);
  const txHash = await provider.request({ method: "eth_sendTransaction", params: [{ from: buyer, to: marketplace, data: encodeBuy(listing.listingId), value: `0x${BigInt(listing.price).toString(16)}` }] });
  const receipt = await waitForReceipt(provider, txHash);
  return { txHash, receipt, settlement: verifyPurchaseReceipt(receipt, { listing, buyer, marketplace }) };
}

export function transitionListing(listing, nextStatus) { if (!listing || !Object.values(LISTING_STATUS).includes(nextStatus)) throw new Error("Invalid listing state."); const allowed = { ACTIVE: ["SOLD", "CANCELLED", "EXPIRED"], SOLD: [], CANCELLED: [], EXPIRED: [] }; if (!allowed[listing.status].includes(nextStatus)) throw new Error(`Cannot transition ${listing.status} to ${nextStatus}.`); return { ...listing, status: nextStatus }; }
export { SELECTORS as MARKETPLACE_SELECTORS, LISTING_CREATED_TOPIC, LISTING_SOLD_TOPIC };

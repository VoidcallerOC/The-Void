// Read-only plan for selling a primary edition through the EXISTING ReleaseMarketplaceV4, so the
// 2.5% platform fee is pushed to the platform wallet inside buy() and nobody has to sign to collect it.
// It sends no transaction and needs no key: it reads the chain, then prints the calls the ARTIST wallet
// must sign (in order) with exact calldata.
//
//   node scripts/primary-via-marketplace-plan.mjs --rpc <url> --token-id <id> --quantity <n> --price-avax 0.25
//        [--release --artist --old-sale --marketplace --expires-at <unix>]
//
// Exit code 0 only when every read-only check passes.
import { pathToFileURL } from "node:url";
import { ethers } from "ethers";
import { ISSUER_ROLE } from "../src/lib/sale-authorization.js";

export const DEFAULTS = Object.freeze({
  release: "0x9aa6165b493ac50d0f8cdee2fd48a3c5155fd103",
  artist: "0x284c09a7cc187e096cbbdc88d99defe6df32180a",
  oldSale: "0x6ae84a51f100f10f0535a514555043ae9edf9aa3",
  marketplace: "0x0e77116142844478a55eed2ab79de9f93770f8f5",
  platform: "0xb65c575cae01574296fab6e620b9a15cc0121ce4",
});

const releaseIface = new ethers.Interface([
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function getRoleAdmin(bytes32 role) view returns (bytes32)",
  "function grantRole(bytes32 role, address account)",
  "function revokeRole(bytes32 role, address account)",
  "function mint(address to, uint256 tokenId, uint256 amount, bytes data)",
  "function setApprovalForAll(address operator, bool approved)",
  "function isApprovedForAll(address account, address operator) view returns (bool)",
  "function royaltyBpsOf(uint256 tokenId) view returns (uint96)",
  "function royaltyInfo(uint256 tokenId, uint256 salePrice) view returns (address, uint256)",
  "function edition(uint256 tokenId) view returns (tuple(bytes32 releaseId, bytes32 editionId, address artist, uint256 maxSupply, uint256 mintedSupply, string metadataUri, bool exists))",
]);
const marketIface = new ethers.Interface([
  "function createListing(address tokenContract, address seller, uint256 tokenId, uint256 amount, uint256 price, uint64 expiresAt) returns (uint256)",
  "function feeRecipient() view returns (address)",
  "function platformFeeBps() view returns (uint256)",
]);

const addr = (value) => ethers.getAddress(String(value).toLowerCase());

/** The ordered calls the artist signs. Pure: no network. */
export function buildPlan({ release, artist, oldSale, marketplace, tokenId, quantity, priceWei, expiresAt = 0 }) {
  const calls = [
    { step: 1, to: release, what: "Grant the artist wallet ISSUER_ROLE so it can mint its own edition", data: releaseIface.encodeFunctionData("grantRole", [ISSUER_ROLE, artist]) },
    { step: 2, to: release, what: "Revoke ISSUER_ROLE from the legacy sale so no further sale can add an unpayable platform credit", data: releaseIface.encodeFunctionData("revokeRole", [ISSUER_ROLE, oldSale]) },
    { step: 3, to: release, what: `Mint ${quantity} of token ${tokenId} to the artist (non-payable)`, data: releaseIface.encodeFunctionData("mint", [artist, tokenId, quantity, "0x"]) },
    { step: 4, to: release, what: "Approve the marketplace to move the artist's tokens", data: releaseIface.encodeFunctionData("setApprovalForAll", [marketplace, true]) },
    { step: 5, to: marketplace, what: "List the edition at the primary price", data: marketIface.encodeFunctionData("createListing", [release, artist, tokenId, quantity, priceWei, expiresAt]) },
  ];
  return calls.map((call) => ({ ...call, value: "0" }));
}

/** What one sale pays, from the marketplace's own arithmetic (floor division, 250 bps each). */
export function expectedSplit(priceWei, quantity = 1n) {
  const gross = BigInt(priceWei) * BigInt(quantity);
  const platform = (gross * 250n) / 10000n;
  const royalty = (gross * 250n) / 10000n;
  return { gross, platform, artistRoyalty: royalty, sellerProceeds: gross - platform - royalty, artistTotal: gross - platform };
}

export async function preflight({ provider, release, artist, oldSale, marketplace, platform, tokenId, quantity, priceWei }) {
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail });
  const rel = new ethers.Contract(release, releaseIface, provider);
  const mkt = new ethers.Contract(marketplace, marketIface, provider);
  const adminRole = ethers.ZeroHash;
  add("artist holds the release admin role (can grant/revoke ISSUER_ROLE)", await rel.hasRole(adminRole, artist), artist);
  add("legacy sale currently holds ISSUER_ROLE (will be revoked)", await rel.hasRole(ISSUER_ROLE, oldSale), oldSale);
  add("marketplace pays the platform fee to the platform wallet", addr(await mkt.feeRecipient()) === addr(platform), platform);
  add("marketplace platform fee is 250 bps", (await mkt.platformFeeBps()) === 250n, "250");
  add("edition royalty is 250 bps", (await rel.royaltyBpsOf(tokenId)) === 250n, "250");
  const [receiver] = await rel.royaltyInfo(tokenId, priceWei);
  add("edition royalty receiver is the artist, not the platform", addr(receiver) === addr(artist), receiver);
  const { maxSupply: max, mintedSupply: minted } = await rel.edition(tokenId);
  add("quantity fits remaining supply (max 0 = uncapped)", max === 0n || minted + BigInt(quantity) <= max, `minted ${minted} + ${quantity}, max ${max}`);
  return checks;
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, "")] = argv[i + 1];
  return out;
}

async function main() {
  const a = args(process.argv.slice(2));
  for (const key of ["rpc", "token-id", "quantity", "price-avax"]) if (!a[key]) throw new Error(`--${key} is required`);
  const cfg = {
    release: addr(a.release || DEFAULTS.release), artist: addr(a.artist || DEFAULTS.artist), oldSale: addr(a["old-sale"] || DEFAULTS.oldSale),
    marketplace: addr(a.marketplace || DEFAULTS.marketplace), platform: addr(DEFAULTS.platform),
    tokenId: BigInt(a["token-id"]), quantity: BigInt(a.quantity), priceWei: ethers.parseEther(a["price-avax"]), expiresAt: BigInt(a["expires-at"] || 0),
  };
  const provider = new ethers.JsonRpcProvider(a.rpc, undefined, { batchMaxCount: 1 });
  const checks = await preflight({ provider, ...cfg });
  for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}  (${c.detail})`);
  const split = expectedSplit(cfg.priceWei, 1n);
  console.log(`\nOne sale at ${a["price-avax"]} AVAX pays: platform ${ethers.formatEther(split.platform)} (pushed to ${cfg.platform}), artist royalty ${ethers.formatEther(split.artistRoyalty)}, seller (artist) ${ethers.formatEther(split.sellerProceeds)}.`);
  console.log("\nCalls for the ARTIST wallet to sign, in order (nothing is sent by this script):");
  for (const call of buildPlan(cfg)) console.log(`\n${call.step}. ${call.what}\n   to:   ${call.to}\n   data: ${call.data}`);
  process.exit(checks.every((c) => c.pass) ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main().catch((error) => { console.error(error.message); process.exit(2); });

import { ethers } from "ethers";

// Authorization of the sale contract a withdrawal is sent to. A sale is authorized when it is
// either (a) the legacy VoidPrimarySale that the factory itself registered for the release, or
// (b) a VoidPrimarySaleSettled whose deployed code is the reviewed one and that the release has
// authorized as an issuer. Everything else is refused and withdrawal stays disabled.

/** keccak256 of the reviewed VoidPrimarySaleSettled runtime with its immutables zeroed and the metadata trailer removed. */
export const SETTLED_SALE_RUNTIME_CODE_HASH = "0x0b6a2a7e8ec7fa8801ea896e664c6bf65747f3ec41d5742ab3e7a4553738de12";
/** [start, length] byte ranges of its immutables (releases, platformRecipient) in the runtime code. */
export const SETTLED_SALE_IMMUTABLE_RANGES = Object.freeze([[259, 32], [393, 32], [693, 32], [740, 32], [1026, 32], [1174, 32], [2935, 32], [3137, 32], [3242, 32], [3381, 32], [3435, 32]]);
export const ISSUER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ISSUER_ROLE"));

const saleIface = new ethers.Interface([
  "function releases() view returns (address)",
  "function platformRecipient() view returns (address)",
  "function PLATFORM_FEE_BPS() view returns (uint256)",
  "function owner() view returns (address)",
]);
const releaseIface = new ethers.Interface(["function hasRole(bytes32 role, address account) view returns (bool)"]);
const factoryIface = new ethers.Interface([
  "function isRelease(address) view returns (bool)",
  "function primarySaleOf(address) view returns (address)",
]);

const same = (a, b) => Boolean(a && b) && String(a).toLowerCase() === String(b).toLowerCase();
function checksum(value) {
  const text = String(value || "").trim();
  if (!ethers.isAddress(text) || ethers.getAddress(text) === ethers.ZeroAddress) return "";
  return ethers.getAddress(text);
}

/**
 * Hash of a runtime code with the given [start, length] byte ranges zeroed and the Solidity CBOR
 * metadata trailer (length in the last two bytes) removed. Throws on code too short for the ranges.
 */
export function maskedRuntimeHash(codeHex, ranges = SETTLED_SALE_IMMUTABLE_RANGES) {
  const hex = String(codeHex || "").replace(/^0x/i, "").toLowerCase();
  if (hex.length < 4) throw new Error("No runtime code.");
  const bytes = ethers.getBytes(`0x${hex}`);
  for (const [start, length] of ranges) {
    if (start + length > bytes.length) throw new Error("Runtime code is shorter than the reviewed code.");
    bytes.fill(0, start, start + length);
  }
  const trailer = (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];
  const end = bytes.length - (trailer + 2);
  if (end <= 0) throw new Error("Runtime code has no metadata trailer.");
  return ethers.keccak256(bytes.slice(0, end));
}

async function call(provider, to, iface, name, args = []) {
  const result = await provider.request({ method: "eth_call", params: [{ to, data: iface.encodeFunctionData(name, args) }, "latest"] });
  return iface.decodeFunctionResult(name, result)[0];
}

/**
 * Verifies, from live chain reads only, that `sale` may receive a withdrawal for `release`.
 * Returns { authorized, kind, problems, details }. `kind` is 'factory-registered-legacy',
 * 'settled-satellite' or null. The expected platform recipient must come from the committed
 * manifest, never from the API.
 */
export async function verifyAuthorizedSale(provider, { sale, release, factory = "", expectedPlatformRecipient = "", expectedFeeBps = 250, chainId }) {
  const problems = [];
  const details = { sale: checksum(sale), release: checksum(release), factory: checksum(factory), codeHash: null, platformRecipient: "" };
  if (!details.sale || !details.release) return { authorized: false, kind: null, problems: ["The sale and release addresses must be valid."], details };

  try {
    const chain = Number(BigInt(await provider.request({ method: "eth_chainId" })));
    if (chainId !== undefined && chain !== Number(chainId)) problems.push(`The RPC is on chain ${chain}, but this sale is on chain ${chainId}.`);
  } catch (error) {
    problems.push(`The chain could not be confirmed: ${error?.message || "read failed"}`);
  }

  let code = "0x";
  try {
    code = await provider.request({ method: "eth_getCode", params: [details.sale, "latest"] });
  } catch (error) {
    problems.push(`The sale code could not be read: ${error?.message || "read failed"}`);
  }
  if (!code || code === "0x") {
    problems.push("There is no contract code at the sale address.");
    return { authorized: false, kind: null, problems, details };
  }

  try { details.codeHash = maskedRuntimeHash(code); } catch { details.codeHash = null; }
  const isSettled = SETTLED_SALE_IMMUTABLE_RANGES.length > 0 && details.codeHash === SETTLED_SALE_RUNTIME_CODE_HASH;

  try {
    details.platformRecipient = checksum(await call(provider, details.sale, saleIface, "platformRecipient"));
  } catch { /* labelling only for the legacy kind */ }

  try {
    const bound = checksum(await call(provider, details.sale, saleIface, "releases"));
    if (!same(bound, details.release)) problems.push(`The sale contract is bound to ${bound || "no release"}, not ${details.release}.`);
  } catch (error) {
    problems.push(`The sale contract could not be read: ${error?.message || "read failed"}`);
  }

  if (isSettled) {
    const recipient = checksum(expectedPlatformRecipient);
    if (!recipient) problems.push("The expected platform recipient is not configured.");
    else if (!same(details.platformRecipient, recipient)) problems.push(`The sale pays the platform fee to ${details.platformRecipient || "an unreadable address"}, not the platform wallet ${recipient}.`);
    try {
      const fee = BigInt(await call(provider, details.sale, saleIface, "PLATFORM_FEE_BPS"));
      details.feeBps = Number(fee);
      if (fee !== BigInt(expectedFeeBps)) problems.push(`The sale fee is ${fee} basis points, not ${expectedFeeBps}.`);
    } catch (error) {
      problems.push(`The sale fee could not be read: ${error?.message || "read failed"}`);
    }
    let hasOwner = false;
    try { await call(provider, details.sale, saleIface, "owner"); hasOwner = true; } catch { /* no owner() is required */ }
    if (hasOwner) problems.push("The sale has an owner, so its fee could be changed. The reviewed sale has no owner.");
    try {
      const issuer = await call(provider, details.release, releaseIface, "hasRole", [ISSUER_ROLE, details.sale]);
      details.isIssuer = Boolean(issuer);
      if (!issuer) problems.push("The release has not authorized this sale to mint (no ISSUER_ROLE).");
    } catch (error) {
      problems.push(`The release role could not be read: ${error?.message || "read failed"}`);
    }
    if (details.factory) {
      try {
        if (!(await call(provider, details.factory, factoryIface, "isRelease", [details.release]))) problems.push("The factory does not recognize this release.");
      } catch (error) {
        problems.push(`The factory could not confirm the release: ${error?.message || "read failed"}`);
      }
    }
    return { authorized: problems.length === 0, kind: problems.length === 0 ? "settled-satellite" : null, problems, details };
  }

  // Not the reviewed settled sale: only the legacy sale that the factory registered is accepted.
  if (!details.factory) {
    problems.push("The sale is not the reviewed settled sale and there is no factory to vouch for it.");
    return { authorized: false, kind: null, problems, details };
  }
  try {
    const registered = checksum(await call(provider, details.factory, factoryIface, "primarySaleOf", [details.release]));
    if (!same(registered, details.sale)) problems.push(`The factory registers ${registered || "no sale"} for this release, not ${details.sale}, and this code is not the reviewed settled sale.`);
  } catch (error) {
    problems.push(`The factory could not confirm this sale: ${error?.message || "read failed"}`);
  }
  return { authorized: problems.length === 0, kind: problems.length === 0 ? "factory-registered-legacy" : null, problems, details };
}

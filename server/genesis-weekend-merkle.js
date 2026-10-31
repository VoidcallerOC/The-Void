// Merkle allowlist for GenesisWeekendClaim. The leaf and pair hashing match the contract exactly:
// leaf = keccak256(bytes.concat(keccak256(abi.encode(CAMPAIGN, 43114, account))))
// node = keccak256(abi.encode(min(a, b), max(a, b)))   (OpenZeppelin MerkleProof sorted pairs)
import { AbiCoder, getAddress, id, keccak256 } from "ethers";

export const WEEKEND_CAMPAIGN = id("the-void:genesis-weekend-claim:v1");
export const WEEKEND_DESTINATION_CHAIN_ID = 43114;

const coder = AbiCoder.defaultAbiCoder();

export function weekendLeaf(account) {
  const inner = keccak256(coder.encode(["bytes32", "uint256", "address"], [WEEKEND_CAMPAIGN, WEEKEND_DESTINATION_CHAIN_ID, getAddress(account)]));
  return keccak256(inner);
}

function hashPair(a, b) {
  return BigInt(a) < BigInt(b) ? keccak256(coder.encode(["bytes32", "bytes32"], [a, b])) : keccak256(coder.encode(["bytes32", "bytes32"], [b, a]));
}

/**
 * Builds the tree over unique wallets. Leaves are sorted by hash, so the root does not depend on input
 * order. An odd node at the end of a layer is carried up unchanged (it has no sibling at that level).
 */
export function buildWeekendTree(wallets) {
  const unique = [...new Set(wallets.map((wallet) => getAddress(wallet)))];
  if (!unique.length) throw new Error("A weekend allowlist needs at least one wallet.");
  const leaves = unique.map((wallet) => ({ wallet, leaf: weekendLeaf(wallet) })).sort((a, b) => (BigInt(a.leaf) < BigInt(b.leaf) ? -1 : 1));
  const layers = [leaves.map(({ leaf }) => leaf)];
  while (layers.at(-1).length > 1) {
    const layer = layers.at(-1);
    const next = [];
    for (let i = 0; i < layer.length; i += 2) next.push(i + 1 < layer.length ? hashPair(layer[i], layer[i + 1]) : layer[i]);
    layers.push(next);
  }
  const index = new Map(leaves.map(({ wallet }, position) => [wallet, position]));
  return Object.freeze({
    root: layers.at(-1)[0],
    size: leaves.length,
    wallets: Object.freeze(leaves.map(({ wallet }) => wallet)),
    has: (wallet) => index.has(getAddress(wallet)),
    proof(wallet) {
      let position = index.get(getAddress(wallet));
      if (position === undefined) return null;
      const proof = [];
      for (let level = 0; level < layers.length - 1; level += 1) {
        const sibling = position ^ 1;
        if (sibling < layers[level].length) proof.push(layers[level][sibling]);
        position >>= 1;
      }
      return proof;
    },
  });
}

export function verifyWeekendProof(root, wallet, proof) {
  let node = weekendLeaf(wallet);
  for (const sibling of proof) node = hashPair(node, sibling);
  return node.toLowerCase() === String(root).toLowerCase();
}

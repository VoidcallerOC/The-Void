// Offline check of Safe owner signatures before anything is submitted. No network,
// no keys: it recomputes the SafeTx hash for chain 43113 and recovers each signer
// from the signature bytes. It fails closed: a wallet that signed a different hash
// (wrong chain, wrong Safe, wrong nonce, wrong calldata) recovers to a different
// address and is rejected.
//
//   node scripts/verify-safe-signatures.mjs request.json
//
// request.json: { "safe": "0x..", "chainId": 43113, "owners": ["0x..", ...],
//   "threshold": 2, "tx": { SafeTx fields }, "signatures": ["0x<65 bytes>", ...] }
// Prints the recovered signers and, when valid, the signatures concatenated in the
// ascending-owner order execTransaction requires.
import { readFile } from "node:fs/promises";
import { Signature, getAddress, getBytes, hashMessage, recoverAddress } from "ethers";
import { CHAIN_ID, safeTxHash } from "./authority-rotation-plan.mjs";

export function recoverSafeSigner(hash, signature) {
  const bytes = getBytes(signature);
  if (bytes.length !== 65) throw new Error("Each signature must be 65 bytes (r, s, v).");
  const v = bytes[64];
  const r = signature.slice(0, 66);
  const s = `0x${signature.slice(66, 130)}`;
  if (v === 27 || v === 28) return { signer: getAddress(recoverAddress(hash, Signature.from({ r, s, v }))), kind: "EIP-712" };
  // Safe convention for eth_sign: v + 4, signed over the prefixed hash.
  if (v === 31 || v === 32) return { signer: getAddress(recoverAddress(hashMessage(getBytes(hash)), Signature.from({ r, s, v: v - 4 }))), kind: "eth_sign" };
  throw new Error(`Unsupported signature type v=${v} (contract or pre-approved signatures are not accepted here).`);
}

export function verifySafeSignatures({ safe, chainId, owners, threshold, tx, signatures }) {
  const problems = [];
  if (Number(chainId) !== CHAIN_ID) problems.push(`chainId must be ${CHAIN_ID} (Avalanche Fuji); got ${chainId}.`);
  const ownerSet = new Set((owners || []).map((o) => getAddress(o)));
  const hash = safeTxHash({ safe: getAddress(safe), chainId: Number(chainId), tx });
  const recovered = [];
  for (const sig of signatures || []) {
    try { recovered.push({ ...recoverSafeSigner(hash, sig), signature: sig }); } catch (error) { problems.push(error.message); }
  }
  for (const r of recovered) if (!ownerSet.has(r.signer)) problems.push(`${r.signer} is not a Safe owner (the device may have signed a different hash, chain or Safe).`);
  const unique = new Set(recovered.map((r) => r.signer));
  if (unique.size !== recovered.length) problems.push("Duplicate signer.");
  if (unique.size < Number(threshold)) problems.push(`Need ${threshold} distinct owner signatures; have ${unique.size}.`);
  if (Number(tx.operation) !== 0) problems.push("Only operation 0 (CALL) is accepted.");
  const ordered = [...recovered].sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1));
  return {
    ok: problems.length === 0, safeTxHash: hash, signers: recovered.map((r) => ({ signer: r.signer, kind: r.kind })), problems,
    signaturesForExecTransaction: problems.length === 0 ? `0x${ordered.map((r) => r.signature.slice(2)).join("")}` : null,
  };
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const request = JSON.parse(await readFile(process.argv[2], "utf8"));
  const result = verifySafeSignatures(request);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

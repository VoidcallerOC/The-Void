// Read-only: identifies the exact source commit and compiler settings of the three
// legacy VoidPrimarySale deployments, so the storage layout used by the rotation
// simulations is the layout of the deployed bytecode, not an assumption.
//
//   node scripts/legacy-sale-bytecode-check.mjs
//
// scripts/data/legacy-sale-fingerprints.json holds, per candidate build (source
// commit x compiler settings), the runtime length, immutable ranges, the keccak of
// the runtime with immutables zeroed and CBOR metadata stripped, and the solc
// storage layout. A deployment matches a candidate when the same normalisation of
// its deployed code yields the same hash.
import { readFile } from "node:fs/promises";
import { JsonRpcProvider, keccak256 } from "ethers";
import { LOCKED_OWNABLES } from "./authority-rotation-plan.mjs";

const FUJI_RPC = process.env.FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc";

export function normalizedRuntimeHash(code, immutableRanges) {
  let h = code.replace(/^0x/, "").toLowerCase();
  const metadataBytes = parseInt(h.slice(-4), 16) + 2;
  h = h.slice(0, h.length - metadataBytes * 2);
  for (const [start, length] of immutableRanges) h = h.slice(0, start * 2) + "00".repeat(length) + h.slice((start + length) * 2);
  return keccak256(`0x${h}`);
}

async function main() {
  const candidates = JSON.parse(await readFile(new URL("./data/legacy-sale-fingerprints.json", import.meta.url), "utf8"));
  const provider = new JsonRpcProvider(FUJI_RPC, 43113, { staticNetwork: true });
  const chainId = (await provider.send("eth_chainId", [])).toString();
  const out = { chainId: Number(chainId), deployments: [] };
  for (const sale of LOCKED_OWNABLES) {
    const code = await provider.getCode(sale.address);
    const bytes = (code.length - 2) / 2;
    const matches = candidates.filter((c) => c.runtimeBytes === bytes && normalizedRuntimeHash(code, c.immutableRanges) === c.normalizedRuntimeHash);
    out.deployments.push({
      address: sale.address, label: sale.label, runtimeBytes: bytes, codeHash: keccak256(code),
      transferOwnershipSelectorPresent: code.toLowerCase().includes("63f2fde38b"),
      matches: matches.map((m) => ({ sourceCommit: m.sourceCommit, compiler: m.compiler, storageLayout: m.storageLayout, saleStruct: m.saleStruct })),
      exactlyOneMatch: matches.length === 1,
    });
  }
  console.log(JSON.stringify(out, null, 2));
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) main().catch((error) => { console.error(error); process.exit(1); });

import { Interface, getAddress } from "ethers";
import { describe, expect, it } from "vitest";
import { glacierIssuance, impliedBalances, normalizeTransfer, repairExplorerGaps } from "./genesis-weekend-snapshot.mjs";

const TRANSFERS = new Interface([
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
]);
const ZERO = "0x0000000000000000000000000000000000000000";
const A = getAddress("0x00000000000000000000000000000000000000a1");
const B = getAddress("0x00000000000000000000000000000000000000b2");
const HIDDEN = getAddress("0x00000000000000000000000000000000000000d4");

function single({ from, to, id, value, block, tx, index = 0 }) {
  const encoded = TRANSFERS.encodeEventLog(TRANSFERS.getEvent("TransferSingle"), [A, from, to, id, value]);
  return { ...encoded, blockNumber: block, transactionHash: tx, index };
}

describe("snapshot generator: explorer gap repair from the node", () => {
  it("normalizes explorer (hex) and node (numeric) logs to the same key", () => {
    const node = single({ from: ZERO, to: A, id: 2, value: 1, block: 100, tx: "0xAA", index: 3 });
    const explorer = { ...node, blockNumber: "0x64", logIndex: "0x3", index: undefined };
    expect(normalizeTransfer(node).key).toBe(normalizeTransfer(explorer).key);
    expect(normalizeTransfer({ topics: ["0x01"], data: "0x" })).toBeNull();
  });

  it("finds a transfer the explorer never reported, and the hidden holder it created", async () => {
    // Chain truth: block 100 mints 2 x id 2 to A; block 200 moves 1 to HIDDEN (missing from the explorer).
    const mint = single({ from: ZERO, to: A, id: 2, value: 2, block: 100, tx: "0x01" });
    const missing = single({ from: A, to: HIDDEN, id: 2, value: 1, block: 200, tx: "0x02" });
    const transfers = new Map([[normalizeTransfer(mint).key, normalizeTransfer(mint)]]);
    const chain = [normalizeTransfer(mint), normalizeTransfer(missing)];
    const readBalances = async (wallet, block) => impliedBalances(new Map(chain.map((t) => [t.key, t])), getAddress(wallet), block);
    const readBlockLogs = async (block) => (block === 200 ? [missing] : []);
    const repairs = await repairExplorerGaps({ transfers, snapshotBlock: 300, readBalances, readBlockLogs, firstBlock: 0 });
    expect(repairs).toEqual([{ wallet: A, block: 200, logsAdded: 1 }]);
    expect(transfers.has(normalizeTransfer(missing).key)).toBe(true);
    expect(impliedBalances(transfers, HIDDEN, 300)[2]).toBe(1n);
  });

  it("refuses when the node shows a divergence but no missing log, and stops after maxRepairs", async () => {
    const mint = single({ from: ZERO, to: A, id: 0, value: 1, block: 10, tx: "0x03" });
    const transfers = new Map([[normalizeTransfer(mint).key, normalizeTransfer(mint)]]);
    const readBalances = async () => [0n, 0n, 0n, 0n];
    await expect(repairExplorerGaps({ transfers, snapshotBlock: 20, readBalances, readBlockLogs: async () => [], firstBlock: 0 })).rejects.toThrow(/no missing Genesis transfer/);
    await expect(repairExplorerGaps({ transfers, snapshotBlock: 20, readBalances, readBlockLogs: async () => [], firstBlock: 0, maxRepairs: 0 })).rejects.toThrow(/after 0 repairs/);
  });
});

describe("snapshot generator: independent Glacier issuance", () => {
  const entry = (overrides) => ({ blockNumber: "100", txHash: "0xab", logIndex: 1, from: { address: ZERO }, to: { address: A }, value: "2", erc1155Token: { tokenId: "1" }, ...overrides });
  const pages = [
    { transfers: [entry(), entry({ txHash: "0xac", from: { address: A }, to: { address: B }, value: "1" })], nextPageToken: "p2" },
    { transfers: [entry({ txHash: "0xad", from: { address: B }, to: { address: ZERO }, value: "1" }), entry({ blockNumber: "999", txHash: "0xae" })] },
  ];
  const fetchImpl = async (url) => ({ ok: true, json: async () => (url.includes("pageToken=p2") ? pages[1] : pages[0]) });

  it("pages through Glacier and counts mints minus burns up to the snapshot block only", async () => {
    const result = await glacierIssuance({ address: "0xD1B4367dd9f235f9ee61878019d66E31511E98eE", toBlock: 500, fetchImpl });
    expect(result.issued).toEqual([0n, 1n, 0n, 0n]);
    expect([...result.candidates].sort()).toEqual([A, B].sort());
    expect(result.transfers).toBe(3);
  });
});

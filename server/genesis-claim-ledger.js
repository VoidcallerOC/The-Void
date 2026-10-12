import { Interface, getAddress } from "ethers";

// Genesis (0xD1B4…98eE, C-Chain) is a Launchpeg ERC1155SingleBundle: token IDs 0-3 are fungible
// units with no per-unit identity, and transfers are plain ERC-1155 (no hooks the claim could use).
// A live balance alone cannot tell whether a unit already backed a free claim, so the claim service
// keeps this ledger of "used" units:
//   - When a wallet's voucher is issued at C-Chain block B, every Genesis unit it holds at B (all IDs)
//     becomes used. One claim per wallet, however many IDs or units it holds.
//   - Used units travel with transfers: a transfer moves the sender's used units first.
//   - A wallet is eligible only while it holds at least one unused unit.
// Each unit can therefore back at most one free claim, Genesis tokens are never moved or locked by the
// claim, and a holding passed to another wallet after its claim carries no new eligibility.

export const GENESIS_TOKEN_ID_SET = Object.freeze(["0", "1", "2", "3"]);
const TRANSFER_INTERFACE = new Interface([
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
]);
export const TRANSFER_SINGLE_TOPIC = TRANSFER_INTERFACE.getEvent("TransferSingle").topicHash;
export const TRANSFER_BATCH_TOPIC = TRANSFER_INTERFACE.getEvent("TransferBatch").topicHash;
const ZERO = "0x0000000000000000000000000000000000000000";

export class GenesisLedgerError extends Error {
  constructor(message) { super(message); this.name = "GenesisLedgerError"; }
}

/** Decodes TransferSingle/TransferBatch logs into one entry per eligible token ID moved. */
export function decodeGenesisTransfers(logs) {
  const transfers = [];
  for (const log of logs) {
    const parsed = TRANSFER_INTERFACE.parseLog({ topics: log.topics, data: log.data });
    if (!parsed) throw new GenesisLedgerError("Unrecognized Genesis log.");
    // Positional args: on an ethers Result, `values` is a method, not the event's values field.
    const [, from, to, ids, amounts] = parsed.args;
    const pairs = parsed.name === "TransferSingle" ? [[ids, amounts]] : ids.map((id, index) => [id, amounts[index]]);
    for (const [id, amount] of pairs) {
      if (!GENESIS_TOKEN_ID_SET.includes(id.toString())) continue;
      transfers.push({
        block: Number(log.blockNumber),
        logIndex: Number(log.index ?? log.logIndex),
        from: getAddress(from),
        to: getAddress(to),
        id: id.toString(),
        amount: BigInt(amount),
      });
    }
  }
  return transfers;
}

function bucket(map, wallet) {
  if (!map.has(wallet)) map.set(wallet, new Map());
  return map.get(wallet);
}

/**
 * Replays reservations (voucher issuances) and Genesis transfers in C-Chain order and returns the
 * used-unit counts per wallet and token ID. A reservation at block B applies after every transfer in
 * blocks <= B, because its balances were read at B. `transfers` must cover every block after the
 * earliest reservation through `throughBlock`.
 */
export function replayUsedUnits({ reservations, transfers, throughBlock }) {
  const used = new Map();
  const ordered = [...transfers]
    .filter((transfer) => transfer.block <= throughBlock)
    .sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  const queue = [...reservations].sort((a, b) => a.block - b.block);
  let next = 0;
  const applyReservationsThrough = (block) => {
    while (next < queue.length && queue[next].block <= block) {
      const reservation = queue[next++];
      const wallet = getAddress(reservation.wallet);
      const units = bucket(used, wallet);
      for (const id of GENESIS_TOKEN_ID_SET) units.set(id, BigInt(reservation.balances?.[id] ?? 0));
    }
  };
  for (const transfer of ordered) {
    applyReservationsThrough(transfer.block - 1);
    if (transfer.from === ZERO) continue;
    const fromUnits = bucket(used, transfer.from);
    const moved = (fromUnits.get(transfer.id) ?? 0n) < transfer.amount ? (fromUnits.get(transfer.id) ?? 0n) : transfer.amount;
    if (moved === 0n) continue;
    fromUnits.set(transfer.id, fromUnits.get(transfer.id) - moved);
    if (transfer.to === ZERO) continue;
    const toUnits = bucket(used, transfer.to);
    toUnits.set(transfer.id, (toUnits.get(transfer.id) ?? 0n) + moved);
  }
  applyReservationsThrough(throughBlock);
  return used;
}

/**
 * Unused units for one wallet: live balance minus used units, per ID. More used units than the
 * wallet holds means the transfer history is incomplete; that fails closed.
 */
export function unusedUnits(wallet, balances, used) {
  const units = used.get(getAddress(wallet)) ?? new Map();
  const result = {};
  for (const id of GENESIS_TOKEN_ID_SET) {
    const balance = BigInt(balances[id] ?? 0);
    const spent = units.get(id) ?? 0n;
    if (spent > balance) throw new GenesisLedgerError(`Ledger shows ${spent} used units of Genesis ${id} but the wallet holds ${balance}.`);
    result[id] = balance - spent;
  }
  return result;
}

import { getAddress } from "ethers";

// Voucher issuances ("reservations") for the Genesis claim ledger (genesis-claim-ledger.js). Every
// issuance runs inside withLock, so two wallets can never be judged against the same holding at once.
// status: PENDING (voucher issued, may still be redeemed), REDEEMED (hasClaimed on-chain),
// EXPIRED (deadline passed on the destination chain without a claim; no longer uses any units).

function toRecord(row) {
  return Object.freeze({
    claimContract: getAddress(row.claim_contract),
    wallet: getAddress(row.wallet),
    block: Number(row.eligibility_block),
    usedTokenId: row.used_token_id,
    balances: row.balances,
    deadline: BigInt(row.deadline),
    status: row.status,
    voucher: row.voucher,
    signature: row.signature,
  });
}

/** Postgres store. One advisory lock per claim contract serializes issuance across API instances. */
export function createGenesisClaimReservationStore(pool, options = {}) {
  const ledgerContracts = (options.ledgerContracts || []).map((a) => a.toLowerCase());
  return Object.freeze({
    async withLock(claimContract, fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`genesis-claim-ledger:${claimContract.toLowerCase()}`]);
        const tx = {
          async list() {
            const contracts = [claimContract.toLowerCase(), ...ledgerContracts.filter((c) => c !== claimContract.toLowerCase())];
            const { rows } = await client.query(
              "SELECT * FROM genesis_claim_reservations WHERE claim_contract = ANY($1)",
              [contracts],
            );
            return rows.map(toRecord);
          },
          async upsert(record) {
            await client.query(
              `INSERT INTO genesis_claim_reservations (claim_contract, wallet, eligibility_block, used_token_id, balances, deadline, status, voucher, signature)
               VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9)
               ON CONFLICT (claim_contract, wallet) DO UPDATE SET eligibility_block=EXCLUDED.eligibility_block, used_token_id=EXCLUDED.used_token_id, balances=EXCLUDED.balances,
                 deadline=EXCLUDED.deadline, status=EXCLUDED.status, voucher=EXCLUDED.voucher, signature=EXCLUDED.signature, updated_at=now()`,
              [record.claimContract.toLowerCase(), record.wallet.toLowerCase(), record.block, String(record.usedTokenId), JSON.stringify(record.balances), record.deadline.toString(), record.status, JSON.stringify(record.voucher), record.signature],
            );
          },
          async setStatus(wallet, status) {
            await client.query("UPDATE genesis_claim_reservations SET status=$3, updated_at=now() WHERE claim_contract=$1 AND wallet=$2", [claimContract.toLowerCase(), wallet.toLowerCase(), status]);
          },
        };
        const result = await fn(tx);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
  });
}

/** In-process store for tests and single-process tooling. Same interface, promise-chain lock. */
export function createMemoryGenesisClaimReservationStore(options = {}) {
  const rows = new Map();
  let tail = Promise.resolve();
  const ledgerContracts = (options.ledgerContracts || []).map((a) => a.toLowerCase());
  return Object.freeze({
    rows,
    async withLock(claimContract, fn) {
      const run = tail.then(async () => {
        const staged = new Map(rows);
        const key = (wallet) => `${claimContract.toLowerCase()}:${wallet.toLowerCase()}`;
        const tx = {
          async list() {
            const prefixes = new Set([`${claimContract.toLowerCase()}:`, ...ledgerContracts.map((c) => `${c}:`)]);
            return [...staged.entries()].filter(([k]) => [...prefixes].some((p) => k.startsWith(p))).map(([, value]) => value);
          },
          async upsert(record) { staged.set(key(record.wallet), Object.freeze({ ...record, claimContract: getAddress(claimContract), wallet: getAddress(record.wallet) })); },
          async setStatus(wallet, status) { const current = staged.get(key(wallet)); if (current) staged.set(key(wallet), Object.freeze({ ...current, status })); },
        };
        const result = await fn(tx);
        rows.clear();
        for (const [k, v] of staged) rows.set(k, v);
        return result;
      });
      tail = run.catch(() => {});
      return run;
    },
  });
}

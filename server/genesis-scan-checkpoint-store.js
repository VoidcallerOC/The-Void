import { createHash } from "node:crypto";

// Persisted Genesis transfer-scan checkpoint (migration 050). Derived data only: it can always be rebuilt
// from C-Chain, so anything that does not validate is ignored rather than trusted.
//
// A checkpoint is { from, end, endHash, anchors: [{ block, hash }], logs: [{ blockNumber, index, topics, data }] }:
// every Genesis transfer log in [from, end], with end's block hash, plus up to MAX_ANCHORS earlier verified
// (block, hash) pairs used to rewind after a reorg. `digest` covers all of it; a row whose digest, shape or
// ranges do not check out is reported as corrupt.
//
// Writes are compare-and-set: save(claimContract, expected, next) replaces the row only if it still holds
// `expected` (by end block and end hash; null means "no row"), so two workers can never double-advance or
// overwrite each other's newer checkpoint. The Postgres store additionally serializes writers with a
// transaction-scoped advisory lock, and the row (data and checkpoint together) is written in one statement
// inside one transaction: a failure rolls everything back and leaves the previous checkpoint in place.

export const MAX_ANCHORS = 8;
const HASH = /^0x[0-9a-f]{64}$/;
const HEX = /^0x[0-9a-f]*$/;

export class GenesisCheckpointCorruptError extends Error {
  constructor(message) { super(message); this.name = "GenesisCheckpointCorruptError"; }
}

const lower = (value) => String(value).toLowerCase();

/** The stored form of one log: only what decodeGenesisTransfers reads. */
export function normalizeLog(log) {
  return Object.freeze({
    blockNumber: Number(log.blockNumber),
    index: Number(log.index ?? log.logIndex),
    topics: Object.freeze(log.topics.map(lower)),
    data: lower(log.data),
  });
}

export function checkpointDigest({ from, end, endHash, anchors, logs }) {
  return createHash("sha256").update(JSON.stringify({ v: 1, from, end, endHash, anchors, logs })).digest("hex");
}

/** Validates a checkpoint's shape and ranges; throws GenesisCheckpointCorruptError. Returns a frozen copy. */
export function validateCheckpoint(raw, digest = undefined) {
  const fail = (why) => { throw new GenesisCheckpointCorruptError(`Genesis scan checkpoint is invalid: ${why}.`); };
  if (!raw || typeof raw !== "object") fail("missing");
  const from = Number(raw.from);
  const end = Number(raw.end);
  if (!Number.isSafeInteger(from) || from <= 0 || !Number.isSafeInteger(end) || end < from) fail("range");
  const endHash = lower(raw.endHash ?? "");
  if (!HASH.test(endHash)) fail("end hash");
  if (!Array.isArray(raw.anchors) || raw.anchors.length > MAX_ANCHORS) fail("anchors");
  let previous = from - 1;
  const anchors = raw.anchors.map((anchor) => {
    const block = Number(anchor?.block);
    const hash = lower(anchor?.hash ?? "");
    if (!Number.isSafeInteger(block) || block <= previous || block >= end || !HASH.test(hash)) fail("anchor");
    previous = block;
    return Object.freeze({ block, hash });
  });
  if (!Array.isArray(raw.logs)) fail("logs");
  const logs = raw.logs.map((log) => {
    if (!log || !Array.isArray(log.topics) || typeof log.data !== "string") fail("log shape");
    const normal = normalizeLog(log);
    if (!Number.isSafeInteger(normal.blockNumber) || normal.blockNumber < from || normal.blockNumber > end) fail("log outside range");
    if (!Number.isSafeInteger(normal.index) || normal.index < 0 || !HEX.test(normal.data) || !normal.topics.every((topic) => HASH.test(topic))) fail("log fields");
    return normal;
  });
  const checkpoint = Object.freeze({ from, end, endHash, anchors: Object.freeze(anchors), logs: Object.freeze(logs) });
  if (digest !== undefined && digest !== checkpointDigest(checkpoint)) fail("digest");
  return checkpoint;
}

const sameAs = (row, expected) => (row === null && expected === null)
  || (row !== null && expected !== null && Number(row.end) === Number(expected.end) && lower(row.endHash) === lower(expected.endHash));

/** Postgres store (migration 050). */
export function createGenesisScanCheckpointStore(pool) {
  return Object.freeze({
    /** The stored checkpoint, null when none, or a GenesisCheckpointCorruptError when it does not validate. */
    async load(claimContract) {
      const { rows } = await pool.query("SELECT from_block, end_block, end_hash, anchors, logs, digest FROM genesis_scan_checkpoints WHERE claim_contract=$1", [lower(claimContract)]);
      if (!rows.length) return null;
      const [row] = rows;
      return validateCheckpoint({ from: row.from_block, end: row.end_block, endHash: row.end_hash, anchors: row.anchors, logs: row.logs }, row.digest);
    },
    /** Compare-and-set; resolves true when written, false when the row no longer matches `expected`. */
    async save(claimContract, expected, next) {
      const checkpoint = validateCheckpoint(next);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`genesis-scan-checkpoint:${lower(claimContract)}`]);
        const { rows } = await client.query("SELECT end_block, end_hash FROM genesis_scan_checkpoints WHERE claim_contract=$1 FOR UPDATE", [lower(claimContract)]);
        const current = rows.length ? { end: rows[0].end_block, endHash: rows[0].end_hash } : null;
        if (!sameAs(current, expected)) {
          await client.query("ROLLBACK");
          return false;
        }
        await client.query(
          `INSERT INTO genesis_scan_checkpoints (claim_contract, from_block, end_block, end_hash, anchors, logs, digest)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)
           ON CONFLICT (claim_contract) DO UPDATE SET from_block=EXCLUDED.from_block, end_block=EXCLUDED.end_block, end_hash=EXCLUDED.end_hash,
             anchors=EXCLUDED.anchors, logs=EXCLUDED.logs, digest=EXCLUDED.digest, updated_at=now()`,
          [lower(claimContract), checkpoint.from, checkpoint.end, checkpoint.endHash, JSON.stringify(checkpoint.anchors), JSON.stringify(checkpoint.logs), checkpointDigest(checkpoint)],
        );
        await client.query("COMMIT");
        return true;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    /** Removes the row only if it still holds `expected` (a corrupt row is removed by passing { corrupt: true }). */
    async discard(claimContract, expected) {
      if (expected?.corrupt) {
        await pool.query("DELETE FROM genesis_scan_checkpoints WHERE claim_contract=$1", [lower(claimContract)]);
        return true;
      }
      const { rowCount } = await pool.query("DELETE FROM genesis_scan_checkpoints WHERE claim_contract=$1 AND end_block=$2 AND end_hash=$3", [lower(claimContract), expected.end, lower(expected.endHash)]);
      return rowCount > 0;
    },
  });
}

/**
 * In-process store with the same contract, for tests and tooling. Several services sharing one instance
 * behave like several workers sharing one database. `failNextSave` simulates a failed (rolled back) write.
 */
export function createMemoryGenesisScanCheckpointStore() {
  const rows = new Map();
  let tail = Promise.resolve();
  const serialized = (fn) => { const run = tail.then(fn); tail = run.catch(() => {}); return run; };
  const store = {
    rows,
    failNextSave: null,
    saves: 0,
    async load(claimContract) {
      const row = rows.get(lower(claimContract));
      if (!row) return null;
      return validateCheckpoint(structuredClone(row.checkpoint), row.digest);
    },
    save(claimContract, expected, next) {
      return serialized(async () => {
        const checkpoint = validateCheckpoint(next);
        const row = rows.get(lower(claimContract));
        if (!sameAs(row ? row.checkpoint : null, expected)) return false;
        if (store.failNextSave) { const error = store.failNextSave; store.failNextSave = null; throw error; }
        rows.set(lower(claimContract), { checkpoint: structuredClone(checkpoint), digest: checkpointDigest(checkpoint) });
        store.saves += 1;
        return true;
      });
    },
    discard(claimContract, expected) {
      return serialized(async () => {
        const row = rows.get(lower(claimContract));
        if (!row) return false;
        if (!expected?.corrupt && !sameAs(row.checkpoint, expected)) return false;
        rows.delete(lower(claimContract));
        return true;
      });
    },
  };
  return store;
}

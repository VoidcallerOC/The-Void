import process from "node:process";
import { fileURLToPath } from "node:url";
import { Contract, Interface, JsonRpcProvider, getAddress, ZeroAddress } from "ethers";
import { createDatabasePool } from "../server/db.js";
import { createGenesisClaimReservationStore } from "../server/genesis-claim-store.js";

export const APPLY_AUTHORIZATION = "OWNER_APPROVED_P0_GENESIS_SETTLEMENT";
export const RELEASE_CONTRACT = "0xf0c091a159de16cf0f306b2b61d37685ec5a830e";
export const TARGETS = Object.freeze([
  Object.freeze({
    name: "candidate",
    claimContract: "0x7d1a068f532ad6c0f591d4fb9f82fd5b97495363",
    wallet: "0xabd3746e8b852f55be52fc44fab6cab908b1c174",
    eligibilityBlock: 98685334,
    usedTokenId: "3",
    deadline: 1793099100n,
    receipt: "0x3ef4fac8381749219121606fe233cb029ebf8a1383025db184a7d0e388cda6dc",
  }),
  Object.freeze({
    name: "recovery",
    claimContract: "0xd70dba7ff6419481d62d4689bdf271ad441766b8",
    wallet: "0x70773318349af374e86254ef87e2dd542d0bbfc6",
    eligibilityBlock: 98722511,
    usedTokenId: "0",
    deadline: 1793136208n,
    receipt: "0xafb7636cbdf5354e6756b9921df743ebbaa74dd3b8f9733d2df8c0260624458f",
  }),
]);

const CLAIM_INTERFACE = new Interface([
  "event GenesisHolderClaimed(address indexed claimant, address indexed releaseContract, uint256 indexed tokenId, uint256 quantity, uint256 nonce, bytes32 voucherHash)",
]);
const RELEASE_INTERFACE = new Interface([
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
]);
const CLAIM_READER_ABI = ["function hasClaimed(address) view returns (bool)"];
const lower = (value) => String(value).toLowerCase();
const address = (value) => getAddress(value);
const sameAddress = (a, b) => lower(a) === lower(b);
const sanitizedTarget = (target) => ({ name: target.name, claimContract: lower(target.claimContract), wallet: lower(target.wallet), eligibilityBlock: target.eligibilityBlock, usedTokenId: target.usedTokenId, deadline: target.deadline.toString(), receipt: target.receipt });

function assertTargetConstants(target) {
  if (!TARGETS.includes(target)) throw new Error("Target is not in the immutable two-record allowlist.");
}

function assertPreimage(row, target) {
  if (!row || !sameAddress(row.claimContract, target.claimContract) || !sameAddress(row.wallet, target.wallet)
    || Number(row.block) !== target.eligibilityBlock || String(row.usedTokenId) !== target.usedTokenId
    || BigInt(row.deadline) !== target.deadline || !["PENDING", "REDEEMED"].includes(row.status)) {
    throw new Error(`Reservation preimage mismatch for ${target.name}.`);
  }
}

export function verifyReceipt(receipt, target) {
  assertTargetConstants(target);
  if (!receipt || Number(receipt.status) !== 1 || !sameAddress(receipt.to, target.claimContract)) throw new Error(`Receipt verification failed for ${target.name}: status or claim destination mismatch.`);
  let claimed = false;
  let minted = false;
  for (const log of receipt.logs || []) {
    try {
      const parsed = CLAIM_INTERFACE.parseLog({ topics: log.topics, data: log.data });
      if (parsed?.name === "GenesisHolderClaimed"
        && sameAddress(parsed.args.claimant, target.wallet)
        && sameAddress(parsed.args.releaseContract, RELEASE_CONTRACT)
        && BigInt(parsed.args.tokenId) === 1n
        && BigInt(parsed.args.quantity) === 1n) claimed = true;
    } catch { /* Try the release event interface. */ }
    try {
      const parsed = RELEASE_INTERFACE.parseLog({ topics: log.topics, data: log.data });
      if (parsed?.name === "TransferSingle"
        && sameAddress(log.address, RELEASE_CONTRACT)
        && sameAddress(parsed.args.from, ZeroAddress)
        && sameAddress(parsed.args.to, target.wallet)
        && BigInt(parsed.args.id) === 1n
        && BigInt(parsed.args.value) === 1n) minted = true;
    } catch { /* Ignore unrelated logs. */ }
  }
  if (!claimed || !minted) throw new Error(`Receipt verification failed for ${target.name}: required claim and mint events are absent or mismatched.`);
  return Object.freeze({ status: 1, blockNumber: Number(receipt.blockNumber), blockHash: lower(receipt.blockHash), claimedEvent: true, mintEvent: true });
}

export async function settleTarget({ store, target, chain, apply = false, logger = () => {} } = {}) {
  assertTargetConstants(target);
  if (!store?.withLock || typeof chain?.readReceipt !== "function" || typeof chain?.readHasClaimed !== "function") throw new TypeError("Settlement requires a reservation store and read-only chain readers.");
  return store.withLock(target.claimContract, async (tx) => {
    const rows = (await tx.list()).filter((row) => sameAddress(row.claimContract, target.claimContract) && sameAddress(row.wallet, target.wallet));
    if (rows.length !== 1) throw new Error(`Expected exactly one reservation row for ${target.name}; found ${rows.length}.`);
    const [row] = rows;
    assertPreimage(row, target);
    const receipt = verifyReceipt(await chain.readReceipt(target.receipt), target);
    const hasClaimed = await chain.readHasClaimed(target.claimContract, target.wallet);
    if (hasClaimed !== true) throw new Error(`hasClaimed() is not true for ${target.name}.`);
    const evidence = Object.freeze({ target: sanitizedTarget(target), chainBlock: Number(await chain.readBlockNumber()), receipt, hasClaimed });
    if (row.status === "REDEEMED") {
      logger({ event: "already_redeemed", ...evidence });
      return Object.freeze({ mode: apply ? "APPLY" : "DRY_RUN", outcome: "NOOP_ALREADY_REDEEMED", applied: false, evidence });
    }
    const transition = { from: "PENDING", to: "REDEEMED" };
    if (!apply) {
      logger({ event: "dry_run_transition", ...evidence, transition, applied: false });
      return Object.freeze({ mode: "DRY_RUN", outcome: "WOULD_REDEEM", applied: false, evidence, transition });
    }
    if (typeof tx.setStatusIfPreimage !== "function") throw new Error("Store lacks the exact-preimage status update required by this runner.");
    const updated = await tx.setStatusIfPreimage(row, "REDEEMED");
    if (!Array.isArray(updated) || updated.length !== 1) throw new Error(`Expected exactly one affected row for ${target.name}; found ${updated?.length ?? 0}.`);
    logger({ event: "applied_transition", ...evidence, transition, applied: true, affectedRows: 1 });
    return Object.freeze({ mode: "APPLY", outcome: "REDEEMED", applied: true, evidence, transition, affectedRows: 1 });
  });
}

export async function runSettlement({ store, targets = TARGETS, chain, apply = false, logger = console.log } = {}) {
  if (targets.length !== 2 || targets.some((target) => !TARGETS.includes(target))) throw new Error("This runner is permanently limited to the two allowlisted targets.");
  const results = [];
  for (const target of targets) {
    try {
      results.push(await settleTarget({ store, target, chain, apply, logger }));
    } catch (error) {
      const failure = { event: "target_failed", target: sanitizedTarget(target), error: error.message, priorResults: results.map((result) => ({ outcome: result.outcome, applied: result.applied })) };
      logger(failure);
      const wrapped = new Error(`Genesis settlement failed for ${target.name}: ${error.message}`);
      wrapped.results = results;
      wrapped.failure = failure;
      throw wrapped;
    }
  }
  const applied = results.filter((result) => result.applied).length;
  const alreadyRedeemed = results.filter((result) => result.outcome === "NOOP_ALREADY_REDEEMED").length;
  if (apply && applied + alreadyRedeemed !== 2) throw new Error(`Aggregate apply guard failed: expected 2 settled targets, got ${applied + alreadyRedeemed}.`);
  return Object.freeze({ mode: apply ? "APPLY" : "DRY_RUN", targets: results, expectedTransitions: 2, appliedTransitions: applied, alreadyRedeemed });
}

function hasFlag(name) { return process.argv.includes(name); }
function authorizationValue() { return process.argv.find((value) => value.startsWith("--authorize="))?.slice("--authorize=".length) || ""; }
function assertApplyAuthorization() {
  if (!hasFlag("--apply") || authorizationValue() !== APPLY_AUTHORIZATION || process.env.GENESIS_SETTLEMENT_ALLOW_APPLY !== "YES") {
    throw new Error("Apply requires --apply, --authorize=OWNER_APPROVED_P0_GENESIS_SETTLEMENT, and GENESIS_SETTLEMENT_ALLOW_APPLY=YES.");
  }
}

async function main() {
  const apply = hasFlag("--apply");
  if (apply) assertApplyAuthorization();
  const provider = new JsonRpcProvider(process.env.GENESIS_DESTINATION_RPC_URL, 43114, { staticNetwork: true });
  const claimCache = new Map();
  const chain = {
    readReceipt: (hash) => provider.getTransactionReceipt(hash),
    readHasClaimed: async (contractAddress, wallet) => {
      let claim = claimCache.get(lower(contractAddress));
      if (!claim) { claim = new Contract(address(contractAddress), CLAIM_READER_ABI, provider); claimCache.set(lower(contractAddress), claim); }
      return claim.hasClaimed(wallet);
    },
    readBlockNumber: () => provider.getBlockNumber(),
  };
  const pool = createDatabasePool();
  try {
    const store = createGenesisClaimReservationStore(pool, { ledgerContracts: [] });
    const result = await runSettlement({ store, chain, apply, logger: (entry) => console.log(JSON.stringify(entry)) });
    console.log(JSON.stringify({ event: "settlement_complete", ...result }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ event: "settlement_failed", error: error.message, priorResults: error.results?.map((result) => ({ outcome: result.outcome, applied: result.applied })) || [] }, null, 2));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();

import process from "node:process";
import { Contract, Interface, JsonRpcProvider, Wallet, getAddress, hexlify, id, isAddress, randomBytes } from "ethers";
import { ApiError } from "./api-errors.js";
import { productionChainId } from "./config.js";
import { GENESIS_TOKEN_ID_SET, TRANSFER_BATCH_TOPIC, TRANSFER_SINGLE_TOPIC, decodeGenesisTransfers, replayUsedUnits, unitToUse, unusedUnits } from "./genesis-claim-ledger.js";

export const GENESIS_CONTRACT = "0xD1B4367dd9f235f9ee61878019d66E31511E98eE";
export const GENESIS_CHAIN_ID = 43114;
export const GENESIS_TOKEN_IDS = Object.freeze([0n, 1n, 2n, 3n]);
export const LEGACY_FUJI_SINGLETON = "0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6";
// Production schedule. C-Chain (43114) must use exactly these and the production price; only Fuji
// may configure shorter test windows (never below one minute), as the claim contract also enforces.
export const CLAIM_WINDOW_SECONDS = 86_400n;
export const PUBLIC_WINDOW_SECONDS = 7n * 86_400n;
export const MINIMUM_TEST_WINDOW_SECONDS = 60n;
export const MAINNET_PUBLIC_PRICE_WEI = 250_000_000_000_000_000n; // 0.25 AVAX

/**
 * Validates the schedule and price for the destination chain. Mainnet always gets the production
 * 24 hours / 7 days at 0.25 AVAX; anything else fails closed. Fuji windows default to production.
 */
export function claimSchedule({ destinationChainId, claimWindow = CLAIM_WINDOW_SECONDS, publicWindow = PUBLIC_WINDOW_SECONDS, publicPriceWei }) {
  if (destinationChainId === GENESIS_CHAIN_ID) {
    if (claimWindow !== CLAIM_WINDOW_SECONDS || publicWindow !== PUBLIC_WINDOW_SECONDS) throw new GenesisClaimConfigurationError("Mainnet requires a 24-hour Genesis claim window and a 7-day public window.");
    if (publicPriceWei !== MAINNET_PUBLIC_PRICE_WEI) throw new GenesisClaimConfigurationError("Mainnet requires a public price of exactly 0.25 AVAX (250000000000000000 wei).");
  } else if (claimWindow < MINIMUM_TEST_WINDOW_SECONDS || publicWindow < MINIMUM_TEST_WINDOW_SECONDS) {
    throw new GenesisClaimConfigurationError("Claim and public windows must each be at least 60 seconds.");
  }
  return Object.freeze({ claimWindow, publicWindow });
}

/**
 * Eligibility is live ownership minus used units: when a voucher is requested, the wallet must hold, at
 * the current C-Chain block, at least one Genesis unit (IDs 0-3) that no earlier claim used (see
 * genesis-claim-ledger.js). The claim contract's ELIGIBILITY_RULE constant is the hash of this text, and
 * every voucher names it. Genesis tokens are only read, never moved or locked.
 */
export const ELIGIBILITY_RULE_TEXT = "the-void:genesis-eligibility:v3:live-balanceOf(wallet,0..3)-minus-units-used-by-earlier-claims>0;used-units-follow-transfers";
export const ELIGIBILITY_RULE = id(ELIGIBILITY_RULE_TEXT);

const GENESIS_INTERFACE = new Interface(["function balanceOf(address account,uint256 id) view returns (uint256)"]);
const CLAIM_ABI = [
  "function hasClaimed(address) view returns (bool)",
  "function claimedSupply() view returns (uint256)",
  "function allocation() view returns (uint256)",
  "function publicAllocation() view returns (uint256)",
  "function releaseContract() view returns (address)",
  "function primarySale() view returns (address)",
  "function tokenId() view returns (uint256)",
  "function signer() view returns (address)",
  "function destinationChainId() view returns (uint256)",
  "function claimStart() view returns (uint256)",
  "function claimEnd() view returns (uint256)",
  "function claimWindow() view returns (uint256)",
  "function publicWindow() view returns (uint256)",
  "function publicSaleEnd() view returns (uint256)",
  "function publicPriceWei() view returns (uint256)",
  "function GENESIS_CONTRACT() view returns (address)",
  "function GENESIS_CHAIN_ID() view returns (uint256)",
  "function ELIGIBILITY_RULE() view returns (bytes32)",
];
const RELEASE_ABI = [
  "function maxSupplyOf(uint256 tokenId) view returns (uint256)",
  "function ISSUER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role,address account) view returns (bool)",
  "function edition(uint256 tokenId) view returns ((bytes32 releaseId,bytes32 editionId,address artist,uint256 maxSupply,uint256 mintedSupply,string metadataUri,bool exists))",
];
const SALE_ABI = ["function sales(uint256 tokenId) view returns (uint256 priceWei,uint256 maxSupply,uint256 sold,uint256 perWalletLimit,uint64 startTime,uint64 endTime,bool paused,bool configured)"];
const VOUCHER_TYPES = Object.freeze({
  ClaimVoucher: [
    { name: "claimant", type: "address" },
    { name: "genesisContract", type: "address" },
    { name: "genesisChainId", type: "uint256" },
    { name: "eligibilityRule", type: "bytes32" },
    { name: "destinationChainId", type: "uint256" },
    { name: "releaseContract", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "quantity", type: "uint256" },
    { name: "allocation", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
});

export class GenesisClaimConfigurationError extends Error {
  constructor(message) { super(message); this.name = "GenesisClaimConfigurationError"; }
}

function configuredAddress(value, name) {
  const raw = String(value || "").trim();
  if (!isAddress(raw) || getAddress(raw) === "0x0000000000000000000000000000000000000000") {
    throw new GenesisClaimConfigurationError(`${name} must be a non-zero EVM address.`);
  }
  return getAddress(raw);
}

function positiveBigInt(value, name) {
  try {
    const parsed = BigInt(value);
    if (parsed <= 0n) throw new Error();
    return parsed;
  } catch {
    throw new GenesisClaimConfigurationError(`${name} must be a positive integer.`);
  }
}

function nonNegativeBigInt(value, name) {
  try {
    const text = String(value ?? "").trim();
    if (!/^(0|[1-9]\d*)$/.test(text)) throw new Error();
    return BigInt(text);
  } catch {
    throw new GenesisClaimConfigurationError(`${name} must be a non-negative integer.`);
  }
}

function httpUrl(value, name) {
  try {
    const url = new URL(String(value || "").trim());
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash) throw new Error();
    return url.toString();
  } catch {
    throw new GenesisClaimConfigurationError(`${name} must be an absolute HTTP(S) URL without credentials or a fragment.`);
  }
}

export function loadGenesisClaimConfig(env = process.env) {
  if (String(env.GENESIS_CLAIM_ENABLED || "").toLowerCase() !== "true") return null;
  const destinationChainId = productionChainId(env);
  const releaseContract = configuredAddress(env.GENESIS_CLAIM_RELEASE_CONTRACT, "GENESIS_CLAIM_RELEASE_CONTRACT");
  const primarySale = configuredAddress(env.GENESIS_CLAIM_PRIMARY_SALE, "GENESIS_CLAIM_PRIMARY_SALE");
  const claimContract = configuredAddress(env.GENESIS_CLAIM_CONTRACT, "GENESIS_CLAIM_CONTRACT");
  if (releaseContract.toLowerCase() === LEGACY_FUJI_SINGLETON.toLowerCase()) {
    throw new GenesisClaimConfigurationError("The legacy Fuji V2 singleton may not be the claim release target.");
  }
  if (releaseContract.toLowerCase() === claimContract.toLowerCase() || primarySale.toLowerCase() === releaseContract.toLowerCase()) {
    throw new GenesisClaimConfigurationError("The release, primary sale, and claim contract must be distinct addresses.");
  }
  const tokenIdValue = String(env.GENESIS_CLAIM_TOKEN_ID ?? "").trim();
  if (!/^(0|[1-9]\d*)$/.test(tokenIdValue)) throw new GenesisClaimConfigurationError("GENESIS_CLAIM_TOKEN_ID must be a non-negative integer.");
  const tokenId = BigInt(tokenIdValue);
  // 0 means uncapped: an open edition has no reserved claim allocation and no public sale cap.
  const allocation = nonNegativeBigInt(env.GENESIS_CLAIM_ALLOCATION, "GENESIS_CLAIM_ALLOCATION");
  const publicAllocation = nonNegativeBigInt(env.GENESIS_PUBLIC_MINT_ALLOCATION, "GENESIS_PUBLIC_MINT_ALLOCATION");
  const claimStart = positiveBigInt(env.GENESIS_CLAIM_START, "GENESIS_CLAIM_START");
  const publicPriceWei = positiveBigInt(env.GENESIS_PUBLIC_PRICE_WEI, "GENESIS_PUBLIC_PRICE_WEI");
  const { claimWindow, publicWindow } = claimSchedule({
    destinationChainId,
    claimWindow: env.GENESIS_CLAIM_WINDOW_SECONDS === undefined || env.GENESIS_CLAIM_WINDOW_SECONDS === "" ? CLAIM_WINDOW_SECONDS : positiveBigInt(env.GENESIS_CLAIM_WINDOW_SECONDS, "GENESIS_CLAIM_WINDOW_SECONDS"),
    publicWindow: env.GENESIS_PUBLIC_WINDOW_SECONDS === undefined || env.GENESIS_PUBLIC_WINDOW_SECONDS === "" ? PUBLIC_WINDOW_SECONDS : positiveBigInt(env.GENESIS_PUBLIC_WINDOW_SECONDS, "GENESIS_PUBLIC_WINDOW_SECONDS"),
    publicPriceWei,
  });
  const privateKey = String(env.GENESIS_CLAIM_SIGNER_PRIVATE_KEY || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new GenesisClaimConfigurationError("GENESIS_CLAIM_SIGNER_PRIVATE_KEY must be a server-side 32-byte hex secret.");
  return Object.freeze({
    destinationChainId,
    genesisRpcUrl: httpUrl(env.GENESIS_RPC_URL, "GENESIS_RPC_URL"),
    destinationRpcUrl: httpUrl(env.GENESIS_DESTINATION_RPC_URL, "GENESIS_DESTINATION_RPC_URL"),
    releaseContract,
    primarySale,
    claimContract,
    tokenId,
    allocation,
    publicAllocation,
    claimStart,
    claimWindow,
    publicWindow,
    claimEnd: claimStart + claimWindow,
    publicSaleEnd: claimStart + claimWindow + publicWindow - 1n,
    publicPriceWei,
    eligibilityRule: ELIGIBILITY_RULE,
    privateKey,
  });
}

function toPublicConfig(config) {
  if (!config) return null;
  return Object.freeze({
    enabled: true,
    genesisContract: GENESIS_CONTRACT,
    genesisChainId: GENESIS_CHAIN_ID,
    tokenIds: GENESIS_TOKEN_IDS.map(String),
    eligibilityRule: config.eligibilityRule,
    eligibility: "live",
    destinationChainId: config.destinationChainId,
    releaseContract: config.releaseContract,
    primarySale: config.primarySale,
    claimContract: config.claimContract,
    tokenId: config.tokenId.toString(),
    allocation: config.allocation.toString(),
    publicAllocation: config.publicAllocation.toString(),
    claimStart: config.claimStart.toString(),
    claimEnd: config.claimEnd.toString(),
    claimWindow: config.claimWindow.toString(),
    publicWindow: config.publicWindow.toString(),
    publicSaleEnd: config.publicSaleEnd.toString(),
    publicPriceWei: config.publicPriceWei.toString(),
  });
}

export const VOUCHER_LIFETIME_SECONDS = 300;
// Seconds past a voucher's deadline before an unredeemed issuance is released (destination-chain time).
export const RESERVATION_EXPIRY_GRACE_SECONDS = 120n;
// Block span per eth_getLogs request for Genesis transfers (public C-Chain RPC limit).
export const TRANSFER_LOG_CHUNK_BLOCKS = 2048;

export function createGenesisClaimService({
  config = loadGenesisClaimConfig(),
  genesisProvider = null,
  destinationProvider = null,
  signer = null,
  reservationStore = null,
  balanceReader = null,
  transferLogReader = null,
  bindingReader = null,
  claimStateReader = null,
  destinationClock = null,
  clock = () => Math.floor(Date.now() / 1000),
  // 256 random bits. ethers' randomBytes returns a Uint8Array, so it must be hex-encoded explicitly.
  nonce = () => BigInt(hexlify(randomBytes(32))),
} = {}) {
  if (!config) return null;
  // The used-unit ledger is what stops one Genesis unit from qualifying wallet after wallet; without
  // shared, durable storage for it the claim must not run.
  if (!reservationStore) throw new GenesisClaimConfigurationError("The Genesis claim requires the reservation store (migration 039).");
  const sourceProvider = genesisProvider || new JsonRpcProvider(config.genesisRpcUrl);
  const targetProvider = destinationProvider || new JsonRpcProvider(config.destinationRpcUrl);
  const claimSigner = signer || new Wallet(config.privateKey);
  const claim = new Contract(config.claimContract, CLAIM_ABI, targetProvider);
  const release = new Contract(config.releaseContract, RELEASE_ABI, targetProvider);
  const sale = new Contract(config.primarySale, SALE_ABI, targetProvider);

  async function verifyContractBindings() {
    const [network, claimRelease, claimSale, claimToken, claimAllocation, claimPublicAllocation, claimChain, claimStartAt, claimEndAt,
      claimWindowAt, publicWindowAt, claimPublicEnd, claimPrice, claimGenesis, claimGenesisChain, claimRule, claimSignerAddress, claimedSupply, maxSupply, editionData, saleData] = await Promise.all([
      targetProvider.getNetwork(), claim.releaseContract(), claim.primarySale(), claim.tokenId(), claim.allocation(),
      claim.publicAllocation(), claim.destinationChainId(), claim.claimStart(), claim.claimEnd(), claim.claimWindow(), claim.publicWindow(),
      claim.publicSaleEnd(), claim.publicPriceWei(),
      claim.GENESIS_CONTRACT(), claim.GENESIS_CHAIN_ID(), claim.ELIGIBILITY_RULE(), claim.signer(), claim.claimedSupply(),
      release.maxSupplyOf(config.tokenId), release.edition(config.tokenId), sale.sales(config.tokenId),
    ]);
    // The claim mints through the release's issuer path; without the grant every claim would revert.
    const claimIsIssuer = await release.hasRole(await release.ISSUER_ROLE(), config.claimContract);
    const total = config.allocation + config.publicAllocation;
    // An open edition (maxSupply 0) has no cap to compare against.
    const editionCapTooSmall = BigInt(maxSupply) !== 0n && (config.allocation === 0n || BigInt(maxSupply) < total);
    if (Number(network.chainId) !== config.destinationChainId
      || getAddress(claimRelease) !== config.releaseContract
      || getAddress(claimSale) !== config.primarySale
      || BigInt(claimToken) !== config.tokenId
      || BigInt(claimAllocation) !== config.allocation
      || BigInt(claimPublicAllocation) !== config.publicAllocation
      || BigInt(claimChain) !== BigInt(config.destinationChainId)
      || BigInt(claimStartAt) !== config.claimStart
      || BigInt(claimEndAt) !== config.claimEnd
      || BigInt(claimWindowAt) !== config.claimWindow
      || BigInt(publicWindowAt) !== config.publicWindow
      || BigInt(claimPublicEnd) !== config.publicSaleEnd
      || BigInt(claimPrice) !== config.publicPriceWei
      || getAddress(claimGenesis) !== GENESIS_CONTRACT
      || BigInt(claimGenesisChain) !== BigInt(GENESIS_CHAIN_ID)
      || String(claimRule).toLowerCase() !== config.eligibilityRule.toLowerCase()
      || getAddress(claimSignerAddress) !== getAddress(claimSigner.address)
      || editionCapTooSmall
      || !claimIsIssuer
      || BigInt(editionData.mintedSupply ?? editionData[0]?.mintedSupply ?? editionData[0]?.[4] ?? editionData[4]) !== BigInt(saleData.sold ?? saleData[2]) + BigInt(claimedSupply)
      || BigInt(saleData.priceWei ?? saleData[0]) !== config.publicPriceWei
      || BigInt(saleData.maxSupply ?? saleData[1]) !== config.publicAllocation
      || BigInt(saleData.startTime ?? saleData[4]) !== config.claimEnd
      || BigInt(saleData.endTime ?? saleData[5]) !== config.publicSaleEnd
      || !(saleData.configured ?? saleData[7])) {
      throw new ApiError(503, "CLAIM_BINDING_MISMATCH", "The configured claim contract, release, supply, or chain does not match the authorized target.");
    }
  }

  // Ownership is read from C-Chain only. A provider on any other chain fails closed.
  async function assertGenesisChain() {
    const network = await sourceProvider.getNetwork();
    if (Number(network.chainId) !== GENESIS_CHAIN_ID) throw new Error("Genesis RPC is not Avalanche C-Chain (43114).");
  }

  async function readHead() {
    await assertGenesisChain();
    const head = Number(await sourceProvider.getBlockNumber());
    if (!Number.isSafeInteger(head) || head <= 0) throw new Error("Invalid C-Chain block number.");
    return head;
  }

  /** Balances of Genesis IDs 0-3 at one C-Chain block, as decimal strings keyed by ID. */
  async function readBalances(wallet, block) {
    const raw = balanceReader
      ? await balanceReader(wallet, block)
      : Object.fromEntries(await Promise.all(GENESIS_TOKEN_IDS.map(async (tokenId) => {
        const data = GENESIS_INTERFACE.encodeFunctionData("balanceOf", [wallet, tokenId]);
        return [tokenId.toString(), GENESIS_INTERFACE.decodeFunctionResult("balanceOf", await sourceProvider.call({ to: GENESIS_CONTRACT, data, blockTag: block }))[0]];
      })));
    return Object.freeze(Object.fromEntries(GENESIS_TOKEN_ID_SET.map((id) => {
      const value = BigInt(raw?.[id] ?? 0);
      if (value < 0n) throw new Error("Negative Genesis balance.");
      return [id, value.toString()];
    })));
  }

  // Genesis TransferSingle/TransferBatch logs, cached by contiguous block range. Avalanche blocks are
  // final, so a fetched range never changes.
  let logCache = { from: 0, to: -1, logs: [] };
  async function fetchLogs(fromBlock, toBlock) {
    if (transferLogReader) return transferLogReader(fromBlock, toBlock);
    const logs = [];
    for (let start = fromBlock; start <= toBlock; start += TRANSFER_LOG_CHUNK_BLOCKS) {
      const end = Math.min(toBlock, start + TRANSFER_LOG_CHUNK_BLOCKS - 1);
      logs.push(...await sourceProvider.getLogs({ address: GENESIS_CONTRACT, topics: [[TRANSFER_SINGLE_TOPIC, TRANSFER_BATCH_TOPIC]], fromBlock: start, toBlock: end }));
    }
    return logs;
  }
  async function transfersBetween(fromBlock, toBlock) {
    if (toBlock < fromBlock) return [];
    if (logCache.to < logCache.from || fromBlock < logCache.from || fromBlock > logCache.to + 1) {
      logCache = { from: fromBlock, to: toBlock, logs: await fetchLogs(fromBlock, toBlock) };
    } else if (toBlock > logCache.to) {
      logCache = { from: logCache.from, to: toBlock, logs: [...logCache.logs, ...await fetchLogs(logCache.to + 1, toBlock)] };
    }
    return decodeGenesisTransfers(logCache.logs).filter((transfer) => transfer.block >= fromBlock && transfer.block <= toBlock);
  }

  async function readClaimState(wallet) {
    return claimStateReader
      ? claimStateReader(wallet)
      : Promise.all([claim.hasClaimed(wallet), claim.claimedSupply()]).then(([alreadyClaimed, claimedSupply]) => ({ alreadyClaimed, claimedSupply }));
  }

  async function destinationNow() {
    if (destinationClock) return BigInt(await destinationClock());
    const block = await targetProvider.getBlock("latest");
    return BigInt(block.timestamp);
  }

  /**
   * Issuances that still use Genesis units: REDEEMED ones, and PENDING ones whose voucher can still be
   * redeemed. A PENDING issuance past its deadline (plus grace) on the destination chain is settled
   * from hasClaimed: REDEEMED, or EXPIRED and released. `tx` persists settlements when present.
   */
  async function activeReservations(records, tx = null) {
    const pendingExpired = records.filter((record) => record.status === "PENDING");
    const now = pendingExpired.length ? await destinationNow() : 0n;
    const active = [];
    for (const record of records) {
      if (record.status === "EXPIRED") continue;
      if (record.status === "REDEEMED" || BigInt(record.deadline) + RESERVATION_EXPIRY_GRACE_SECONDS >= now) {
        active.push(record);
        continue;
      }
      const { alreadyClaimed } = await readClaimState(record.wallet);
      const status = alreadyClaimed ? "REDEEMED" : "EXPIRED";
      if (tx) await tx.setStatus(record.wallet, status);
      if (alreadyClaimed) active.push({ ...record, status });
    }
    return active;
  }

  /** The wallet's balances and unused units at the current C-Chain head, given the active issuances. */
  async function ledgerPosition(wallet, active) {
    const head = await readHead();
    const latestIssued = active.reduce((max, record) => Math.max(max, Number(record.block)), 0);
    if (latestIssued > head) throw new Error("C-Chain provider is behind the claim ledger.");
    const earliestIssued = active.reduce((min, record) => Math.min(min, Number(record.block)), Infinity);
    const transfers = Number.isFinite(earliestIssued) ? await transfersBetween(earliestIssued + 1, head) : [];
    const used = replayUsedUnits({ reservations: active, transfers, throughBlock: head });
    const balances = await readBalances(wallet, head);
    return { head, balances, unused: unusedUnits(wallet, balances, used) };
  }

  const heldIds = (units) => GENESIS_TOKEN_ID_SET.filter((id) => BigInt(units[id]) > 0n);

  function assertWallet(wallet) {
    if (!isAddress(wallet) || getAddress(wallet) === "0x0000000000000000000000000000000000000000") {
      throw new ApiError(400, "INVALID_WALLET", "A non-zero claimant wallet address is required.");
    }
    return getAddress(wallet);
  }

  async function checkEligibility(walletInput) {
    const wallet = assertWallet(walletInput);
    try {
      return await reservationStore.withLock(config.claimContract, async (tx) => {
        const records = await tx.list();
        const active = await activeReservations(records);
        const own = active.find((record) => getAddress(record.wallet) === wallet);
        if (own) return Object.freeze({ eligible: own.status === "PENDING", eligibleTokenIds: heldIds(own.balances), holdingUsed: false, claimIssued: true });
        const { balances, unused } = await ledgerPosition(wallet, active);
        const eligibleTokenIds = heldIds(unused);
        return Object.freeze({ eligible: eligibleTokenIds.length > 0, eligibleTokenIds, holdingUsed: heldIds(balances).length > 0 && eligibleTokenIds.length === 0, claimIssued: false });
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, "ELIGIBILITY_UNAVAILABLE", "Genesis ownership could not be verified on Avalanche C-Chain.");
    }
  }

  async function issueVoucher(walletInput) {
    const wallet = assertWallet(walletInput);
    const now = BigInt(clock());
    if (now < config.claimStart) throw new ApiError(409, "CLAIM_NOT_OPEN", "The Genesis claim window has not opened yet.");
    if (now >= config.claimEnd) throw new ApiError(409, "CLAIM_WINDOW_CLOSED", "The Genesis claim window has closed.");
    try {
      if (bindingReader) await bindingReader();
      else await verifyContractBindings();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, "CLAIM_AUTHORIZATION_UNAVAILABLE", "Claim authorization could not be issued for the configured destination.");
    }
    // One issuance at a time per claim contract: the holding a wallet is judged on cannot be judged for
    // another wallet until this issuance is recorded.
    return reservationStore.withLock(config.claimContract, async (tx) => {
      let active;
      let position;
      let claimState;
      try {
        const records = await tx.list();
        active = await activeReservations(records, tx);
        claimState = await readClaimState(wallet);
        const own = active.find((record) => getAddress(record.wallet) === wallet);
        if (claimState.alreadyClaimed || own?.status === "REDEEMED") throw new ApiError(409, "ALREADY_CLAIMED", "This wallet has already claimed its Genesis allocation.");
        // A wallet that already holds an unexpired voucher gets the same voucher back: same nonce, so it
        // can be redeemed at most once.
        if (own) return Object.freeze({ voucher: own.voucher, signature: own.signature, target: toPublicConfig(config) });
        position = await ledgerPosition(wallet, active);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(503, "ELIGIBILITY_UNAVAILABLE", "Genesis ownership could not be verified on Avalanche C-Chain.");
      }
      if (!heldIds(position.balances).length) throw new ApiError(403, "ACCESS_DENIED", "This wallet does not currently hold Genesis token 0, 1, 2, or 3 on Avalanche C-Chain.");
      const usedTokenId = unitToUse(position.unused);
      if (usedTokenId === null) throw new ApiError(403, "GENESIS_HOLDING_ALREADY_USED", "Every Genesis unit in this wallet was already used for a free claim by a previous holder.");
      if (config.allocation !== 0n && BigInt(claimState.claimedSupply) >= config.allocation) throw new ApiError(409, "CLAIM_ALLOCATION_EXHAUSTED", "The reserved Genesis claim allocation has been exhausted.");
      try {
        const voucher = Object.freeze({
          claimant: wallet,
          genesisContract: GENESIS_CONTRACT,
          genesisChainId: GENESIS_CHAIN_ID,
          eligibilityRule: config.eligibilityRule,
          destinationChainId: config.destinationChainId,
          releaseContract: config.releaseContract,
          tokenId: config.tokenId.toString(),
          quantity: "1",
          allocation: config.allocation.toString(),
          nonce: nonce().toString(),
          // Short-lived, and never past the claim window.
          deadline: String(BigInt(Math.min(clock() + VOUCHER_LIFETIME_SECONDS, Number(config.claimEnd) - 1))),
        });
        const domain = {
          name: "The Void Genesis Holder Claim",
          version: "1",
          chainId: config.destinationChainId,
          verifyingContract: config.claimContract,
        };
        const signature = await claimSigner.signTypedData(domain, VOUCHER_TYPES, voucher);
        // Off-chain accounting only: one unused Genesis unit (lowest ID) counts as used by this claim. No
        // Genesis token is moved, burned, locked or approved; the wallet's other units stay unused.
        await tx.upsert({ claimContract: config.claimContract, wallet, block: position.head, usedTokenId, balances: position.balances, deadline: BigInt(voucher.deadline), status: "PENDING", voucher, signature });
        return Object.freeze({ voucher, signature, target: toPublicConfig(config) });
      } catch {
        throw new ApiError(503, "CLAIM_AUTHORIZATION_UNAVAILABLE", "Claim authorization could not be issued for the configured destination.");
      }
    });
  }

  return Object.freeze({
    config: toPublicConfig(config),
    checkEligibility,
    issueVoucher,
    verifyContractBindings,
  });
}

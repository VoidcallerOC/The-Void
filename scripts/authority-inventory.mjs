// Read-only authority inventory for a platform key on Fuji and Avalanche C-Chain.
// For every candidate contract it reads role membership and ownership directly
// (hasRole / owner), reconstructs every role holder from RoleGranted/RoleRevoked
// logs, and checks edition-level artist/payout bindings and pending sale balances.
// No signing, no broadcast. Output is JSON on stdout.
//
//   SUBJECT=0x... [NEW_AUTHORITY=0x...] node scripts/authority-inventory.mjs
//
// NEW_AUTHORITY is optional; when set, the same reads report whether the
// replacement already holds each authority (post-rotation verification).
import { Interface, JsonRpcProvider, getAddress, id } from "ethers";

const SUBJECT = getAddress(process.env.SUBJECT || "0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174");
const NEW_AUTHORITY = process.env.NEW_AUTHORITY ? getAddress(process.env.NEW_AUTHORITY) : null;
const FUJI_RPC = process.env.FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc";
const MAINNET_RPC = process.env.MAINNET_RPC_URL || "https://api.avax.network/ext/bc/C/rpc";
const LOG_CHUNK = Number(process.env.LOG_CHUNK || 2048);

const ROLES = {
  DEFAULT_ADMIN_ROLE: `0x${"00".repeat(32)}`,
  ARTIST_ROLE: id("ARTIST_ROLE"),
  ISSUER_ROLE: id("ISSUER_ROLE"),
  MINTER_ROLE: id("MINTER_ROLE"),
  PAUSER_ROLE: id("PAUSER_ROLE"),
  URI_SETTER_ROLE: id("URI_SETTER_ROLE"),
};
const roleName = Object.fromEntries(Object.entries(ROLES).map(([name, hash]) => [hash, name]));

// Every contract the reconciliation found the subject created or may control.
const FUJI_CONTRACTS = [
  { address: "0x262B774cf9a1949170B58E2d57F6189980FE757b", kind: "release", label: "VoidRelease1155 V1 (legacy certified)", fromBlock: 58428586 },
  { address: "0x7A78F13Bef1a984676787Df1878F0C378b9dFc6e", kind: "release", label: "Release (2026-09-26, superseded)", fromBlock: 58751656 },
  { address: "0x7D1a068F532aD6c0f591d4Fb9F82fd5b97495363", kind: "sale", label: "Primary sale for 0x7A78", fromBlock: 58751660 },
  { address: "0x82b26Da27136935454Bdf1e40801190B521b82e5", kind: "release", label: "Release (2026-09-26, legacy marketplace token)", fromBlock: 58761820 },
  { address: "0xcc26cd6D6dc25654652D1FBB64dB5F61E20F60F1", kind: "sale", label: "Primary sale for 0x82b26", fromBlock: 58761822 },
  { address: "0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6", kind: "release", label: "SHARED RELEASE V2 (live; all published Fuji editions)", fromBlock: 59015108 },
  { address: "0x51cCD2d5Cd71368917f1EFe3fa43Fab8068E1aBA", kind: "sale", label: "SHARED PRIMARY SALE (live)", fromBlock: 59015114 },
  { address: "0x8291A4F1936C1c5C6D8917b0966c80757cd5c265", kind: "factory", label: "VoidReleaseFactory V1 (unused)", fromBlock: 59050635 },
  { address: "0xa5CbA0F91cb0A81e0A9Ce89A6722Cbe4eeC93505", kind: "factory", label: "VoidReleaseFactoryV2 (canonical; ownerless by design)", fromBlock: 59082607 },
  { address: "0x1AaF66f0aBA020321e63d684186886A3178A9BfC", kind: "release", label: "FactoryV2 clone #0", fromBlock: 59083459 },
  { address: "0x12FfEbdD18D42Ea24c2CdD99C08Bd78c6F5c0Fe6", kind: "release", label: "FactoryV2 clone #1", fromBlock: 59098991 },
  { address: "0x1cBcde64E29473Ed4D40185c2e5a7745b338b996", kind: "sale", label: "FactoryV2 clone #0 sale", fromBlock: 59083459 },
  { address: "0x3671E19307Eec5F7F2882C790A12cfE242245aFD", kind: "sale", label: "FactoryV2 clone #1 sale", fromBlock: 59098991 },
];
const MAINNET_CONTRACTS = [
  { address: "0xd1b4367dd9f235f9ee61878019d66e31511e98ee", kind: "release", label: "C-Chain Voidcaller collection (out of scope; checked for exposure only)" },
  { address: "0x2e61967a569bc18affc5e1b9f71e00af93a268c7", kind: "release", label: "C-Chain collection implementation" },
];

const iface = new Interface([
  "function hasRole(bytes32,address) view returns (bool)",
  "function owner() view returns (address)",
  "function paused() view returns (bool)",
  "function platformFeeBps() view returns (uint256)",
  "function platformFeeCapBps() view returns (uint256)",
  "function platformRecipient() view returns (address)",
  "function balances(address) view returns (uint256)",
  "function artistOf(uint256) view returns (address)",
  "function payoutOf(uint256) view returns (address)",
  "function releases() view returns (address)",
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
  "event EditionCreated(uint256 indexed tokenId, bytes32 indexed releaseId, bytes32 indexed editionId, address artist, uint256 maxSupply, string metadataUri)",
]);
const TOPICS = {
  RoleGranted: iface.getEvent("RoleGranted").topicHash,
  RoleRevoked: iface.getEvent("RoleRevoked").topicHash,
  OwnershipTransferred: iface.getEvent("OwnershipTransferred").topicHash,
  EditionCreated: iface.getEvent("EditionCreated").topicHash,
};

async function call(provider, to, name, args = []) {
  try { return iface.decodeFunctionResult(name, await provider.call({ to, data: iface.encodeFunctionData(name, args) }))[0]; } catch { return undefined; }
}

async function logs(provider, address, fromBlock, toBlock, topics) {
  const out = [];
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK) {
    const end = Math.min(start + LOG_CHUNK - 1, toBlock);
    for (let attempt = 0; ; attempt += 1) {
      try { out.push(...await provider.getLogs({ address, fromBlock: start, toBlock: end, topics: [topics] })); break; } catch (error) { if (attempt >= 3) throw error; }
    }
  }
  return out;
}

const str = (v) => (typeof v === "bigint" ? v.toString() : v);

async function inspect(provider, contract, tip, withLogs) {
  const address = getAddress(contract.address);
  const code = await provider.getCode(address);
  const entry = { address, label: contract.label, kind: contract.kind, codePresent: code !== "0x", subject: {}, newAuthority: NEW_AUTHORITY ? {} : undefined };
  if (code === "0x") return entry;
  for (const [name, hash] of Object.entries(ROLES)) {
    const held = await call(provider, address, "hasRole", [hash, SUBJECT]);
    if (held !== undefined) entry.subject[name] = held;
    if (NEW_AUTHORITY) { const n = await call(provider, address, "hasRole", [hash, NEW_AUTHORITY]); if (n !== undefined) entry.newAuthority[name] = n; }
  }
  const owner = await call(provider, address, "owner");
  if (owner !== undefined) { entry.owner = owner; entry.subject.isOwner = owner === SUBJECT; if (NEW_AUTHORITY) entry.newAuthority.isOwner = owner === NEW_AUTHORITY; }
  for (const name of ["paused", "platformFeeBps", "platformFeeCapBps", "platformRecipient", "releases"]) {
    const value = await call(provider, address, name);
    if (value !== undefined) entry[name] = str(value);
  }
  if (contract.kind === "sale") {
    const pending = await call(provider, address, "balances", [SUBJECT]);
    if (pending !== undefined) entry.subject.pendingWithdrawalWei = str(pending);
  }
  if (withLogs && contract.fromBlock) {
    const roleLogs = await logs(provider, address, contract.fromBlock, tip, [TOPICS.RoleGranted, TOPICS.RoleRevoked]);
    const holders = {};
    for (const log of roleLogs) {
      const parsed = iface.parseLog(log);
      const role = roleName[parsed.args.role] || parsed.args.role;
      holders[role] ||= {};
      holders[role][getAddress(parsed.args.account)] = parsed.name === "RoleGranted";
    }
    entry.roleHoldersFromLogs = Object.fromEntries(Object.entries(holders).map(([role, accounts]) => [role, Object.entries(accounts).filter(([, on]) => on).map(([a]) => a)]));
    entry.roleEventCount = roleLogs.length;
    const ownerLogs = await logs(provider, address, contract.fromBlock, tip, [TOPICS.OwnershipTransferred]);
    if (ownerLogs.length) entry.ownershipHistory = ownerLogs.map((l) => { const p = iface.parseLog(l); return { from: p.args.previousOwner, to: p.args.newOwner, block: l.blockNumber, tx: l.transactionHash }; });
    if (contract.kind === "release") {
      const editionLogs = await logs(provider, address, contract.fromBlock, tip, [TOPICS.EditionCreated]);
      entry.editions = [];
      for (const log of editionLogs) {
        const tokenId = BigInt(log.topics[1]);
        const artist = await call(provider, address, "artistOf", [tokenId]);
        const payout = await call(provider, address, "payoutOf", [tokenId]);
        entry.editions.push({ tokenId: tokenId.toString(), artist, payout, subjectIsArtist: artist === SUBJECT, subjectIsPayout: payout === SUBJECT, block: log.blockNumber });
      }
    }
  }
  return entry;
}

const fuji = new JsonRpcProvider(FUJI_RPC, 43113, { staticNetwork: true });
const mainnet = new JsonRpcProvider(MAINNET_RPC, 43114, { staticNetwork: true });
const fujiTip = await fuji.getBlockNumber();
const result = {
  probedAt: new Date().toISOString(),
  subject: SUBJECT,
  newAuthority: NEW_AUTHORITY,
  topicsUsed: TOPICS,
  accounts: {
    fuji: { nonce: await fuji.getTransactionCount(SUBJECT, "latest"), balanceWei: str(await fuji.getBalance(SUBJECT)), tipBlock: fujiTip },
    mainnet: await (async () => { try { return { nonce: await mainnet.getTransactionCount(SUBJECT, "latest"), balanceWei: str(await mainnet.getBalance(SUBJECT)), tipBlock: await mainnet.getBlockNumber() }; } catch (error) { return { error: error.message }; } })(),
  },
  fuji: [],
  mainnet: [],
};
for (const contract of FUJI_CONTRACTS) result.fuji.push(await inspect(fuji, contract, fujiTip, true));
for (const contract of MAINNET_CONTRACTS) {
  try { result.mainnet.push(await inspect(mainnet, contract, 0, false)); } catch (error) { result.mainnet.push({ address: contract.address, error: error.message }); }
}
// Canonical Safe v1.4.1 deployments (safe-global/safe-deployments; same address on
// every chain they are deployed to). Code presence is evidence only that the contracts
// exist on Fuji, not that a Safe UI or transaction service supports the chain.
const SAFE_CANONICAL = {
  SafeProxyFactory_v1_4_1: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
  Safe_v1_4_1: "0x41675C099F32341bf84BFc5382aF534df5C7461a",
  SafeL2_v1_4_1: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
};
result.safeInfrastructureOnFuji = {};
for (const [name, address] of Object.entries(SAFE_CANONICAL)) result.safeInfrastructureOnFuji[name] = { address, codePresent: (await fuji.getCode(address)) !== "0x" };

result.summary = {
  fujiAuthorityHeld: result.fuji.flatMap((c) => Object.entries(c.subject || {}).filter(([k, v]) => v === true && k !== "pendingWithdrawalWei").map(([k]) => `${c.address}:${k}`)),
  fujiEditionBindings: result.fuji.flatMap((c) => (c.editions || []).filter((e) => e.subjectIsArtist || e.subjectIsPayout).map((e) => `${c.address}:${e.tokenId}:${e.subjectIsArtist ? "artist" : ""}${e.subjectIsPayout ? "+payout" : ""}`)),
  mainnetAuthorityHeld: result.mainnet.flatMap((c) => Object.entries(c.subject || {}).filter(([, v]) => v === true).map(([k]) => `${c.address}:${k}`)),
};
console.log(JSON.stringify(result, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));

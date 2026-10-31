// Read-only generator for the GenesisWeekendClaim owner-signing manifest.
//
//   node scripts/genesis-weekend-manifest.mjs [--out deploy/mainnet/genesis-weekend/signing/manifest.json]
//
// It binds the reviewed artifact and snapshot into the exact transactions the owner signs, re-reads live
// ISSUER_ROLE holders from two independent sources, and simulates every transaction from the artist wallet
// against current C-Chain state. It sends nothing and refuses to write a manifest if any check fails.
import fs from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { AbiCoder, Contract, Interface, JsonRpcProvider, getAddress, getCreateAddress, id, keccak256, toUtf8Bytes } from "ethers";
import { loadWeekendSnapshot } from "../server/genesis-weekend-claim.js";

export const CHAIN_ID = 43114;
export const RPC = process.env.CCHAIN_RPC_URL || "https://api.avax.network/ext/bc/C/rpc";
export const ARTIST = "0x284C09a7CC187E096cbbdc88d99DEFE6df32180a";
export const RELEASE = "0xF0C091A159DE16cF0F306b2B61d37685EC5A830e";
export const SALE = "0xB4dAAe78a53c33f52C6EB573c4d6EFC7B86F3845";
export const FACTORY = "0xEa0c345cE84025b4e8462d145100dce1848254B4";
export const PRIOR_CLAIMS = ["0x8512be04a4E54cd8551738165F9c05C3303187a0", "0x7D1a068F532aD6c0f591d4Fb9F82fd5b97495363", "0xd70dBA7fF6419481d62D4689bDf271ad441766b8"];
// The two expired claims that still hold ISSUER_ROLE and are reviewed for revocation.
export const REVOKE_TARGETS = ["0x7D1a068F532aD6c0f591d4Fb9F82fd5b97495363", "0xd70dBA7fF6419481d62D4689bDf271ad441766b8"];
export const CLAIM_END = 1_793_595_599n;
export const BASELINE = 4n;
export const GAS_CEILINGS = Object.freeze({ deploy: 2_000_000n, revoke: 60_000n, grant: 80_000n, activate: 90_000n });
const EXPLORER = "https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api";
const GLACIER = "https://glacier-api.avax.network/v1/chains/43114/addresses";
const ROLE_ABI = [
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",
  "function grantRole(bytes32 role, address account)",
  "function revokeRole(bytes32 role, address account)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function ISSUER_ROLE() view returns (bytes32)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function edition(uint256 tokenId) view returns ((bytes32 releaseId,bytes32 editionId,address artist,uint256 maxSupply,uint256 mintedSupply,string metadataUri,bool exists))",
];
const roleIface = new Interface(ROLE_ABI);

export function constructorConfig(snapshot) {
  return {
    releaseContract: RELEASE, primarySale: SALE, tokenId: 1n, merkleRoot: snapshot.merkleRoot, eligibleWallets: BigInt(snapshot.eligibleWallets),
    snapshotCChainBlock: BigInt(snapshot.cchain.block), snapshotGrottoBlock: BigInt(snapshot.grotto.block), snapshotHash: snapshot.snapshotHash,
    claimEnd: CLAIM_END, baselineClaimedSupply: BASELINE, admin: ARTIST, priorClaims: PRIOR_CLAIMS,
  };
}

/** The exact contract-creation data: the reviewed bytecode followed by the ABI-encoded constructor config. */
export function deploymentData(artifact, config) {
  const iface = new Interface(artifact.abi);
  const args = iface.deploy ? AbiCoder.defaultAbiCoder().encode(iface.deploy.inputs, [config]) : null;
  if (!args) throw new Error("The artifact has no constructor.");
  return `${artifact.bytecode}${args.slice(2)}`;
}

/** ISSUER_ROLE / DEFAULT_ADMIN_ROLE candidates from two independent sources, confirmed live with hasRole. */
export async function liveRoleHolders({ provider, fetchImpl = fetch, extra = [] }) {
  const release = new Contract(RELEASE, ROLE_ABI, provider);
  const [issuer, admin] = await Promise.all([release.ISSUER_ROLE(), release.DEFAULT_ADMIN_ROLE()]);
  const candidates = new Set([ARTIST, SALE, FACTORY, ...PRIOR_CLAIMS, ...extra].map(getAddress));
  const events = [];
  const explorer = await (await fetchImpl(`${EXPLORER}?module=logs&action=getLogs&address=${RELEASE}&fromBlock=0&toBlock=latest&page=1&offset=1000`)).json();
  for (const log of Array.isArray(explorer.result) ? explorer.result : []) {
    let parsed;
    // Routescan reports empty event data as "" rather than "0x".
    try { parsed = roleIface.parseLog({ topics: log.topics, data: log.data || "0x" }); } catch { continue; }
    if (!parsed) continue;
    candidates.add(getAddress(parsed.args.account));
    events.push({ source: "routescan", event: parsed.name, role: parsed.args.role, account: getAddress(parsed.args.account), transactionHash: log.transactionHash, block: Number.parseInt(log.blockNumber, 16) });
  }
  const glacier = await (await fetchImpl(`${GLACIER}/${RELEASE}/transactions?pageSize=100`)).json();
  for (const entry of glacier.transactions || []) {
    const tx = entry.nativeTransaction;
    if (getAddress(tx.to.address) !== getAddress(RELEASE)) continue;
    const selector = tx.method?.methodHash;
    if (selector !== roleIface.getFunction("grantRole").selector && selector !== roleIface.getFunction("revokeRole").selector) continue;
    const full = await provider.getTransaction(tx.txHash);
    const decoded = roleIface.parseTransaction({ data: full.data });
    candidates.add(getAddress(decoded.args.account));
    events.push({ source: "glacier+node", event: decoded.name, role: decoded.args.role, account: getAddress(decoded.args.account), transactionHash: tx.txHash, block: Number(tx.blockNumber) });
  }
  const holders = [];
  for (const account of candidates) {
    const [isIssuer, isAdmin] = await Promise.all([release.hasRole(issuer, account), release.hasRole(admin, account)]);
    if (isIssuer || isAdmin) holders.push({ account, issuer: isIssuer, defaultAdmin: isAdmin });
  }
  return { issuerRole: issuer, defaultAdminRole: admin, candidatesChecked: candidates.size, holders, events: events.sort((a, b) => a.block - b.block) };
}

export async function generateManifest({ provider = new JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true }), artifactPath = "deploy/mainnet/genesis-weekend/GenesisWeekendClaim.artifact.json", snapshotPath = "deploy/mainnet/genesis-weekend/snapshot.json", fetchImpl = fetch } = {}) {
  const failures = [];
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const source = fs.readFileSync(artifact.sourcePath, "utf8");
  if (keccak256(toUtf8Bytes(source)) !== artifact.sourceKeccak256) failures.push("The artifact was not built from the contract source in this checkout.");
  if (keccak256(artifact.bytecode) !== artifact.bytecodeKeccak256) failures.push("The artifact bytecode hash does not match its bytecode.");
  const { snapshot } = loadWeekendSnapshot(fs.readFileSync(snapshotPath, "utf8"));

  const network = await provider.getNetwork();
  if (Number(network.chainId) !== CHAIN_ID) failures.push(`RPC is chain ${network.chainId}, not ${CHAIN_ID}.`);
  const block = await provider.getBlock("latest");
  const config = constructorConfig(snapshot);
  const data = deploymentData(artifact, config);
  const pendingNonce = await provider.getTransactionCount(ARTIST, "pending");
  const latestNonce = await provider.getTransactionCount(ARTIST, "latest");
  if (pendingNonce !== latestNonce) failures.push(`The artist wallet has ${pendingNonce - latestNonce} pending transaction(s).`);
  const predicted = getCreateAddress({ from: ARTIST, nonce: pendingNonce });

  // Live preconditions the constructor and the claim rely on.
  const release = new Contract(RELEASE, ROLE_ABI, provider);
  const sale = new Contract(SALE, ["function sales(uint256) view returns (uint256,uint256,uint256,uint256,uint64,uint64,bool,bool)"], provider);
  const recovery = new Contract(PRIOR_CLAIMS[2], ["function claimedSupply() view returns (uint256)"], provider);
  const [edition, saleState, historical] = await Promise.all([release.edition(1), sale.sales(1), recovery.claimedSupply()]);
  if (historical !== BASELINE) failures.push(`Historical claimed supply is ${historical}, not ${BASELINE}.`);
  if (edition.mintedSupply !== saleState[2] + historical) failures.push(`Supply invariant broken: minted ${edition.mintedSupply} != sold ${saleState[2]} + claimed ${historical}.`);
  if (BigInt(block.timestamp) >= CLAIM_END) failures.push("The weekend close has already passed.");
  for (const address of PRIOR_CLAIMS) {
    const end = await new Contract(address, ["function claimEnd() view returns (uint256)"], provider).claimEnd();
    if (BigInt(block.timestamp) < end) failures.push(`Prior claim ${address} is still open (claimEnd ${end}).`);
  }

  const roles = await liveRoleHolders({ provider, fetchImpl, extra: [predicted] });
  const issuers = roles.holders.filter(({ issuer }) => issuer).map(({ account }) => account);
  for (const target of REVOKE_TARGETS) if (!issuers.includes(getAddress(target))) failures.push(`Revoke target ${target} no longer holds ISSUER_ROLE.`);
  const unexpected = issuers.filter((account) => ![getAddress(SALE), ...REVOKE_TARGETS.map(getAddress)].includes(account));
  if (unexpected.length) failures.push(`Unreviewed ISSUER_ROLE holder(s): ${unexpected.join(", ")}.`);
  if (issuers.includes(getAddress(predicted))) failures.push("The predicted claim address already holds ISSUER_ROLE.");

  // Simulations from the artist wallet against current state.
  const simulate = async (name, tx, ceiling) => {
    try {
      const gas = await provider.estimateGas({ from: ARTIST, value: 0n, ...tx });
      if (gas > ceiling) failures.push(`${name}: estimate ${gas} exceeds ceiling ${ceiling}.`);
      return gas.toString();
    } catch (error) {
      failures.push(`${name}: simulation reverted (${error.shortMessage || error.message}).`);
      return null;
    }
  };
  const revokes = REVOKE_TARGETS.map((target) => ({ target: getAddress(target), data: roleIface.encodeFunctionData("revokeRole", [roles.issuerRole, target]) }));
  const deployGas = await simulate("deploy", { data }, GAS_CEILINGS.deploy);
  for (const revoke of revokes) revoke.simulatedGas = await simulate(`revoke ${revoke.target}`, { to: RELEASE, data: revoke.data }, GAS_CEILINGS.revoke);
  const grantData = roleIface.encodeFunctionData("grantRole", [roles.issuerRole, predicted]);
  const grantGas = await simulate("grant", { to: RELEASE, data: grantData }, GAS_CEILINGS.grant);

  // Funding: Rabby reserves gas limit x max fee up front, so cover every ceiling at twice the current base fee.
  const maxFeePerGas = (block.baseFeePerGas ?? 25_000_000_000n) * 2n + 1_000_000_000n;
  const ceilings = [GAS_CEILINGS.deploy, ...REVOKE_TARGETS.map(() => GAS_CEILINGS.revoke), GAS_CEILINGS.grant, GAS_CEILINGS.activate];
  const requiredWei = ceilings.reduce((total, gas) => total + gas * maxFeePerGas, 0n);
  const balanceWei = await provider.getBalance(ARTIST);
  const funding = {
    balanceWei: balanceWei.toString(), requiredWei: requiredWei.toString(), maxFeePerGasAssumed: maxFeePerGas.toString(),
    sufficient: balanceWei >= requiredWei, shortfallWei: (balanceWei >= requiredWei ? 0n : requiredWei - balanceWei).toString(),
  };

  return {
    format: "the-void:genesis-weekend-signing-manifest:v1",
    generatedAt: new Date(block.timestamp * 1000).toISOString(),
    chainId: CHAIN_ID, atBlock: block.number, baseFeeWei: block.baseFeePerGas?.toString() ?? null,
    ok: failures.length === 0, failures,
    signer: ARTIST,
    funding,
    artifact: { sourceCommit: artifact.sourceCommit, sourcePath: artifact.sourcePath, sourceKeccak256: artifact.sourceKeccak256, compiler: artifact.compiler, bytecodeKeccak256: artifact.bytecodeKeccak256, deployedBytecodeKeccak256: artifact.deployedBytecodeKeccak256 },
    snapshot: { merkleRoot: snapshot.merkleRoot, snapshotHash: snapshot.snapshotHash, eligibleWallets: snapshot.eligibleWallets, cchainBlock: snapshot.cchain.block, grottoBlock: snapshot.grotto.block },
    constructorArgs: Object.fromEntries(Object.entries(config).map(([key, value]) => [key, Array.isArray(value) ? value : String(value)])),
    deploy: { data, dataKeccak256: keccak256(data), dataBytes: (data.length - 2) / 2, gasCeiling: GAS_CEILINGS.deploy.toString(), simulatedGas: deployGas, nonceAtGeneration: pendingNonce, predictedAddressAtGeneration: predicted },
    roles: { issuerRole: roles.issuerRole, defaultAdminRole: roles.defaultAdminRole, candidatesChecked: roles.candidatesChecked, holders: roles.holders, events: roles.events },
    revokes: revokes.map((revoke) => ({ ...revoke, to: RELEASE, gasCeiling: GAS_CEILINGS.revoke.toString() })),
    grant: { to: RELEASE, function: "grantRole(bytes32,address)", role: roles.issuerRole, gasCeiling: GAS_CEILINGS.grant.toString(), simulatedGasForPredictedAddress: grantGas },
    activate: { function: "activate()", selector: id("activate()").slice(0, 10), gasCeiling: GAS_CEILINGS.activate.toString() },
    expectedAfterDeploy: {
      active: false, paused: true, claimStart: "0", claimedSupply: BASELINE.toString(), admin: ARTIST, claimEnd: CLAIM_END.toString(),
      merkleRoot: snapshot.merkleRoot, snapshotHash: snapshot.snapshotHash, eligibleWallets: String(snapshot.eligibleWallets),
      snapshotCChainBlock: String(snapshot.cchain.block), snapshotGrottoBlock: String(snapshot.grotto.block), baselineClaimedSupply: BASELINE.toString(),
      releaseContract: RELEASE, primarySale: SALE, tokenId: "1", priorClaimOne: PRIOR_CLAIMS[0], priorClaimTwo: PRIOR_CLAIMS[1], priorClaimThree: PRIOR_CLAIMS[2],
    },
  };
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = await generateManifest();
  const text = `${JSON.stringify(manifest, null, 1)}\n`;
  const out = argValue("--out");
  if (out && manifest.ok) fs.writeFileSync(out, text); else if (!out) process.stdout.write(text);
  console.error(manifest.ok ? `OK: manifest at block ${manifest.atBlock}${out ? ` written to ${out}` : ""}` : `REFUSED:\n- ${manifest.failures.join("\n- ")}`);
  if (!manifest.funding.sufficient) console.error(`FUNDING: signer holds ${manifest.funding.balanceWei} wei; needs ${manifest.funding.requiredWei} wei (short ${manifest.funding.shortfallWei}). Signing is blocked until funded.`);
  process.exitCode = manifest.ok ? 0 : 1;
}

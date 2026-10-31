// Owner-signing page for the Genesis weekend claim. Runs only from the local server (127.0.0.1). It asks the
// connected wallet (Rabby) to sign exactly one reviewed transaction per click, after re-checking everything
// against the chain and simulating it; it never sends a transaction on its own or after another succeeds.
import * as ethers from "./vendor/ethers.min.js";
import { PLAN, RELEASE_ABI, SALE_ABI, compareDeployState, covers, runtimeMatches, toHex, verifyManifest } from "./core.js";

const CLAIM_ABI = [
  "function active() view returns (bool)", "function paused() view returns (bool)", "function claimStart() view returns (uint256)",
  "function claimEnd() view returns (uint256)", "function claimedSupply() view returns (uint256)", "function admin() view returns (address)",
  "function merkleRoot() view returns (bytes32)", "function snapshotHash() view returns (bytes32)", "function eligibleWallets() view returns (uint256)",
  "function snapshotCChainBlock() view returns (uint256)", "function snapshotGrottoBlock() view returns (uint256)", "function baselineClaimedSupply() view returns (uint256)",
  "function releaseContract() view returns (address)", "function primarySale() view returns (address)", "function tokenId() view returns (uint256)",
  "function priorClaimOne() view returns (address)", "function priorClaimTwo() view returns (address)", "function priorClaimThree() view returns (address)",
  "function activate()",
];
const claimIface = new ethers.Interface(CLAIM_ABI);
const STORE = "genesis-weekend-claim-address";
const $ = (id) => document.getElementById(id);

const state = { manifest: null, artifact: null, wallet: null, provider: null, account: null, claim: null, step: null, ready: null, sending: false };

function log(message, kind = "") {
  const line = document.createElement("div");
  line.className = kind;
  line.textContent = `${new Date().toISOString().slice(11, 19)}  ${message}`;
  $("log").prepend(line);
}

function stop(message) {
  state.ready = null;
  document.querySelectorAll("button.sign").forEach((button) => { button.disabled = true; });
  log(`STOP: ${message}`, "bad");
  const error = new Error(message);
  error.stopped = true;
  throw error;
}

async function call(to, iface, name, args = []) {
  const result = await state.provider.call({ to, data: iface.encodeFunctionData(name, args) });
  return iface.decodeFunctionResult(name, result)[0];
}

const releaseIface = new ethers.Interface(RELEASE_ABI);
const saleIface = new ethers.Interface(SALE_ABI);

async function load() {
  const [manifest, artifact] = await Promise.all([fetch("./manifest.json").then((r) => r.json()), fetch("./artifact.json").then((r) => r.json())]);
  const problems = verifyManifest(ethers, manifest, artifact);
  state.manifest = manifest;
  state.artifact = artifact;
  $("manifest").textContent = JSON.stringify({
    generatedAt: manifest.generatedAt, atBlock: manifest.atBlock, artifact: manifest.artifact, snapshot: manifest.snapshot,
    constructorArgs: manifest.constructorArgs, deployDataKeccak256: manifest.deploy.dataKeccak256, deployDataBytes: manifest.deploy.dataBytes,
    issuerRole: manifest.roles.issuerRole, liveRoleHoldersAtGeneration: manifest.roles.holders, revokes: manifest.revokes.map(({ target, data, gasCeiling }) => ({ target, data, gasCeiling })),
    grant: manifest.grant, activate: manifest.activate, funding: manifest.funding,
  }, null, 2);
  if (problems.length) { problems.forEach((problem) => log(problem, "bad")); stop("The manifest does not match the reviewed plan and artifact. Do not sign anything."); }
  log(`Manifest verified against the artifact: deploy data keccak ${manifest.deploy.dataKeccak256}, source commit ${manifest.artifact.sourceCommit}.`, "ok");
  const stored = localStorage.getItem(STORE);
  if (stored && ethers.isAddress(stored)) { state.claim = ethers.getAddress(stored); $("claimAddress").textContent = state.claim; }
}

async function connect() {
  const wallet = window.ethereum;
  if (!wallet) stop("No browser wallet found. Open this page in the browser profile where Rabby is installed.");
  if (!wallet.isRabby) log("The injected wallet does not identify as Rabby. Continue only if this is your Rabby wallet.", "warn");
  const accounts = await wallet.request({ method: "eth_requestAccounts" });
  const chainId = Number(BigInt(await wallet.request({ method: "eth_chainId" })));
  state.wallet = wallet;
  state.provider = new ethers.BrowserProvider(wallet, PLAN.chainId);
  state.account = ethers.getAddress(accounts[0]);
  $("account").textContent = `${state.account} on chain ${chainId}`;
  if (chainId !== PLAN.chainId) stop(`Rabby is on chain ${chainId}. Switch to Avalanche C-Chain (43114) and reconnect.`);
  if (state.account !== ethers.getAddress(PLAN.signer)) stop(`Connected account ${state.account} is not the authorized artist wallet ${PLAN.signer}.`);
  log("Connected: authorized artist wallet on Avalanche C-Chain 43114.", "ok");
  document.querySelectorAll("button.check").forEach((button) => { button.disabled = false; });
}

async function feeAndBalance(gasCeiling) {
  const [block, balance] = await Promise.all([state.provider.getBlock("latest"), state.provider.getBalance(state.account)]);
  const maxFeePerGas = block.baseFeePerGas * 2n + 1_000_000_000n;
  if (!covers(balance, gasCeiling, maxFeePerGas)) {
    stop(`Balance ${ethers.formatEther(balance)} AVAX does not cover gas ceiling ${gasCeiling} at ${ethers.formatUnits(maxFeePerGas, "gwei")} gwei. Fund the wallet first.`);
  }
  return maxFeePerGas;
}

async function simulate(tx, ceiling) {
  let gas;
  try {
    gas = await state.provider.estimateGas({ ...tx, from: state.account, value: 0n });
  } catch (error) {
    stop(`Simulation reverted: ${error.shortMessage || error.message}`);
  }
  if (gas > BigInt(ceiling)) stop(`Simulated gas ${gas} exceeds the reviewed ceiling ${ceiling}.`);
  log(`Simulation OK: ${gas} gas (ceiling ${ceiling}).`, "ok");
}

async function issuerHolds(account) {
  return call(PLAN.release, releaseIface, "hasRole", [state.manifest.roles.issuerRole, account]);
}

async function readClaimState(address) {
  const names = ["active", "paused", "claimStart", "claimedSupply", "admin", "claimEnd", "merkleRoot", "snapshotHash", "eligibleWallets", "snapshotCChainBlock",
    "snapshotGrottoBlock", "baselineClaimedSupply", "releaseContract", "primarySale", "tokenId", "priorClaimOne", "priorClaimTwo", "priorClaimThree"];
  const values = await Promise.all(names.map((name) => call(address, claimIface, name)));
  return Object.fromEntries(names.map((name, i) => [name, typeof values[i] === "boolean" ? values[i] : String(values[i])]));
}

async function verifyDeployed(address) {
  const code = await state.provider.getCode(address);
  if (!runtimeMatches(code, state.artifact)) stop(`Runtime code at ${address} is not the reviewed GenesisWeekendClaim build.`);
  const problems = compareDeployState(state.manifest.expectedAfterDeploy, await readClaimState(address));
  if (problems.length) { problems.forEach((problem) => log(problem, "bad")); stop("The deployed claim's configuration differs from the approved plan."); }
  log(`Verified ${address}: reviewed runtime code; every immutable matches; inactive and paused; baseline 4; closes 1793595599.`, "ok");
}

async function supplyBalances() {
  const edition = await call(PLAN.release, releaseIface, "edition", [1]);
  // sales() returns eight values (price, maxSupply, sold, ...): decode them all, not just the first.
  const raw = await state.provider.call({ to: PLAN.sale, data: saleIface.encodeFunctionData("sales", [1]) });
  const sale = saleIface.decodeFunctionResult("sales", raw);
  const minted = edition.mintedSupply ?? edition[4];
  if (typeof minted !== "bigint" || typeof sale[2] !== "bigint") stop("Could not read minted or sold supply.");
  return { minted, sold: sale[2] };
}

// Each check gathers the live state for one step, simulates the exact transaction, and arms that step's button.
const CHECKS = {
  async deploy() {
    if (state.claim) stop(`A claim was already deployed at ${state.claim}. Do not deploy twice.`);
    const ceiling = state.manifest.deploy.gasCeiling;
    const [pending, latest] = await Promise.all([state.provider.getTransactionCount(state.account, "pending"), state.provider.getTransactionCount(state.account, "latest")]);
    if (pending !== latest) stop(`The wallet has ${pending - latest} pending transaction(s). Wait for them before deploying.`);
    const predicted = ethers.getCreateAddress({ from: state.account, nonce: pending });
    if ((await state.provider.getCode(predicted)) !== "0x") stop(`Address ${predicted} already has code.`);
    if (await issuerHolds(predicted)) stop(`Predicted address ${predicted} already holds ISSUER_ROLE.`);
    const { minted, sold } = await supplyBalances();
    if (minted !== sold + BigInt(PLAN.baseline)) stop(`Supply invariant broken before deploy: minted ${minted}, sold ${sold}, baseline ${PLAN.baseline}.`);
    await feeAndBalance(ceiling);
    const tx = { data: state.manifest.deploy.data };
    await simulate(tx, ceiling);
    $("deployPredicted").textContent = `${predicted} (nonce ${pending})`;
    return { tx, ceiling, predicted, nonce: pending };
  },
  async revoke1() { return revokeCheck(0); },
  async revoke2() { return revokeCheck(1); },
  async grant() {
    requireClaim();
    await verifyDeployed(state.claim);
    for (const target of PLAN.revokeTargets) if (await issuerHolds(target)) stop(`Revoke ${target} first: it still holds ISSUER_ROLE.`);
    if (await issuerHolds(state.claim)) stop("The weekend claim already holds ISSUER_ROLE.");
    const tx = { to: PLAN.release, data: releaseIface.encodeFunctionData("grantRole", [state.manifest.roles.issuerRole, state.claim]) };
    await feeAndBalance(state.manifest.grant.gasCeiling);
    await simulate(tx, state.manifest.grant.gasCeiling);
    return { tx, ceiling: state.manifest.grant.gasCeiling };
  },
  async activate() {
    requireClaim();
    if ($("activatePhrase").value.trim() !== "ACTIVATE WEEKEND CLAIM" || !$("activateAuthorized").checked) {
      stop("Activation needs the separate owner authorization: tick the box and type ACTIVATE WEEKEND CLAIM.");
    }
    const claimState = await readClaimState(state.claim);
    if (claimState.active) stop("The claim is already active.");
    if (!(await issuerHolds(state.claim))) stop("The weekend claim does not hold ISSUER_ROLE yet.");
    const block = await state.provider.getBlock("latest");
    if (BigInt(block.timestamp) >= BigInt(PLAN.claimEnd)) stop("The weekend close has passed.");
    const { minted, sold } = await supplyBalances();
    if (minted !== sold + BigInt(claimState.claimedSupply)) stop("Supply invariant broken: activation would revert.");
    const tx = { to: state.claim, data: claimIface.encodeFunctionData("activate") };
    await feeAndBalance(state.manifest.activate.gasCeiling);
    await simulate(tx, state.manifest.activate.gasCeiling);
    return { tx, ceiling: state.manifest.activate.gasCeiling };
  },
};

function requireClaim() {
  if (!state.claim) stop("Deploy and verify the weekend claim first.");
}

async function revokeCheck(index) {
  requireClaim();
  await verifyDeployed(state.claim);
  const revoke = state.manifest.revokes[index];
  if (!(await issuerHolds(revoke.target))) stop(`${revoke.target} no longer holds ISSUER_ROLE; nothing to revoke.`);
  const tx = { to: PLAN.release, data: revoke.data };
  await feeAndBalance(revoke.gasCeiling);
  await simulate(tx, revoke.gasCeiling);
  return { tx, ceiling: revoke.gasCeiling };
}

// Post-transaction verification for each step: the receipt and the resulting chain state.
const VERIFY = {
  async deploy(receipt, ready) {
    const address = ethers.getAddress(receipt.contractAddress || "0x0000000000000000000000000000000000000000");
    if (address !== ready.predicted) stop(`Deployed at ${address}, not the predicted ${ready.predicted}.`);
    await verifyDeployed(address);
    state.claim = address;
    localStorage.setItem(STORE, address);
    $("claimAddress").textContent = address;
  },
  async revoke1() { await revokeVerify(0); },
  async revoke2() { await revokeVerify(1); },
  async grant() {
    if (!(await issuerHolds(state.claim))) stop("The grant confirmed but the claim does not hold ISSUER_ROLE.");
    const claimState = await readClaimState(state.claim);
    if (claimState.active || !claimState.paused) stop("The claim is not inactive and paused after the grant.");
    log("ISSUER_ROLE granted; the claim is still inactive and paused. Next: Render configuration and production checks.", "ok");
  },
  async activate() {
    const claimState = await readClaimState(state.claim);
    if (!claimState.active || claimState.paused || claimState.claimStart === "0") stop("Activation confirmed but the claim is not active.");
    log(`Claim active since ${claimState.claimStart}; closes ${PLAN.claimEnd}.`, "ok");
  },
};

async function revokeVerify(index) {
  const target = state.manifest.revokes[index].target;
  if (await issuerHolds(target)) stop(`The revoke confirmed but ${target} still holds ISSUER_ROLE.`);
  log(`${target} no longer holds ISSUER_ROLE.`, "ok");
}

async function onCheck(step) {
  state.ready = null;
  document.querySelectorAll("button.sign").forEach((button) => { button.disabled = true; });
  try {
    state.ready = { step, ...(await CHECKS[step]()) };
    $(`sign-${step}`).disabled = false;
    log(`${step}: all checks passed. Review in Rabby, then sign. Nothing has been sent.`, "ok");
  } catch (error) {
    if (!error.stopped) log(`${step}: ${error.shortMessage || error.message}`, "bad");
  }
}

async function onSign(step) {
  if (state.sending || !state.ready || state.ready.step !== step) return;
  state.sending = true;
  const ready = state.ready;
  state.ready = null;
  $(`sign-${step}`).disabled = true;
  try {
    // Re-confirm the wallet, the chain and (for the deploy) the nonce at the moment of signing.
    const chainId = Number(BigInt(await state.wallet.request({ method: "eth_chainId" })));
    const [current] = await state.wallet.request({ method: "eth_accounts" });
    if (chainId !== PLAN.chainId) stop(`Rabby switched to chain ${chainId}. Nothing was sent.`);
    if (!current || ethers.getAddress(current) !== state.account) stop("Rabby switched accounts. Nothing was sent.");
    if (step === "deploy") {
      const pending = await state.provider.getTransactionCount(state.account, "pending");
      if (pending !== ready.nonce) stop(`The wallet nonce moved from ${ready.nonce} to ${pending}. Run the deploy check again.`);
    }
    const maxFeePerGas = await feeAndBalance(ready.ceiling);
    const params = { from: state.account, value: "0x0", gas: toHex(ready.ceiling), maxFeePerGas: toHex(maxFeePerGas), ...("to" in ready.tx ? { to: ready.tx.to } : {}), data: ready.tx.data };
    log(`${step}: requesting your signature in Rabby…`);
    const hash = await state.wallet.request({ method: "eth_sendTransaction", params: [params] });
    log(`${step}: submitted ${hash}. Waiting for the receipt…`);
    const receipt = await state.provider.waitForTransaction(hash, 1, 300_000);
    if (!receipt || receipt.status !== 1) stop(`${step}: transaction ${hash} did not succeed.`);
    await VERIFY[step](receipt, ready);
    log(`${step}: confirmed in block ${receipt.blockNumber} and verified (${hash}). Stop and report before the next step.`, "ok");
    $(`done-${step}`).textContent = `done · ${hash}`;
  } catch (error) {
    if (error.stopped) return;
    log(error.code === 4001 || error.code === "ACTION_REJECTED" ? `${step}: rejected in Rabby. Nothing was sent.` : `${step}: ${error.shortMessage || error.message}`, "bad");
  } finally {
    state.sending = false;
  }
}

$("connect").addEventListener("click", () => { connect().catch((error) => { if (!error.stopped) log(error.message, "bad"); }); });
for (const step of Object.keys(CHECKS)) {
  $(`check-${step}`).addEventListener("click", () => { void onCheck(step); });
  $(`sign-${step}`).addEventListener("click", () => { void onSign(step); });
}
$("forget").addEventListener("click", () => { localStorage.removeItem(STORE); state.claim = null; $("claimAddress").textContent = "none"; log("Forgot the stored claim address."); });
load().catch((error) => { if (!error.stopped) log(error.message, "bad"); });

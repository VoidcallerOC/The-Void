import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider, getAddress, keccak256 } from "ethers";
import mainnetManifest from "../config/mainnet-release-per-contract.json" with { type: "json" };
import { bindPlan, verifyBinding } from "./deployment-plan-binding.mjs";
import { FEE_RECIPIENT, buildDeploymentRecord, buildDryRunPlan, deploymentRecordPath, validateDeploymentEnv, verifyReleaseStep, writeRecordFile } from "./deploy-release-per-contract-mainnet.mjs";
import { buildClaimRecord, buildPlan as buildClaimPlan, loadClaimArtifact, mainnetSigningPlan, preflightClaimDeployment, validateClaimDeploymentEnv, verifyClaimDeployment } from "./deploy-genesis-claim.mjs";
import { MAINNET_CHAIN_ID, MAINNET_DEPLOYER, NotMinedYetError, assertNoPrivateKeyInEnv, assertReadyToSign, walletTransaction } from "./mainnet-signing-requests.mjs";
import { GENESIS_CHAIN_ID } from "../server/genesis-claim.js";

// Owner-controlled mainnet signing through Rabby. This tool never holds, reads or asks for a private
// key. It re-plans the reviewed deployment without any key, refuses unless the fresh plan matches the
// approved binding on the checked-out commit, and then serves a page on 127.0.0.1 that hands each
// unsigned transaction, one at a time and only after live checks, to the Rabby extension. The owner
// reviews and approves every transaction in Rabby with the defined deployer; Rabby signs and submits
// it. The tool then verifies the mined transaction and contract state from the RPC, independently of
// the wallet, before the next step is offered. `verify` re-checks mined transactions at any time.
// `--resume <hash>` continues after earlier steps were signed in a session that has since ended.
// `start` (npm run owner:deploy) is the single entry point: it plans from the live chain without any
// key, shows on the page what blocks signing (funding, nonce, inputs) with a re-check, and lets the
// owner approve the plan on the page, which binds it to the commit before any step is offered.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE_PATH = resolve(ROOT, "deploy/mainnet/owner-signing.html");
const ETHERS_BUNDLE = resolve(ROOT, "node_modules/ethers/dist/ethers.umd.min.js");
const MAX_BODY_BYTES = 4096;
// Approved plans and bindings written by `start` (public data, no secrets; ignored by git).
export const PLAN_DIR = resolve(ROOT, ".owner-signing");

export class OwnerSigningError extends Error {}

const fail = (message) => { throw new OwnerSigningError(message); };

/** The two separately planned and separately signed mainnet operations. */
export const KINDS = Object.freeze({
  "release-per-contract-mainnet": {
    title: "Release infrastructure: VoidReleaseFactoryV2RoyaltySettled, then ReleaseMarketplaceV4",
    needsDeviceConfirmation: true,
    async replan(inputs, { rpcUrl, provider }) {
      return buildDryRunPlan(validateDeploymentEnv({ ...inputs, AVALANCHE_MAINNET_RPC_URL: rpcUrl }), provider);
    },
    ready: (plan) => plan.readyToBroadcast === true,
    // Before step 1 the factory, its implementation and the marketplace must all be empty.
    emptyBefore: (plan, step) => (step === 1 ? [plan.transactions[0].predictedAddress, plan.transactions[0].predictedImplementation, plan.transactions[1].predictedAddress] : [plan.transactions[1].predictedAddress]),
    verifyStep: (provider, plan, step, hash, options) => verifyReleaseStep(provider, plan, step, hash, options),
    record: (plan, verified, meta) => ({ path: deploymentRecordPath(verified[0].address), record: buildDeploymentRecord(plan, verified, meta) }),
    summary: (plan) => plan.transactions.map((tx) => ({ step: tx.step, contract: tx.contract, constructor: tx.constructor, predictedAddress: tx.predictedAddress, predictedImplementation: tx.predictedImplementation ?? null })),
  },
  "genesis-claim-mainnet": {
    title: "Forgive & Forget Genesis claim: GenesisHolderClaim",
    needsDeviceConfirmation: false,
    async replan(inputs, { rpcUrl, provider, genesisRpcUrl, genesisProvider, artifact }) {
      const config = validateClaimDeploymentEnv({ ...inputs, AVALANCHE_MAINNET_RPC_URL: rpcUrl, GENESIS_RPC_URL: genesisRpcUrl });
      const claimArtifact = artifact || await loadClaimArtifact();
      const facts = await preflightClaimDeployment(config, { provider, genesisProvider, artifact: claimArtifact });
      const plan = await mainnetSigningPlan(config, facts, buildClaimPlan(config, facts), { provider, artifact: claimArtifact });
      return { mode: "DRY_RUN", ...plan };
    },
    ready: (plan) => plan.readyToSign === true,
    emptyBefore: (plan) => [plan.predictedClaimAddress],
    verifyStep: (provider, plan, _step, hash, options) => verifyClaimDeployment(provider, plan, hash, options),
    record: (plan, [claim], meta) => ({ path: `deployments/genesis-claim-mainnet-${claim.address}.json`, record: buildClaimRecord(plan, claim, meta) }),
    summary: (plan) => [{ step: 1, contract: "GenesisHolderClaim", predictedAddress: plan.predictedClaimAddress, target: plan.target, schedule: plan.schedule, roles: plan.roles, issuerGrant: plan.followUps?.issuerGrant }],
  },
});

function kindOf(name) {
  return KINDS[name] || fail(`--kind must be one of: ${Object.keys(KINDS).join(", ")}.`);
}

/** The checked-out commit; refuses tracked local modifications, so the reviewed source is what runs. */
export function checkedOutCommit({ exec = execFileSync } = {}) {
  const dirty = exec("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: ROOT, encoding: "utf8" }).trim();
  if (dirty) fail(`The working tree has tracked modifications; check out the reviewed commit cleanly:\n${dirty}`);
  return exec("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
}

/**
 * Builds a signing session: the reviewed plan must match the approved binding, and a fresh key-less
 * plan from the live chain must match it too, on the checked-out commit. Nothing is signed here.
 */
export async function createSigningSession({ kind, reviewedPlan, approvedBinding, commit, providers, recipientVerifiedOnDevice, env = process.env, replan, verifyOptions = {}, resumeHashes = [] }) {
  assertNoPrivateKeyInEnv(env, "The owner signing tool");
  const spec = kindOf(kind);
  if (bindPlan(kind, reviewedPlan, approvedBinding.sourceCommit).digest !== approvedBinding.digest) fail("The reviewed plan file does not produce the approved binding.");
  if (!reviewedPlan.planInputs) fail("The reviewed plan has no planInputs; re-plan with the current scripts.");
  if (getAddress(reviewedPlan.planInputs.EXPECTED_DEPLOYER_ADDRESS) !== MAINNET_DEPLOYER) fail(`The plan's deployer is not the defined deployer ${MAINNET_DEPLOYER}.`);
  if (spec.needsDeviceConfirmation) {
    const typed = String(recipientVerifiedOnDevice ?? "").trim();
    let confirmed = null;
    try { confirmed = getAddress(typed); } catch { confirmed = null; }
    if (confirmed !== FEE_RECIPIENT) fail(`--recipient-verified-on-device must be the fee recipient exactly as read on the Nano S Plus screen (${FEE_RECIPIENT}). The device only displays it; it signs nothing.`);
  }
  if (resumeHashes.length) return resumeSession({ kind, spec, reviewedPlan, approvedBinding, commit, providers, verifyOptions, resumeHashes });
  const fresh = await (replan ? replan(reviewedPlan.planInputs) : spec.replan(reviewedPlan.planInputs, providers));
  const binding = verifyBinding(approvedBinding, kind, fresh, commit);
  if (!spec.ready(fresh)) fail("The fresh plan is not ready to sign (see its checks: funding, nonce, pending transactions, empty addresses).");
  return {
    phase: "signing",
    kind,
    title: spec.title,
    commit: binding.sourceCommit,
    digest: binding.digest,
    binding,
    plan: fresh,
    steps: fresh.signingRequests.map((request) => ({ request, status: "pending", hash: null, verified: null, error: null })),
    record: null,
    verifyOptions,
  };
}

/**
 * Continues after earlier steps were signed in a session that ended (a closed terminal or browser, or
 * a receipt that arrived late). A fresh plan cannot match any more, because the deployer's nonce has
 * moved, so the reviewed plan itself is used: it must produce the approved binding on this commit,
 * every request's data must hash to its bound value, and each given hash is verified from chain as
 * that step before the remaining steps are offered, each again behind the live pre-sign checks.
 */
async function resumeSession({ kind, spec, reviewedPlan, approvedBinding, commit, providers, verifyOptions, resumeHashes }) {
  if (commit !== approvedBinding.sourceCommit) fail(`The approved plan was made on ${approvedBinding.sourceCommit}, not ${commit}.`);
  const requests = reviewedPlan.signingRequests || [];
  if (resumeHashes.length >= requests.length) fail("Every planned step already has a hash; use `npm run verify:mainnet` instead.");
  for (const request of requests) if (keccak256(request.data) !== request.dataHash) fail(`Step ${request.step}: the reviewed plan's creation data does not hash to its bound value.`);
  const steps = requests.map((request) => ({ request, status: "pending", hash: null, verified: null, error: null }));
  for (const [index, hash] of resumeHashes.entries()) {
    steps[index].verified = await spec.verifyStep(providers.provider, reviewedPlan, index + 1, hash, verifyOptions);
    steps[index].hash = hash;
    steps[index].status = "verified";
  }
  return { phase: "signing", kind, title: spec.title, commit, digest: approvedBinding.digest, binding: approvedBinding, plan: reviewedPlan, steps, record: null, verifyOptions };
}

/** A plan failure in words the operator can act on. */
function planErrorMessage(error) {
  if (error?.code === "ENOENT" && /out\//.test(String(error.path || error.message))) return "The compiled contracts are missing. Run `forge build` (Foundry v1.3.1) in this checkout, then press Re-check.";
  return error?.message || String(error);
}

/**
 * The entry point's first phase: a key-less plan from the live chain, re-checkable from the page.
 * Nothing can be handed to the wallet until the owner approves a ready plan (approvePlan).
 */
export async function createPlanningSession({ kind, commit, inputs, replan, env = process.env, verifyOptions = {} }) {
  assertNoPrivateKeyInEnv(env, "The owner signing tool");
  const spec = kindOf(kind);
  const session = { phase: "planning", kind, title: spec.title, commit, inputs, plan: null, planError: null, steps: [], record: null, verifyOptions, planFiles: null };
  await recheckPlan(session, { replan });
  return session;
}

/** Re-plans from the live chain (after funding, for example). Planning phase only. */
export async function recheckPlan(session, { replan }) {
  if (session.phase !== "planning") fail("The plan is already approved; signing has started.");
  try {
    session.plan = await replan(session.inputs);
    session.planError = null;
  } catch (error) {
    session.plan = null;
    session.planError = planErrorMessage(error);
  }
  return session;
}

/**
 * The owner approves the ready plan on the page. It is bound to the checked-out commit, written to
 * .owner-signing/ (plan.json, plan-binding.json) for the record and for --resume, and then the
 * signing session is built exactly as `serve` builds it: the fresh plan must match the binding.
 */
export async function approvePlan(session, { recipientVerifiedOnDevice, providers, replan, env = process.env, writePlanFiles = writePlanFilesToDisk }) {
  if (session.phase !== "planning") fail("The plan is already approved.");
  const spec = kindOf(session.kind);
  if (!session.plan) fail(`There is no plan to approve: ${session.planError || "press Re-check"}.`);
  if (!spec.ready(session.plan)) fail("The plan is not ready to sign. Resolve the failing checks, then press Re-check.");
  const approvedBinding = bindPlan(session.kind, session.plan, session.commit);
  const signing = await createSigningSession({ kind: session.kind, reviewedPlan: session.plan, approvedBinding, commit: session.commit, providers, recipientVerifiedOnDevice, env, replan, verifyOptions: session.verifyOptions });
  const planFiles = await writePlanFiles(session.kind, session.plan, approvedBinding);
  Object.assign(session, signing, { planFiles, planError: null });
  return session;
}

async function writePlanFilesToDisk(kind, plan, binding) {
  const dir = resolve(PLAN_DIR, `${kind}-${binding.sourceCommit.slice(0, 7)}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" });
  await writeFile(resolve(dir, "plan-binding.json"), `${JSON.stringify(binding, null, 2)}\n`, { flag: "wx" });
  return { plan: `${dir}/plan.json`, binding: `${dir}/plan-binding.json` };
}

/** The non-secret inputs `start` plans with: the defined deployer at its live nonce, plus the kind's own. */
export async function startInputs(kind, { provider, input = [] }) {
  kindOf(kind);
  const given = Object.fromEntries(input.map((pair) => {
    const at = pair.indexOf("=");
    if (at < 1) fail(`--input must be KEY=VALUE, not ${pair}.`);
    return [pair.slice(0, at).trim(), pair.slice(at + 1).trim()];
  }));
  for (const key of Object.keys(given)) {
    if (/PRIVATE_KEY/i.test(key)) fail("A private key is never an input.");
    if (key === "EXPECTED_DEPLOYER_ADDRESS" && getAddress(given[key]) !== MAINNET_DEPLOYER) fail(`The deployer is fixed: ${MAINNET_DEPLOYER}.`);
  }
  const nonce = String(await provider.getTransactionCount(MAINNET_DEPLOYER, "latest"));
  const base = { DEPLOY_NETWORK: "mainnet", EXPECTED_DEPLOYER_ADDRESS: MAINNET_DEPLOYER, EXPECTED_DEPLOYER_NONCE: nonce };
  if (kind === "release-per-contract-mainnet") return { ...base, RELEASE_PLATFORM_RECIPIENT: FEE_RECIPIENT, ...given };
  return { ...base, ...given };
}

/** The one thing the operator should do next, from the session state. */
export function nextAction(session) {
  const spec = KINDS[session.kind];
  if (session.phase === "planning") {
    if (session.planError) return `Fix this, then press Re-check: ${session.planError}`;
    const failing = (session.plan?.checks || []).filter((check) => check.status === "FAIL" || check.status === "BLOCKED");
    const funding = failing.find((check) => /funded/.test(check.check));
    if (funding) return `Fund the deployer ${MAINNET_DEPLOYER} on Avalanche C-Chain with at least ${funding.value.requiredAvax} AVAX (it holds ${funding.value.balanceAvax}), then press Re-check.`;
    if (failing.length) return `Signing is blocked by: ${failing.map((check) => check.check).join("; ")}. Resolve it, then press Re-check.`;
    if (!spec.ready(session.plan)) return "The plan is not ready to sign. Press Re-check.";
    return spec.needsDeviceConfirmation
      ? `Review the plan, type the fee recipient exactly as your Nano S Plus screen shows it (${FEE_RECIPIENT}), and press Approve plan.`
      : "Review the plan, then press Approve plan.";
  }
  const failed = session.steps.find((step) => step.status === "failed");
  if (failed) return `Stop. Step ${failed.request.step} failed verification: ${failed.error}`;
  if (session.record) return `Done. Commit ${session.record.path} in a record PR.`;
  const current = session.steps.find((step) => step.status !== "verified");
  if (!current) return "All steps are verified.";
  const n = current.request.step;
  if (current.status === "pending") return `Connect Rabby (deployer, Avalanche C-Chain), tick step ${n}'s review box and send step ${n} to Rabby.`;
  if (current.status === "awaiting-wallet") return `Approve or reject step ${n} in Rabby.`;
  if (current.status === "awaiting-receipt") return `Step ${n} is not mined yet. Check its hash again once Rabby shows it confirmed.`;
  return `Step ${n} is ${current.status}; wait.`;
}

/** Live checks for step n, then the exact wallet transaction. Marks the step as waiting for Rabby. */
export async function prepareStep(session, n, { provider, replan }) {
  if (session.phase !== "signing") fail("Approve the plan first; nothing is offered for signing before that.");
  const step = session.steps[n - 1] || fail(`There is no step ${n}.`);
  if (session.steps.some((item) => item.status === "failed")) fail("A step failed verification. Stop and review; nothing more is offered for signing in this session.");
  if (session.steps.slice(0, n - 1).some((item) => item.status !== "verified")) fail(`Step ${n} is offered only after every earlier step is verified on chain.`);
  if (step.status !== "pending") fail(`Step ${n} is ${step.status}.`);
  // Claimed before any await, so two concurrent requests can never both hand the step to the wallet.
  step.status = "preparing";
  try {
    // Before the first signature the whole plan is re-derived from chain and re-matched to the approval.
    if (n === 1 && replan) verifyBinding(session.binding, session.kind, await replan(), session.commit);
    await assertReadyToSign(provider, step.request, KINDS[session.kind].emptyBefore(session.plan, n));
  } catch (error) {
    step.status = "pending";
    throw error;
  }
  step.status = "awaiting-wallet";
  return { step: n, transaction: walletTransaction(step.request), dataHash: step.request.dataHash, predictedAddress: step.request.predictedAddress };
}

/** The owner rejected the request in Rabby: nothing was signed, so the step can be offered again. */
export function cancelStep(session, n) {
  const step = session.steps[n - 1] || fail(`There is no step ${n}.`);
  if (step.status !== "awaiting-wallet") fail(`Step ${n} is ${step.status}.`);
  step.status = "pending";
}

/** Records the hash Rabby returned and verifies the mined result from the RPC. */
export async function submitStep(session, n, hash, { provider, writeRecord = writeRecordFile, timeoutMs, log = () => {} }) {
  const step = session.steps[n - 1] || fail(`There is no step ${n}.`);
  // A hash is accepted for a step that was handed to Rabby, that is waiting for its receipt, or that
  // went back to pending after Rabby reported an error although it had in fact sent the transaction.
  // Verification against the reviewed request is the gate, whatever the page believed.
  if (!["awaiting-wallet", "awaiting-receipt", "pending"].includes(step.status)) fail(`Step ${n} is ${step.status}.`);
  if (session.steps.slice(0, n - 1).some((item) => item.status !== "verified")) fail(`Step ${n} is accepted only after every earlier step is verified on chain.`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(hash || ""))) fail("A 32-byte transaction hash is required.");
  step.status = "submitted";
  step.hash = hash;
  log({ step: "SUBMITTED", n, hash });
  try {
    step.verified = await KINDS[session.kind].verifyStep(provider, session.plan, n, hash, { ...session.verifyOptions, timeoutMs });
    step.status = "verified";
    log({ step: "VERIFIED", n, result: step.verified });
  } catch (error) {
    step.error = error.message;
    if (error instanceof NotMinedYetError) {
      // Not a mismatch: the transaction is not mined yet. Keep the hash and allow a re-check.
      step.status = "awaiting-receipt";
      log({ step: "NOT_MINED_YET", n, hash });
      return step;
    }
    step.status = "failed";
    log({ step: "VERIFICATION_FAILED", n, hash, error: error.message });
    return step;
  }
  step.error = null;
  if (session.steps.every((item) => item.status === "verified")) {
    const { path, record } = KINDS[session.kind].record(session.plan, session.steps.map((item) => item.verified), { sourceCommit: session.commit, planDigest: session.digest });
    session.record = { path, record };
    log({ step: "RECORD", path, record });
    try { await writeRecord(path, record); } catch (error) { log({ step: "RECORD_WRITE_FAILED", path, error: error.message }); }
  }
  return step;
}

/** What the page shows. Contains no secret: only public addresses, bytecode hashes and plan facts. */
export function sessionView(session) {
  const spec = KINDS[session.kind];
  const requests = session.phase === "signing" ? session.steps : (session.plan?.signingRequests || []).map((request) => ({ request, status: "not approved", hash: null, verified: null, error: null }));
  return {
    phase: session.phase,
    kind: session.kind,
    title: session.title,
    chainId: MAINNET_CHAIN_ID,
    deployer: MAINNET_DEPLOYER,
    feeRecipient: FEE_RECIPIENT,
    commit: session.commit,
    digest: session.digest ?? null,
    needsDeviceConfirmation: spec.needsDeviceConfirmation,
    readyToApprove: session.phase === "planning" && Boolean(session.plan) && spec.ready(session.plan),
    planError: session.planError ?? null,
    checks: (session.plan?.checks || []).map(({ check, status, value, reason }) => ({ check, status, value: value ?? null, reason: reason ?? null })),
    nextAction: nextAction(session),
    planFiles: session.planFiles ?? null,
    contracts: session.plan ? spec.summary(session.plan) : [],
    steps: requests.map(({ request, status, hash, verified, error }) => ({
      step: request.step, contract: request.contract, nonce: request.nonce, from: request.from, predictedAddress: request.predictedAddress,
      dataHash: request.dataHash, dataBytes: (request.data.length - 2) / 2, gasLimit: request.gasLimit, status, hash, verified, error,
    })),
    record: session.record,
  };
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) fail("Request body too large.");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

/** A loopback-only HTTP server for one session. Requests need the session token and same-origin. */
export function createSigningServer(session, { provider, providers = { provider }, replan, writeRecord, writePlanFiles, timeoutMs, env = process.env, log = (value) => console.log(JSON.stringify(value)), token = randomBytes(16).toString("hex") } = {}) {
  let origin = null;
  const base = `/s/${token}`;
  const json = (res, status, value) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
  const server = createServer(async (req, res) => {
    try {
      // Loopback host only (DNS rebinding), and for writes the page's own origin only (cross-site requests).
      if (req.headers.host !== new URL(origin).host) return json(res, 421, { error: "Wrong host." });
      if (req.method === "POST" && req.headers.origin !== origin) return json(res, 403, { error: "Cross-origin request refused." });
      const url = new URL(req.url, origin);
      if (!url.pathname.startsWith(`${base}/`)) return json(res, 404, { error: "Not found." });
      const route = url.pathname.slice(base.length);
      res.setHeader("x-content-type-options", "nosniff");
      if (req.method === "GET" && route === "/") {
        // No script-src or connect-src restriction: a wallet extension injects its provider into the page
        // and may make requests from it, and a restrictive policy can break that. Framing is refused.
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "frame-ancestors 'none'", "x-frame-options": "DENY" });
        return res.end(await readFile(PAGE_PATH));
      }
      if (req.method === "GET" && route === "/ethers.js") {
        res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
        return res.end(await readFile(ETHERS_BUNDLE));
      }
      if (req.method === "GET" && route === "/session") return json(res, 200, sessionView(session));
      if (req.method === "POST" && route === "/recheck") { await readBody(req); await recheckPlan(session, { replan }); return json(res, 200, sessionView(session)); }
      if (req.method === "POST" && route === "/approve") {
        const body = await readBody(req);
        await approvePlan(session, { recipientVerifiedOnDevice: body.recipientVerifiedOnDevice, providers, replan, env, ...(writePlanFiles ? { writePlanFiles } : {}) });
        log({ step: "PLAN_APPROVED", kind: session.kind, sourceCommit: session.commit, digest: session.digest, files: session.planFiles });
        return json(res, 200, sessionView(session));
      }
      const match = /^\/steps\/(\d+)\/(prepare|submitted|cancel)$/.exec(route);
      if (req.method === "POST" && match) {
        const n = Number(match[1]);
        const body = await readBody(req);
        if (match[2] === "prepare") return json(res, 200, await prepareStep(session, n, { provider, replan }));
        if (match[2] === "cancel") { cancelStep(session, n); return json(res, 200, sessionView(session)); }
        const pending = submitStep(session, n, body.hash, { provider, writeRecord, timeoutMs, log });
        // Verification waits for the receipt; the page polls /session meanwhile.
        if (session.steps[n - 1]?.status === "submitted") { pending.catch(() => {}); return json(res, 202, sessionView(session)); }
        await pending;
        return json(res, 200, sessionView(session));
      }
      return json(res, 404, { error: "Not found." });
    } catch (error) {
      log({ step: "REFUSED", error: error.message });
      return json(res, 409, { error: error.message });
    }
  });
  return {
    server,
    async listen(port = 0) {
      await new Promise((resolveListen) => server.listen(port, "127.0.0.1", resolveListen));
      origin = `http://127.0.0.1:${server.address().port}`;
      return `${origin}${base}/`;
    },
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

function options(argv) {
  const out = { tx: [], resume: [], input: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    if (name === "write-record") { out.writeRecord = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`--${name} needs a value.`);
    if (name === "tx" || name === "resume" || name === "input") out[name].push(value); else out[name] = value;
    i += 1;
  }
  return out;
}

function rpcFrom(value, fallback, name) {
  const url = String(value || fallback || "").trim();
  if (!(/^https:\/\//i.test(url) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(url)) || /@/.test(url)) fail(`${name} must be an HTTPS URL (or a local node) without embedded credentials.`);
  return url;
}

function makeProviders(opts, env) {
  const rpcUrl = rpcFrom(opts.rpc, env.AVALANCHE_MAINNET_RPC_URL || mainnetManifest.rpcUrl, "--rpc");
  const genesisRpcUrl = rpcFrom(opts["genesis-rpc"], env.GENESIS_RPC_URL || mainnetManifest.rpcUrl, "--genesis-rpc");
  return {
    rpcUrl,
    genesisRpcUrl,
    // cacheTimeout -1: every live check and every verification is a fresh read, never a cached one.
    provider: new JsonRpcProvider(rpcUrl, MAINNET_CHAIN_ID, { staticNetwork: true, cacheTimeout: -1 }),
    genesisProvider: new JsonRpcProvider(genesisRpcUrl, GENESIS_CHAIN_ID, { staticNetwork: true, cacheTimeout: -1 }),
  };
}

const readJson = async (path) => JSON.parse(await readFile(resolve(path), "utf8"));

/** `verify`: re-checks mined transactions against the reviewed plan, from the RPC alone. */
export async function verifyCommand(opts, { providers, writeRecord = writeRecordFile }) {
  const spec = kindOf(opts.kind);
  const plan = await readJson(opts.plan || fail("--plan is required."));
  if (!Array.isArray(plan.signingRequests) || opts.tx.length !== plan.signingRequests.length) fail(`Give one --tx per planned step (${plan.signingRequests?.length ?? 0}), in order.`);
  // The plan must be the approved one before anything is checked against it.
  const binding = opts.binding ? await readJson(opts.binding) : null;
  if (binding && bindPlan(opts.kind, plan, binding.sourceCommit).digest !== binding.digest) fail("The plan file does not produce the given binding.");
  const verified = [];
  for (const [index, hash] of opts.tx.entries()) verified.push(await spec.verifyStep(providers.provider, plan, index + 1, hash, {}));
  const { path, record } = spec.record(plan, verified, { sourceCommit: binding?.sourceCommit ?? null, planDigest: binding?.digest ?? null });
  if (opts.writeRecord) await writeRecord(path, record);
  return { mode: "VERIFIED", path, record };
}

/**
 * `start` (npm run owner:deploy): the single entry point from a clean checkout. It plans from the live
 * chain for the defined deployer at its current nonce, serves the page even when signing is blocked
 * (the page shows why and re-checks), and offers steps only after the owner approves the plan there.
 */
async function startCommand(opts, { providers, env }) {
  const kind = opts.kind || "release-per-contract-mainnet";
  const spec = kindOf(kind);
  const commit = checkedOutCommit();
  const inputs = await startInputs(kind, { provider: providers.provider, input: opts.input });
  const replan = (planInputs = inputs) => spec.replan(planInputs, providers);
  const session = await createPlanningSession({ kind, commit, inputs, replan, env });
  const handle = createSigningServer(session, { provider: providers.provider, providers, replan, env });
  const url = await handle.listen(opts.port ? Number(opts.port) : 0);
  console.log(JSON.stringify({ step: "PLANNED", kind, sourceCommit: commit, deployer: MAINNET_DEPLOYER, nonce: inputs.EXPECTED_DEPLOYER_NONCE, readyToApprove: sessionView(session).readyToApprove }));
  console.log(`\nNext: ${nextAction(session)}`);
  console.log(`\nOpen this page in the browser profile where Rabby holds the deployer ${MAINNET_DEPLOYER}:\n\n  ${url}\n\nNothing is signed until you approve the plan on the page and then each transaction in Rabby. Press Ctrl+C to stop.`);
  return handle;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  assertNoPrivateKeyInEnv(env, "The owner signing tool");
  const [command, ...rest] = argv;
  const opts = options(rest);
  const providers = makeProviders(opts, env);
  if (command === "verify") {
    const result = await verifyCommand(opts, { providers });
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (command === "start") return startCommand(opts, { providers, env });
  if (command !== "serve") fail('Use "start", "serve" or "verify".');
  const spec = kindOf(opts.kind);
  const reviewedPlan = await readJson(opts.plan || fail("--plan is required (the reviewed plan.json)."));
  const approvedBinding = await readJson(opts.binding || fail("--binding is required (the approved plan-binding.json)."));
  const session = await createSigningSession({ kind: opts.kind, reviewedPlan, approvedBinding, commit: checkedOutCommit(), providers, recipientVerifiedOnDevice: opts["recipient-verified-on-device"], env, resumeHashes: opts.resume });
  const handle = createSigningServer(session, { provider: providers.provider, replan: () => spec.replan(reviewedPlan.planInputs, providers) });
  const url = await handle.listen(opts.port ? Number(opts.port) : 0);
  console.log(JSON.stringify({ step: "PLAN_MATCHES_APPROVAL", kind: session.kind, sourceCommit: session.commit, digest: session.digest, deployer: MAINNET_DEPLOYER }));
  console.log(`\nOpen this page in the browser profile where Rabby holds the deployer ${MAINNET_DEPLOYER}:\n\n  ${url}\n\nNothing is signed until you approve each transaction in Rabby. Press Ctrl+C to stop.`);
  return handle;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Owner signing refused: ${error.message}`);
    process.exitCode = 1;
  });
}

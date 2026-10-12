import { formatEther, getAddress } from "ethers";
import { validateApprovedPlan } from "../../scripts/approved-plan.mjs";
import { checkFactoryState, checkMarketplaceState } from "../../scripts/mainnet-onchain-checks.mjs";
import { MAINNET_CHAIN_ID, MAINNET_DEPLOYER, NotMinedYetError, assertReadyToSign, verifyCreationTransaction, walletTransaction } from "../../scripts/mainnet-signing-requests.mjs";

// The owner deployment page's logic, without the DOM. Every check reuses the modules the Node tools
// use. Nothing here holds a key or sends a transaction: the page hands one transaction at a time to
// Rabby, and the owner approves it there.
export const PUBLIC_RPC = "https://api.avax.network/ext/bc/C/rpc";
export const VERIFY_WORKFLOW_URL = "https://github.com/VoidcallerOC/The-Void/actions/workflows/verify-mainnet-deployment.yml";

/** The four states the page distinguishes for every transaction, plus a stop state. */
export const STEP_STATUS = Object.freeze({
  prepared: "Prepared: in the approved plan, nothing sent",
  "awaiting-wallet": "Wallet approval requested: approve or reject it in Rabby",
  submitted: "Submitted: sent to the network, waiting for confirmation",
  confirmed: "Confirmed and verified on chain",
  failed: "Failed verification: stop",
});

/** Only the default public RPC, or a node on this machine (for a local fork rehearsal). */
export function rpcFromQuery(search) {
  const value = new URLSearchParams(search || "").get("rpc");
  if (!value) return { url: PUBLIC_RPC, override: false };
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/i.test(value)) throw new Error("Only a local node (http://127.0.0.1:port) may replace the public C-Chain RPC.");
  return { url: value, override: true };
}

/** Validates each committed approved plan; an invalid one is shown with its reason and never offered. */
export function loadApprovedPlans(modules) {
  return Object.entries(modules).map(([path, module]) => {
    const entry = module?.default ?? module;
    try {
      return { path, entry: validateApprovedPlan(entry), error: null };
    } catch (error) {
      return { path, entry, error: error.message };
    }
  });
}

/** Fresh state for one approved plan; submitted hashes come back from the page's storage. */
export function initialState(entry, storedHashes = {}) {
  return {
    kind: entry.kind,
    digest: entry.binding.digest,
    steps: entry.plan.signingRequests.map((request) => ({
      request,
      status: storedHashes[request.step] ? "submitted" : "prepared",
      hash: storedHashes[request.step] || null,
      verified: null,
      error: null,
    })),
  };
}

/** The addresses that must still be empty before step n. */
function emptyBefore(entry, n) {
  if (entry.kind === "release-per-contract-mainnet") {
    const [factory, marketplace] = entry.plan.transactions;
    return n === 1 ? [factory.predictedAddress, factory.predictedImplementation, marketplace.predictedAddress] : [marketplace.predictedAddress];
  }
  return [entry.plan.predictedClaimAddress];
}

/** Live readiness for step n, listed check by check (the page shows each one). */
export async function readiness(provider, entry, state, n) {
  const step = state.steps[n - 1];
  const request = step.request;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  const chainId = BigInt(await provider.send("eth_chainId", []));
  add("Chain is Avalanche C-Chain (43114)", chainId === BigInt(MAINNET_CHAIN_ID), `RPC reports ${chainId}`);
  const [latest, pending, code, balance, feeData] = await Promise.all([
    provider.getTransactionCount(MAINNET_DEPLOYER, "latest"), provider.getTransactionCount(MAINNET_DEPLOYER, "pending"),
    provider.getCode(MAINNET_DEPLOYER), provider.getBalance(MAINNET_DEPLOYER), provider.getFeeData(),
  ]);
  add("Deployer is an ordinary account", code === "0x", MAINNET_DEPLOYER);
  add(`Deployer nonce is ${request.nonce}`, latest === request.nonce, `latest ${latest}`);
  add("No pending deployer transaction", latest === pending, `pending ${pending}`);
  for (const target of emptyBefore(entry, n)) add(`Nothing deployed yet at ${target}`, (await provider.getCode(target)) === "0x", target);
  const remaining = state.steps.slice(n - 1).reduce((sum, item) => sum + BigInt(item.request.gasLimit), 0n);
  const price = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
  const needed = remaining * price;
  add("Deployer can pay the gas for the remaining steps", balance >= needed, `holds ${formatEther(balance)} AVAX, needs up to ${formatEther(needed)} AVAX`);
  return { ready: checks.every((check) => check.ok), checks, needed: formatEther(needed), balance: formatEther(balance) };
}

/** The exact transaction for Rabby, after the shared pre-sign checks. Marks the step as requested. */
export async function requestApproval(provider, entry, state, n) {
  const step = state.steps[n - 1];
  if (state.steps.some((item) => item.status === "failed")) throw new Error("A step failed verification. Nothing more is offered.");
  if (state.steps.slice(0, n - 1).some((item) => item.status !== "confirmed")) throw new Error(`Step ${n} is offered only after every earlier step is confirmed.`);
  if (step.status !== "prepared") throw new Error(`Step ${n} is ${step.status}.`);
  await assertReadyToSign(provider, step.request, emptyBefore(entry, n));
  step.status = "awaiting-wallet";
  return walletTransaction(step.request);
}

/** Rabby returned a hash: the transaction is submitted (not yet confirmed). */
export function recordSubmitted(state, n, hash) {
  const step = state.steps[n - 1];
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(hash || ""))) throw new Error("A 32-byte transaction hash is required.");
  if (state.steps.slice(0, n - 1).some((item) => item.status !== "confirmed")) throw new Error(`Step ${n} is accepted only after every earlier step is confirmed.`);
  if (!["prepared", "awaiting-wallet", "submitted"].includes(step.status)) throw new Error(`Step ${n} is ${step.status}.`);
  step.status = "submitted";
  step.hash = hash;
  step.error = null;
}

/** The owner rejected the request in Rabby: back to prepared, nothing was signed. */
export function recordRejected(state, n) {
  const step = state.steps[n - 1];
  if (step.status === "awaiting-wallet") step.status = "prepared";
}

/** Waits for the receipt and verifies it from the public RPC, independently of the wallet. */
export async function confirmStep(provider, entry, state, n, { timeoutMs = 120_000 } = {}) {
  const step = state.steps[n - 1];
  if (step.status !== "submitted") throw new Error(`Step ${n} has no submitted transaction.`);
  try {
    const mined = await verifyCreationTransaction(provider, step.request, step.hash, { timeoutMs });
    let facts = {};
    if (entry.kind === "release-per-contract-mainnet") {
      const result = n === 1 ? await checkFactoryState(provider, entry.plan, mined.address) : await checkMarketplaceState(provider, entry.plan, mined.address);
      if (result.problems.length) throw new Error(`The mined contract does not match the approved plan: ${result.problems.join("; ")}.`);
      facts = result.facts;
    }
    step.verified = { ...mined, ...facts };
    step.status = "confirmed";
    step.error = null;
  } catch (error) {
    if (error instanceof NotMinedYetError) { step.error = "Not confirmed yet. Check again shortly."; return step; }
    step.status = "failed";
    step.error = error.message;
  }
  return step;
}

/** The one thing to do next. */
export function nextAction(entry, state, { connected, ready }) {
  const failed = state.steps.find((step) => step.status === "failed");
  if (failed) return `Stop. Step ${failed.request.step} failed verification: ${failed.error}`;
  const current = state.steps.find((step) => step.status !== "confirmed");
  if (!current) return `All steps are confirmed. Run the GitHub verification (${VERIFY_WORKFLOW_URL}) with the transaction hashes below, then send them to Claude for the record PR.`;
  const n = current.request.step;
  if (current.status === "submitted") return `Step ${n} is submitted. Wait for confirmation; the page checks the chain.`;
  if (current.status === "awaiting-wallet") return `Approve or reject step ${n} in the Rabby window.`;
  if (!connected) return "Press Connect Rabby (deployer account, Avalanche C-Chain).";
  if (ready && !ready.ready) return `Step ${n} is blocked: ${ready.checks.filter((check) => !check.ok).map((check) => `${check.name} (${check.detail})`).join("; ")}. Fix it, then press Re-check.`;
  return `Review step ${n}, tick its box and press "Request approval in Rabby".`;
}

export const sameAddress = (a, b) => {
  try { return getAddress(a) === getAddress(b); } catch { return false; }
};

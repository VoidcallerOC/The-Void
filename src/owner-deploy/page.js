import { JsonRpcProvider, keccak256 } from "ethers";
import { MAINNET_FEE_RECIPIENT } from "../../scripts/mainnet-signing-requests.mjs";
import { profileFor } from "../../scripts/network-profiles.mjs";
import { STEP_STATUS, VERIFY_WORKFLOW_URL, confirmStep, connectionCheck, initialState, loadApprovedPlans, nextAction, readiness, recordRejected, recordSubmitted, requestApproval, rpcFromQuery } from "./flow.js";

// Browser glue shared by owner-deploy.html (mainnet) and fuji-rabby-test.html (Fuji test). Each entry
// passes its own network and only its own network's approved plans. The page never asks the wallet to
// switch network. The logic and every check are in flow.js and the shared modules.
const RABBY_RDNS = "io.rabby";
const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function startPage(network, planModules) {
const profile = profileFor(network);
const MAINNET = network === "mainnet";
const plans = loadApprovedPlans(planModules, network);
const announced = new Map();
window.addEventListener("eip6963:announceProvider", (event) => {
  const detail = event.detail;
  if (detail?.info && detail?.provider) announced.set(detail.info.rdns, detail);
});
window.dispatchEvent(new Event("eip6963:requestProvider"));

let rpc;
try {
  rpc = rpcFromQuery(window.location.search, profile);
} catch (error) {
  rpc = null;
  $("next").innerHTML = `<p class="bad">${esc(error.message)}</p>`;
}
const provider = rpc ? new JsonRpcProvider(rpc.url, profile.chainId, { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1 }) : null;
const usable = plans.find((item) => !item.error);
const entry = usable?.entry ?? null;
const storageKey = entry ? `the-void-owner-deploy:${network}:${entry.binding.digest}` : null;
const loadHashes = () => { try { return JSON.parse(window.localStorage.getItem(storageKey) || "{}"); } catch { return {}; } };
const saveHashes = () => {
  try { window.localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(state.steps.filter((s) => s.hash).map((s) => [s.request.step, s.hash])))); } catch { /* storage unavailable: hashes stay on screen */ }
};
const state = entry ? initialState(entry, loadHashes()) : null;
let rabby = null;
let connected = false;
let ready = null;

function findRabby() {
  if (announced.has(RABBY_RDNS)) return announced.get(RABBY_RDNS).provider;
  if (window.ethereum?.isRabby === true) return window.ethereum;
  return null;
}

function renderPlan() {
  if (!entry) {
    $("plan").innerHTML = `<p class="bad">No approved plan is available.</p>${plans.map((item) => `<p class="muted">${esc(item.path)}: ${esc(item.error)}</p>`).join("")}
      <p>A plan is approved by merging the GitHub pull request that adds it under <code>${esc(profile.plansDir)}/</code>. Ask Claude to prepare one.</p>`;
    return;
  }
  const { plan, binding } = entry;
  const rows = (plan.transactions || [{ step: 1, contract: plan.probe.contract, predictedAddress: plan.probe.predictedAddress, nonce: plan.deployer.nonce, constructor: { label: plan.probe.label } }]).map((tx) => `<tr><td>Step ${tx.step}</td><td>${esc(tx.contract)} at <code>${esc(tx.predictedAddress)}</code> (nonce ${tx.nonce})<br><span class="muted">constructor ${esc(JSON.stringify(tx.constructor))}</span></td></tr>`).join("");
  $("plan").innerHTML = `<p class="ok">Plan prepared and approved in GitHub; its binding was re-checked in this browser.</p>
    <table>
      <tr><td>Kind</td><td>${esc(entry.kind)}</td></tr>
      <tr><td>Chain</td><td>${esc(profile.name)} (${profile.chainId})</td></tr>
      <tr><td>Deployer (Rabby)</td><td><code>${esc(profile.deployer)}</code></td></tr>
      ${MAINNET ? `<tr><td>Fee recipient</td><td><code>${esc(MAINNET_FEE_RECIPIENT)}</code> <span class="muted">(Nano S Plus; passive, signs nothing)</span></td></tr>` : `<tr><td>Purpose</td><td class="warn">${esc(plan.purpose)}</td></tr>
      <tr><td>Maximum cost</td><td>${esc(plan.cost.maxCostWei)} wei of Fuji test AVAX (no real value)</td></tr>`}
      <tr><td>Planned on commit</td><td><code>${esc(binding.sourceCommit)}</code></td></tr>
      <tr><td>Binding</td><td><code>${esc(binding.digest)}</code></td></tr>
      ${rows}
      <tr><td>Artifacts</td><td><code>${esc(JSON.stringify(plan.artifacts ?? { initCodeHash: plan.probe?.initCodeHash, runtimeCodeHash: plan.probe?.runtimeCodeHash }))}</code></td></tr>
    </table>`;
}

function renderReadiness() {
  if (!ready) { $("readiness").innerHTML = `<p class="muted">Not checked yet.</p><button id="recheck">Check now</button>`; return; }
  $("readiness").innerHTML = `<table>${ready.checks.map((c) => `<tr><td class="${c.ok ? "ok" : "bad"}">${c.ok ? "PASS" : "FAIL"}</td><td>${esc(c.name)} <span class="muted">${esc(c.detail)}</span></td></tr>`).join("")}</table>
    <button id="recheck">Re-check</button>`;
}

function renderSteps() {
  $("steps").innerHTML = state.steps.map((step) => {
    const n = step.request.step;
    const earlier = state.steps.slice(0, n - 1).every((s) => s.status === "confirmed");
    const canRequest = connected && earlier && step.status === "prepared" && ready?.ready && !state.steps.some((s) => s.status === "failed");
    const cls = step.status === "confirmed" ? "ok" : step.status === "failed" ? "bad" : "warn";
    return `<div class="box">
      <p class="status">Step ${n}: ${esc(step.request.contract)} — <span class="${cls}">${esc(STEP_STATUS[step.status])}</span></p>
      <table>
        <tr><td>Type</td><td>Contract creation (no recipient), value 0 AVAX</td></tr>
        <tr><td>From</td><td><code>${esc(step.request.from)}</code></td></tr>
        <tr><td>Nonce</td><td>${step.request.nonce}</td></tr>
        <tr><td>Creates</td><td><code>${esc(step.request.predictedAddress)}</code></td></tr>
        <tr><td>Creation data</td><td>${(step.request.data.length - 2) / 2} bytes, keccak256 <code>${esc(step.request.dataHash)}</code></td></tr>
        <tr><td>Gas limit</td><td>${esc(step.request.gasLimit)}</td></tr>
        ${step.hash ? `<tr><td>Transaction</td><td><code>${esc(step.hash)}</code> <a href="${profile.explorer}/tx/${esc(step.hash)}" target="_blank" rel="noreferrer">Snowtrace</a></td></tr>` : ""}
        ${step.error ? `<tr><td>Note</td><td class="${step.status === "failed" ? "bad" : "warn"}">${esc(step.error)}</td></tr>` : ""}
      </table>
      ${step.status === "prepared" && earlier ? `<p><label><input type="checkbox" id="review-${n}"> I reviewed step ${n}: ${esc(profile.name)}, from the deployer, nonce ${step.request.nonce}, creating ${esc(step.request.predictedAddress)}, value 0.</label></p>
        <button data-request="${n}" ${canRequest ? "" : "disabled"}>Request approval in Rabby</button>
        <p class="muted">Already sent from Rabby (for example after a page reload)? Paste its hash instead of signing again:</p>
        <input type="text" id="hash-${n}" placeholder="0x…"><button data-hash="${n}">Use this hash</button>` : ""}
      ${step.status === "submitted" ? `<button data-confirm="${n}">Check confirmation now</button>` : ""}
      ${step.verified ? `<details open><summary class="ok">Verified on chain</summary><pre>${esc(JSON.stringify(step.verified, null, 2))}</pre></details>` : ""}
    </div>`;
  }).join("");
}

function renderResult() {
  const done = state.steps.filter((s) => s.status === "confirmed");
  if (!done.length) return;
  const hashes = state.steps.map((s) => s.hash).filter(Boolean).join(",");
  $("result").innerHTML = done.length === state.steps.length && !MAINNET
    ? `<p class="ok">Fuji test passed: confirmed and verified in this browser.</p><p>Send this hash to Claude for the test record:</p><pre>${esc(hashes)}</pre>`
    : done.length === state.steps.length
    ? `<p class="ok">All steps confirmed and verified in this browser.</p>
      <p>Final check in GitHub (no key; re-checks the deployed code against the compiled source): open <a href="${VERIFY_WORKFLOW_URL}" target="_blank" rel="noreferrer">Verify mainnet deployment</a>, press <strong>Run workflow</strong>, choose kind <code>${esc(entry.kind)}</code> and paste these hashes:</p>
      <pre>${esc(hashes)}</pre><p>Then send the hashes to Claude for the record PR.</p>`
    : `<p class="muted">${done.length} of ${state.steps.length} confirmed. Hashes so far:</p><pre>${esc(hashes)}</pre>`;
}

function render() {
  renderPlan();
  if (!state) { $("next").innerHTML = `<p class="bad">No approved plan. Nothing can be signed.</p>`; return; }
  $("next").innerHTML = `<p class="status">Next</p><p>${esc(nextAction(entry, state, { connected, ready }))}</p>`;
  renderReadiness();
  renderSteps();
  renderResult();
}

function currentStep() {
  return state.steps.find((s) => s.status !== "confirmed")?.request.step ?? null;
}

async function recheck() {
  const n = currentStep();
  ready = n ? await readiness(provider, entry, state, n) : null;
  render();
}

async function connect() {
  rabby = findRabby();
  let account = null;
  let chainId = null;
  if (rabby) {
    [account] = await rabby.request({ method: "eth_requestAccounts" });
    chainId = Number(BigInt(await rabby.request({ method: "eth_chainId" })));
  }
  const check = connectionCheck(profile, { rabbyFound: Boolean(rabby), account, chainId });
  connected = check.ok;
  $("wallet").innerHTML = `<table>${check.checks.map((c) => `<tr><td class="${c.ok ? "ok" : "bad"}">${c.ok ? "PASS" : "FAIL"}</td><td>${esc(c.name)} <span class="muted">${esc(c.detail)}</span></td></tr>`).join("")}</table>
    ${connected
      ? `<p class="ok">Connected: Rabby, deployer ${esc(profile.deployer)}, ${esc(profile.name)}. Nothing was signed.</p>`
      : `<p class="bad">${rabby ? `In Rabby, select the deployer ${esc(profile.deployer)} and ${esc(profile.name)} yourself, then connect again. This page never switches the network for you, and no other account may sign.` : "Rabby was not detected in this browser. Install or unlock the Rabby extension, then reload. Other wallets are not used."}</p>`}`;
  render();
}

async function request(n) {
  if (!$(`review-${n}`)?.checked) { alert(`Tick step ${n}'s review box first.`); return; }
  const [account] = await rabby.request({ method: "eth_accounts" });
  const chainId = Number(BigInt(await rabby.request({ method: "eth_chainId" })));
  if (!connectionCheck(profile, { rabbyFound: true, account, chainId }).ok) { connected = false; await connect(); return; }
  const tx = await requestApproval(provider, entry, state, n);
  if (keccak256(tx.data) !== state.steps[n - 1].request.dataHash) throw new Error("The transaction data does not match the approved plan.");
  render();
  let hash;
  try {
    hash = await rabby.request({ method: "eth_sendTransaction", params: [tx] });
  } catch (error) {
    recordRejected(state, n);
    render();
    alert(error?.code === 4001
      ? `You rejected step ${n} in Rabby. Nothing was signed.`
      : `Rabby returned an error for step ${n}: ${error?.message || error}. Check Rabby's activity before anything else: if it sent the transaction, paste its hash into step ${n}. Do not sign again.`);
    return;
  }
  await submitted(n, hash);
}

async function submitted(n, hash) {
  recordSubmitted(state, n, hash);
  saveHashes();
  render();
  await confirmStep(provider, entry, state, n);
  if (state.steps[n - 1].status === "confirmed") await recheck().catch(() => {});
  render();
}

if (rpc?.override) $("rpc-warning").innerHTML = `<div class="box bad">Using a local RPC (${esc(rpc.url)}), not Avalanche's public endpoint. This is for a local rehearsal only.</div>`;
if (state) {
  $("connect").addEventListener("click", () => connect().catch((error) => { $("wallet").innerHTML = `<span class="bad">${esc(error.message || error)}</span>`; }));
  document.body.addEventListener("click", (event) => {
    const fail = (error) => { alert(error.message || error); render(); };
    const target = event.target;
    if (target.id === "recheck") recheck().catch(fail);
    if (target.dataset.request) { target.disabled = true; request(Number(target.dataset.request)).catch(fail); }
    if (target.dataset.hash) { const n = Number(target.dataset.hash); submitted(n, $(`hash-${n}`).value.trim()).catch(fail); }
    if (target.dataset.confirm) { const n = Number(target.dataset.confirm); confirmStep(provider, entry, state, n).then(async () => { if (state.steps[n - 1].status === "confirmed") await recheck(); render(); }).catch(fail); }
  });
  render();
  // Steps submitted before a reload are re-checked from the chain, in order.
  (async () => {
    for (const step of state.steps) {
      if (step.status !== "submitted") break;
      await confirmStep(provider, entry, state, step.request.step);
      render();
      if (step.status !== "confirmed") break;
    }
    if (provider) await recheck();
  })().catch((error) => { $("readiness").innerHTML = `<p class="bad">${esc(error.message || error)}</p><button id="recheck">Re-check</button>`; });
} else {
  render();
}
}

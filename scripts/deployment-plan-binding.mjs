// Binds the owner's Rabby signing session to the dry-run plan that was reviewed. A binding is the
// commit plus the plan fields that decide what will be signed, including the hash of every unsigned
// creation transaction. The signing tool (scripts/mainnet-owner-signing.mjs) re-plans without any key
// and refuses to hand a transaction to the wallet unless the fresh plan produces the identical binding
// on the same commit. Volatile fields (balance, gas price, gas estimates) are excluded; funding and
// the nonce are re-checked live before each signature. Reads only local files; no keys.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { requestBindingFields } from "./mainnet-signing-requests.mjs";

export class BindingError extends Error {}

/** Each request must agree with the plan it belongs to: same deployer, nonce and predicted address. */
function consistent(requests, expected) {
  requests.forEach((request, index) => {
    const want = expected[index];
    if (request.from !== lower(want.from) || request.nonce !== want.nonce || request.predictedAddress !== lower(want.predictedAddress)) {
      throw new BindingError(`Signing request ${index + 1} disagrees with the plan's deployer, nonce or predicted address.`);
    }
  });
  return requests;
}

function signingRequests(plan, count) {
  if (!Array.isArray(plan.signingRequests) || plan.signingRequests.length !== count) throw new BindingError(`The plan must carry exactly ${count} unsigned signing request(s); name the fee recipient and re-plan.`);
  return plan.signingRequests.map((request) => {
    if (request.chainId !== 43114 || request.to !== null || String(request.value) !== "0") throw new BindingError("A signing request must be a zero-value contract creation on chain 43114.");
    return requestBindingFields(request);
  });
}

const lower = (value) => (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value) ? value.toLowerCase() : value);

/** The deployment-defining fields of a plan, per workflow kind. */
export const BINDERS = Object.freeze({
  "release-per-contract-mainnet": (plan) => {
    if (plan.mode !== "DRY_RUN" || plan.network !== "mainnet" || plan.chainId !== 43114) throw new BindingError("Not a C-Chain mainnet dry-run plan.");
    if (plan.readyToBroadcast !== true) {
      const failing = (plan.checks || []).filter((check) => check.status === "FAIL" || check.status === "BLOCKED").map((check) => `${check.check}${check.value && typeof check.value === "object" ? ` ${JSON.stringify(check.value)}` : ""}`);
      throw new BindingError(`The dry-run plan is not ready to sign. Failing: ${failing.join("; ") || "no expected deployer nonce given"}.`);
    }
    return {
      chainId: plan.chainId,
      deployer: lower(plan.deployer?.address),
      deployerNonce: plan.deployer?.nonce,
      artifacts: {
        factoryInitCodeHash: plan.artifacts?.factory?.initCodeHash,
        implementationRuntimeCodeHash: plan.artifacts?.implementation?.runtimeCodeHash,
        marketplaceInitCodeHash: plan.artifacts?.marketplace?.initCodeHash,
      },
      transactions: (plan.transactions || []).map((tx) => ({
        step: tx.step, nonce: tx.nonce, contract: tx.contract, constructor: tx.constructor,
        predictedAddress: lower(tx.predictedAddress), predictedImplementation: lower(tx.predictedImplementation ?? null),
      })),
      constructorArgsEncoded: plan.constructorArgsEncoded,
      signingRequests: consistent(signingRequests(plan, 2), (plan.transactions || []).map((tx) => ({ from: plan.deployer?.address, nonce: tx.nonce, predictedAddress: tx.predictedAddress }))),
    };
  },
  "genesis-claim-mainnet": (plan) => {
    if (plan.mode !== "DRY_RUN" || plan.network !== "mainnet" || plan.chainId !== 43114) throw new BindingError("Not a C-Chain mainnet dry-run plan.");
    return {
      chainId: plan.chainId,
      deployer: lower(plan.deployer),
      deployerNonce: plan.deployerNonce,
      predictedClaimAddress: lower(plan.predictedClaimAddress),
      target: { releaseContract: lower(plan.target?.releaseContract), primarySale: lower(plan.target?.primarySale), tokenId: plan.target?.tokenId },
      schedule: plan.schedule,
      supply: plan.supply,
      roles: { admin: lower(plan.roles?.admin), signer: lower(plan.roles?.signer) },
      eligibilityRule: plan.eligibility?.rule,
      signingRequests: consistent(signingRequests(plan, 1), [{ from: plan.deployer, nonce: plan.deployerNonce, predictedAddress: plan.predictedClaimAddress }]),
      issuerGrantFrom: lower(plan.followUps?.issuerGrant?.from),
    };
  },
});

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

function commitOf(value) {
  const commit = String(value ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new BindingError("A 40-hex commit SHA is required.");
  return commit;
}

export function bindPlan(kind, plan, commit) {
  const binder = BINDERS[kind];
  if (!binder) throw new BindingError(`Unknown plan kind: ${kind}.`);
  const fields = binder(plan);
  const sourceCommit = commitOf(commit);
  const digest = createHash("sha256").update(canonical({ kind, sourceCommit, fields })).digest("hex");
  return { kind, sourceCommit, digest, fields };
}

/** Throws unless the fresh plan, on the same commit, yields exactly the approved binding. */
export function verifyBinding(approved, kind, freshPlan, commit) {
  if (approved?.kind !== kind) throw new BindingError(`The approved binding is for ${approved?.kind ?? "nothing"}, not ${kind}.`);
  const fresh = bindPlan(kind, freshPlan, commit);
  if (approved.sourceCommit !== fresh.sourceCommit) throw new BindingError(`The approved plan was made on ${approved.sourceCommit}, not ${fresh.sourceCommit}.`);
  const changed = Object.keys({ ...approved.fields, ...fresh.fields }).filter((key) => canonical(approved.fields?.[key]) !== canonical(fresh.fields[key]));
  if (changed.length || approved.digest !== fresh.digest) throw new BindingError(`The fresh plan differs from the approved plan: ${changed.join(", ") || "digest"}. Nothing was signed.`);
  return fresh;
}

function option(argv, name) {
  const index = argv.indexOf(`--${name}`);
  if (index < 0 || !argv[index + 1]) throw new BindingError(`--${name} is required.`);
  return argv[index + 1];
}

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

export async function main(argv = process.argv.slice(2)) {
  const [command] = argv;
  const kind = option(argv, "kind");
  if (command === "bind") {
    const binding = bindPlan(kind, await readJson(option(argv, "plan")), option(argv, "commit"));
    await writeFile(option(argv, "out"), `${JSON.stringify(binding, null, 2)}\n`);
    console.log(JSON.stringify({ step: "PLAN_BOUND", kind, sourceCommit: binding.sourceCommit, digest: binding.digest }));
    return binding;
  }
  if (command === "verify") {
    const fresh = verifyBinding(await readJson(option(argv, "approved")), kind, await readJson(option(argv, "plan")), option(argv, "commit"));
    console.log(JSON.stringify({ step: "PLAN_MATCHES_APPROVAL", kind, sourceCommit: fresh.sourceCommit, digest: fresh.digest }));
    return fresh;
  }
  throw new BindingError('Use "bind" or "verify".');
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Deployment plan binding failed: ${error.message}`);
    process.exitCode = 1;
  });
}

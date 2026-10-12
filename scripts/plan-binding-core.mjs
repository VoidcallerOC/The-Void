// Binds the owner's Rabby signing session to the dry-run plan that was reviewed. A binding is the
// commit plus the plan fields that decide what will be signed, including the hash of every unsigned
// creation transaction. The signing tool (scripts/mainnet-owner-signing.mjs) re-plans without any key
// and refuses to hand a transaction to the wallet unless the fresh plan produces the identical binding
// on the same commit. Volatile fields (balance, gas price, gas estimates) are excluded; funding and
// the nonce are re-checked live before each signature. No keys, no I/O: this module also runs in the
// browser (the owner deployment page verifies the approved plan's binding itself).
import { sha256, toUtf8Bytes } from "ethers";
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

function signingRequests(plan, count, chainId = 43114) {
  if (!Array.isArray(plan.signingRequests) || plan.signingRequests.length !== count) throw new BindingError(`The plan must carry exactly ${count} unsigned signing request(s); name the fee recipient and re-plan.`);
  return plan.signingRequests.map((request) => {
    if (request.chainId !== chainId || request.to !== null || String(request.value) !== "0") throw new BindingError(`A signing request must be a zero-value contract creation on chain ${chainId}.`);
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
  // Test only (Fuji). Its own kind, chain and fields: it can never produce a mainnet binding.
  "rabby-probe-fuji": (plan) => {
    if (plan.mode !== "DRY_RUN" || plan.network !== "fuji" || plan.chainId !== 43113) throw new BindingError("Not a Fuji dry-run plan.");
    return {
      chainId: plan.chainId,
      deployer: lower(plan.deployer?.address),
      deployerNonce: plan.deployer?.nonce,
      probe: { contract: plan.probe?.contract, label: lower(plan.probe?.label), predictedAddress: lower(plan.probe?.predictedAddress), initCodeHash: plan.probe?.initCodeHash, runtimeCodeHash: plan.probe?.runtimeCodeHash },
      signingRequests: consistent(signingRequests(plan, 1, 43113), [{ from: plan.deployer?.address, nonce: plan.deployer?.nonce, predictedAddress: plan.probe?.predictedAddress }]),
    };
  },
});

export function canonical(value) {
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
  const digest = sha256(toUtf8Bytes(canonical({ kind, sourceCommit, fields }))).slice(2);
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

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Static checks on the tracked workflows: who can reach DEPLOYER_PRIVATE_KEY, and from where.
// They prove what the YAML does; required reviewers and secret scoping live in GitHub settings
// (deploy/mainnet/DEPLOYMENT-AUTHORITY.md) and cannot be verified from the repository.
const ROOT = resolve(import.meta.dirname, "..");
const WORKFLOWS = resolve(ROOT, ".github/workflows");
const read = (path) => readFileSync(resolve(ROOT, path), "utf8");
const workflowFiles = readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name));
const KEY_REF = /DEPLOYER_PRIVATE_KEY:\s*\$\{\{/;

/** Minimal indentation parser for this repository's workflow layout (2-space YAML). */
function blockAfter(lines, index, indent) {
  const out = [];
  for (let i = index + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() && line.search(/\S/) <= indent) break;
    out.push(line);
  }
  return out;
}
function parseWorkflow(source) {
  const lines = source.split("\n");
  const topEnvIndex = lines.findIndex((line) => line === "env:");
  const topEnv = topEnvIndex < 0 ? [] : blockAfter(lines, topEnvIndex, 0);
  const jobsIndex = lines.findIndex((line) => line === "jobs:");
  const jobLines = blockAfter(lines, jobsIndex, 0);
  const jobs = [];
  jobLines.forEach((line, i) => {
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (!match) return;
    const body = blockAfter(jobLines, i, 2);
    const header = [];
    for (const row of body) { if (/^ {4}steps:/.test(row)) break; header.push(row); }
    const envIndex = header.findIndex((row) => /^ {4}env:/.test(row));
    const steps = [];
    let current = null;
    for (const row of body.slice(body.findIndex((r) => /^ {4}steps:/.test(r)) + 1)) {
      if (/^ {6}- /.test(row)) { current = [row]; steps.push(current); } else if (current) current.push(row);
    }
    jobs.push({
      name: match[1],
      header: header.join("\n"),
      env: envIndex < 0 ? "" : blockAfter(header, envIndex, 4).join("\n"),
      steps: steps.map((rows) => {
        const text = rows.join("\n");
        const envAt = rows.findIndex((row) => /^ {8}env:/.test(row));
        return {
          text,
          name: (/name:\s*(.*)/.exec(rows[0]) || /^ {8}name:\s*(.*)$/m.exec(text) || [])[1] || "",
          if: (/^ {8}if:\s*(.*)$/m.exec(text) || [])[1] || "",
          env: envAt < 0 ? "" : blockAfter(rows, envAt, 8).join("\n"),
        };
      }),
    });
  });
  return { source, topEnv: topEnv.join("\n"), jobs };
}
const workflows = Object.fromEntries(workflowFiles.map((name) => [name, parseWorkflow(readFileSync(resolve(WORKFLOWS, name), "utf8"))]));
const keyWorkflows = Object.entries(workflows).filter(([, wf]) => wf.source.includes("DEPLOYER_PRIVATE_KEY"));
const signingSteps = (wf) => wf.jobs.flatMap((job) => job.steps.filter((step) => KEY_REF.test(step.env)).map((step) => ({ job, step })));

describe("legacy shared-contract mainnet path is retired", () => {
  it("has no workflow, script or package command", () => {
    expect(existsSync(resolve(WORKFLOWS, "deploy-release-v2-mainnet.yml"))).toBe(false);
    expect(existsSync(resolve(ROOT, "scripts/deploy-release-v2-mainnet.mjs"))).toBe(false);
    const scripts = JSON.parse(read("package.json")).scripts;
    expect(scripts["deploy:release-v2-mainnet"]).toBeUndefined();
    for (const wf of Object.values(workflows)) expect(wf.source).not.toMatch(/deploy-release-v2-mainnet|deploy:release-v2-mainnet/);
  });

  it("leaves exactly the two reviewed mainnet broadcast workflows", () => {
    const mainnet = Object.entries(workflows).filter(([, wf]) => /DEPLOY_NETWORK:\s*mainnet/.test(wf.source)).map(([name]) => name).sort();
    expect(mainnet).toEqual(["deploy-genesis-claim-mainnet.yml", "deploy-release-per-contract-mainnet.yml"]);
  });
});

describe("deployer key exposure", () => {
  it("is never injected at workflow or job level", () => {
    for (const [name, wf] of keyWorkflows) {
      expect(wf.topEnv, name).not.toMatch(KEY_REF);
      for (const job of wf.jobs) expect(job.env, `${name}:${job.name}`).not.toMatch(KEY_REF);
    }
  });

  it("never reaches install, build, test, lint or dry-run steps", () => {
    for (const [name, wf] of keyWorkflows) {
      for (const { step } of signingSteps(wf)) {
        expect(step.text, `${name}: ${step.name}`).not.toMatch(/npm ci|forge build|forge test|npm test|npm run lint|npm run build|--dry-run|actions\/checkout/);
      }
    }
  });

  it("is never passed on a command line", () => {
    for (const [name, wf] of Object.entries(workflows)) {
      expect(wf.source, name).not.toMatch(/--private-key/);
      expect(wf.source, name).not.toMatch(/cast wallet address/);
    }
  });

  it("is only available to manually dispatched workflows with read-only token permissions", () => {
    for (const [name, wf] of keyWorkflows) {
      const triggers = wf.source.slice(wf.source.indexOf("\non:"), wf.source.indexOf("\npermissions:"));
      expect(triggers, name).toMatch(/workflow_dispatch:/);
      expect(triggers, name).not.toMatch(/pull_request|push:|schedule:|workflow_run|repository_dispatch/);
      expect(wf.source, name).toMatch(/\npermissions:\n {2}contents: read\n/);
      expect(wf.source, name).not.toMatch(/:\s*write\b|write-all/);
    }
    for (const [name, wf] of Object.entries(workflows)) expect(wf.source, name).not.toMatch(/pull_request_target/);
  });

  it("is gated on main and the exact confirmation in every Fuji signing step", () => {
    for (const [name, wf] of keyWorkflows.filter(([file]) => !file.includes("mainnet"))) {
      for (const { job, step } of signingSteps(wf)) {
        const gate = `${job.header}\n${step.if}`;
        expect(gate, `${name}: ${step.name}`).toMatch(/github\.ref == 'refs\/heads\/main'/);
      }
    }
  });
});

describe("mainnet broadcast requires the protected environment and the reviewed plan", () => {
  const cases = [
    ["deploy-release-per-contract-mainnet.yml", "release-per-contract-mainnet", "I_CONFIRM_CCHAIN_RELEASE_PER_CONTRACT_DEPLOY", "deploy:release-per-contract:mainnet"],
    ["deploy-genesis-claim-mainnet.yml", "genesis-claim-mainnet", "I_CONFIRM_CCHAIN_GENESIS_CLAIM_DEPLOY", "deploy:genesis-claim"],
  ];
  for (const [file, kind, confirmation, command] of cases) {
    it(`${file}: plan job is key-less; broadcast job is environment-gated and signs last`, () => {
      const wf = workflows[file];
      const dispatch = wf.source.slice(wf.source.indexOf("broadcast_deployment:"));
      expect(dispatch.slice(0, 200)).toMatch(/type: boolean\n\s+default: false/);
      const plan = wf.jobs.find((job) => job.name === "plan");
      const broadcast = wf.jobs.find((job) => job.name === "broadcast");
      expect(wf.jobs.map((job) => job.name)).toEqual(["plan", "broadcast"]);
      expect(plan.header).toMatch(/if: github\.ref == 'refs\/heads\/main'/);
      expect(plan.header).not.toMatch(/environment:/);
      expect(`${plan.header}\n${plan.steps.map((step) => step.text).join("\n")}`).not.toMatch(/DEPLOYER_PRIVATE_KEY/);
      expect(plan.steps.some((step) => step.text.includes(`npm run ${command} -- --dry-run`))).toBe(true);
      expect(plan.steps.some((step) => step.text.includes(`deployment-plan-binding.mjs bind --kind ${kind}`))).toBe(true);

      expect(broadcast.header).toMatch(/needs: plan/);
      expect(broadcast.header).toMatch(/environment: mainnet-deployment/);
      expect(broadcast.header).toMatch(new RegExp(`if: github\\.ref == 'refs/heads/main' && inputs\\.broadcast_deployment && inputs\\.confirm_mainnet_deploy == '${confirmation}'`));
      expect(broadcast.header).toMatch(/permissions:\n {6}contents: read/);
      const checkout = broadcast.steps.find((step) => step.text.includes("actions/checkout"));
      expect(checkout.text).toContain("ref: ${{ github.sha }}");
      expect(checkout.text).toContain("persist-credentials: false");

      const signing = signingSteps(wf);
      expect(signing).toHaveLength(1);
      expect(signing[0].job.name).toBe("broadcast");
      const signIndex = broadcast.steps.indexOf(signing[0].step);
      const verifyIndex = broadcast.steps.findIndex((step) => step.text.includes(`deployment-plan-binding.mjs verify --kind ${kind}`));
      expect(verifyIndex).toBeGreaterThan(-1);
      expect(verifyIndex).toBeLessThan(signIndex);
      expect(broadcast.steps[verifyIndex].env).toMatch(/BROADCAST_DEPLOYMENT: "no"/);
      expect(broadcast.steps[verifyIndex].env).not.toMatch(KEY_REF);
      expect(signing[0].step.text).toContain(`npm run ${command} |`);
      expect(signing[0].step.env).toMatch(/BROADCAST_DEPLOYMENT: "yes"/);
      // Steps after signing only upload the record.
      for (const step of broadcast.steps.slice(signIndex + 1)) expect(step.text).toMatch(/actions\/upload-artifact/);
      // The workflow-level confirmation still reaches the script's own guard.
      expect(wf.topEnv).toContain(`inputs.confirm_mainnet_deploy == '${confirmation}' && 'yes' || 'no'`);
    });
  }
});

describe("mainnet authorization and Fuji state are untouched", () => {
  it("keeps the mainnet manifest undeployed, unauthorized and on the passive fee recipient", () => {
    const manifest = JSON.parse(read("config/mainnet-release-per-contract.json"));
    expect(manifest).toMatchObject({ chainId: 43114, deployed: false, deploymentAuthorized: false, provisioningEnabled: false, factoryAddress: null, implementationAddress: null, marketplaceAddress: null });
    expect(manifest.platformRecipient).toBe("0xb65C575CaE01574296Fab6E620B9A15cC0121ce4");
    expect(manifest.marketplaceFeeRecipient).toBe("0xb65C575CaE01574296Fab6E620B9A15cC0121ce4");
  });

  it("keeps the Fuji rehearsal record and the recorded Fuji factory", () => {
    const record = JSON.parse(read("deployments/fuji-royalty-rehearsal-0x0459DcB0d1ccf198004C32BdBA381d5aB4c1D338.json"));
    expect(record.deployments.factory.address).toBe("0x0459DcB0d1ccf198004C32BdBA381d5aB4c1D338");
    expect(record.checks.every((check) => check.status === "PASS")).toBe(true);
    expect(JSON.parse(read("config/fuji-release-per-contract-v2.json")).factoryAddress).toBe("0x3e4E0d9187f6fD11bD6d792a7088D0c2dE8E3aC8");
  });
});

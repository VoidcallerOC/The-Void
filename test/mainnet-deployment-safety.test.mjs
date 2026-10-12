import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Static checks on the tracked workflows: who can reach DEPLOYER_PRIVATE_KEY, and from where. Mainnet
// workflows plan only and never hold a key: the mainnet deployer signs in Rabby on the owner's machine
// (deploy/mainnet/OWNER-SIGNING.md). Fuji workflows keep their gated, step-scoped Fuji key.
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
// Workflow text without comment lines: what actually runs.
const executable = (wf) => wf.source.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
// Workflows may run the key-less verify command, never a signing entry point.
const RUNS_SIGNING_TOOL = /sign:mainnet|owner:deploy|mainnet-owner-signing\.mjs (serve|start)/;
const signingSteps = (wf) => wf.jobs.flatMap((job) => job.steps.filter((step) => KEY_REF.test(step.env)).map((step) => ({ job, step })));

describe("legacy shared-contract mainnet path is retired", () => {
  it("has no workflow, script or package command", () => {
    expect(existsSync(resolve(WORKFLOWS, "deploy-release-v2-mainnet.yml"))).toBe(false);
    expect(existsSync(resolve(ROOT, "scripts/deploy-release-v2-mainnet.mjs"))).toBe(false);
    const scripts = JSON.parse(read("package.json")).scripts;
    expect(scripts["deploy:release-v2-mainnet"]).toBeUndefined();
    for (const wf of Object.values(workflows)) expect(wf.source).not.toMatch(/deploy-release-v2-mainnet|deploy:release-v2-mainnet/);
  });

  it("leaves exactly the two reviewed mainnet plan workflows", () => {
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

  it("keeps the mainnet secret name out of every non-mainnet workflow", () => {
    for (const [name, wf] of Object.entries(workflows).filter(([file]) => !file.includes("mainnet"))) expect(wf.source, name).not.toMatch(/MAINNET_DEPLOYER_PRIVATE_KEY/);
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

describe("mainnet workflows plan only: no key, no signing, no broadcast", () => {
  const cases = [
    ["deploy-release-per-contract-mainnet.yml", "release-per-contract-mainnet", "deploy:release-per-contract:mainnet"],
    ["deploy-genesis-claim-mainnet.yml", "genesis-claim-mainnet", "deploy:genesis-claim"],
  ];
  for (const [file, kind, command] of cases) {
    it(`${file}: one key-less plan job that dry-runs and binds the plan`, () => {
      const wf = workflows[file];
      expect(wf.jobs.map((job) => job.name)).toEqual(["plan"]);
      const [plan] = wf.jobs;
      expect(plan.header).toMatch(/if: github\.ref == 'refs\/heads\/main'/);
      // No environment, no signing step, no broadcast, no wallet or key input of any kind.
      expect(wf.source).not.toMatch(/environment:/);
      expect(signingSteps(wf)).toHaveLength(0);
      expect(wf.source).not.toMatch(KEY_REF);
      expect(wf.source).not.toMatch(/BROADCAST_DEPLOYMENT|broadcast_deployment|confirm_mainnet_deploy|recipient_verified_on_device/);
      expect(executable(wf)).not.toMatch(RUNS_SIGNING_TOOL);
      // The only secret reference to a private key is the boolean tripwire that fails the run if a
      // mainnet deployer key exists in GitHub at all.
      expect(wf.source.match(/secrets\.[A-Z_]*PRIVATE_KEY[^}]*/g)).toEqual(["secrets.MAINNET_DEPLOYER_PRIVATE_KEY != '' "]);
      const guard = plan.steps[0];
      expect(guard.env).toContain("MAINNET_KEY_IN_GITHUB: ${{ secrets.MAINNET_DEPLOYER_PRIVATE_KEY != '' }}");
      expect(guard.text).toMatch(/if \[ "\$\{MAINNET_KEY_IN_GITHUB\}" != "false" \]; then[\s\S]*exit 1/);
      expect(plan.steps.some((step) => step.text.includes(`npm run ${command} -- --dry-run`))).toBe(true);
      expect(plan.steps.some((step) => step.text.includes(`deployment-plan-binding.mjs bind --kind ${kind}`))).toBe(true);
      expect(plan.steps.some((step) => step.text.includes("actions/upload-artifact"))).toBe(true);
      const checkout = plan.steps.find((step) => step.text.includes("actions/checkout"));
      expect(checkout.text).toContain("persist-credentials: false");
      // The defined deployer is the default and cannot be swapped silently: the scripts refuse any other.
      expect(wf.source).toContain('default: "0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174"');
    });
  }

  it("no workflow references a mainnet-deployment environment or runs the owner signing tool", () => {
    for (const [name, wf] of Object.entries(workflows)) {
      expect(wf.source, name).not.toMatch(/environment:\s*mainnet-deployment/);
      expect(executable(wf), name).not.toMatch(RUNS_SIGNING_TOOL);
    }
  });

  it("no mainnet deployment script can sign: no Wallet from a key and no broadcast path", () => {
    for (const path of ["scripts/deploy-release-per-contract-mainnet.mjs", "scripts/mainnet-owner-signing.mjs", "scripts/mainnet-signing-requests.mjs"]) {
      const source = read(path);
      // No signer is constructed, nothing is signed or sent from Node, and no key variable is read.
      expect(source, path).not.toMatch(/new Wallet\(|\.signTransaction\(|\.sendTransaction\(|eth_sendRawTransaction|\.deploy\(|env\.(MAINNET_)?DEPLOYER_PRIVATE_KEY/);
    }
    // Live checks and verification never reuse a cached RPC answer (ethers caches for 250 ms by default).
    const tool = read("scripts/mainnet-owner-signing.mjs");
    expect(tool.match(/new JsonRpcProvider\([^)]*\)/g).every((call) => call.includes("cacheTimeout: -1"))).toBe(true);
    const scripts = JSON.parse(read("package.json")).scripts;
    expect(scripts["sign:mainnet"]).toBe("node scripts/mainnet-owner-signing.mjs serve");
    expect(scripts["verify:mainnet"]).toBe("node scripts/mainnet-owner-signing.mjs verify");
  });
});

describe("mainnet authorization and Fuji state are untouched", () => {
  it("keeps the mainnet manifest undeployed, unauthorized and on the passive fee recipient", () => {
    const manifest = JSON.parse(read("config/mainnet-release-per-contract.json"));
    expect(manifest).toMatchObject({ chainId: 43114, deployed: false, deploymentAuthorized: false, provisioningEnabled: false, factoryAddress: null, implementationAddress: null, marketplaceAddress: null });
    expect(manifest.platformRecipient).toBe("0xb65C575CaE01574296Fab6E620B9A15cC0121ce4");
    expect(manifest.marketplaceFeeRecipient).toBe("0xb65C575CaE01574296Fab6E620B9A15cC0121ce4");
    // The defined deployer (Rabby) and the artist wallet are fixed and distinct from the fee recipient.
    expect(manifest.deployerAddress).toBe("0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174");
    expect(manifest.artistWallet).toBe("0x284C09a7CC187E096cbbdc88d99DEFE6df32180a");
  });

  it("keeps the Fuji rehearsal record and the recorded Fuji factory", () => {
    const record = JSON.parse(read("deployments/fuji-royalty-rehearsal-0x0459DcB0d1ccf198004C32BdBA381d5aB4c1D338.json"));
    expect(record.deployments.factory.address).toBe("0x0459DcB0d1ccf198004C32BdBA381d5aB4c1D338");
    expect(record.checks.every((check) => check.status === "PASS")).toBe(true);
    expect(JSON.parse(read("config/fuji-release-per-contract-v2.json")).factoryAddress).toBe("0x3e4E0d9187f6fD11bD6d792a7088D0c2dE8E3aC8");
  });
});

describe("browser deployment path: no key anywhere, verification only in CI", () => {
  it("the verify workflow is manual, read-only, key-less and runs only the verify command", () => {
    const wf = workflows["verify-mainnet-deployment.yml"];
    expect(wf.source).toMatch(/\non:\n {2}workflow_dispatch:/);
    expect(wf.source).toMatch(/\npermissions:\n {2}contents: read\n/);
    expect(wf.source).not.toMatch(/secrets\.|PRIVATE_KEY|environment:|:\s*write\b/);
    expect(executable(wf)).toMatch(/mainnet-owner-signing\.mjs verify/);
    expect(executable(wf)).not.toMatch(RUNS_SIGNING_TOOL);
  });

  it("the owner page asks for no key and signs only through the wallet", () => {
    const page = ["owner-deploy.html", "fuji-rabby-test.html", "src/owner-deploy/main.js", "src/owner-deploy/fuji-main.js", "src/owner-deploy/page.js", "src/owner-deploy/flow.js", "scripts/fuji-rabby-probe.mjs"].map(read).join("\n");
    expect(page).not.toMatch(/private ?key|mnemonic|seed phrase|new Wallet\(|signTransaction|eth_sendRawTransaction|sendTransaction\(/i);
    expect(page).toContain('method: "eth_sendTransaction"');
    expect(read("vercel.json")).toContain('"destination": "/owner-deploy.html"');
  });
});


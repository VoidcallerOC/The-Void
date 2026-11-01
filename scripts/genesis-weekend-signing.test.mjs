import { existsSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import * as ethers from "ethers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLAN, compareDeployState, covers, maskImmutables, runtimeMatches, verifyManifest } from "../deploy/mainnet/genesis-weekend/signing/core.js";
import { buildWeekendTree } from "../server/genesis-weekend-merkle.js";
import { createConnection } from "node:net";
import { CSP, FILES, HOST, checkSums, createSigningServer, loadFiles } from "./genesis-weekend-signing-server.mjs";

const DIR = "deploy/mainnet/genesis-weekend";
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const manifest = read(`${DIR}/signing/manifest.json`);
const artifact = read(`${DIR}/GenesisWeekendClaim.artifact.json`);
const snapshot = read(`${DIR}/snapshot.json`);
const clone = (value) => JSON.parse(JSON.stringify(value));

describe("committed signing manifest", () => {
  it("verifies against the committed artifact and the reviewed plan", () => {
    expect(verifyManifest(ethers, manifest, artifact)).toEqual([]);
  });

  it("uses the committed snapshot root, hash, count and blocks", () => {
    expect(manifest.snapshot.merkleRoot).toBe(snapshot.merkleRoot);
    expect(manifest.snapshot.snapshotHash).toBe(snapshot.snapshotHash);
    expect(Number(manifest.snapshot.eligibleWallets)).toBe(snapshot.eligible.length);
    expect(String(manifest.snapshot.cchainBlock)).toBe(String(snapshot.cchain.block));
    expect(String(manifest.snapshot.grottoBlock)).toBe(String(snapshot.grotto.block));
    expect(buildWeekendTree(snapshot.eligible.map((entry) => entry.wallet)).root).toBe(manifest.constructorArgs.merkleRoot);
    expect(manifest.constructorArgs.activationDeadline).toBe("1793768399");
    expect(manifest.constructorArgs).not.toHaveProperty("claimEnd");
    expect(manifest.expectedAfterDeploy).toMatchObject({ claimStart: "0", claimEnd: "0", activationDeadline: "1793768399", CLAIM_DURATION: "86400" });
    expect(manifest.constructorArgs.baselineClaimedSupply).toBe("4");
  });

  it("pins the reviewed gas ceilings", () => {
    expect(manifest.deploy.gasCeiling).toBe("2000000");
    expect(manifest.revokes.map((r) => r.gasCeiling)).toEqual(["60000", "60000"]);
    expect(manifest.grant.gasCeiling).toBe("80000");
    expect(manifest.activate.gasCeiling).toBe("180000");
  });

  it("artifact bytecode hashes match the artifact contents", () => {
    expect(ethers.keccak256(artifact.bytecode)).toBe(artifact.bytecodeKeccak256);
    expect(ethers.keccak256(artifact.deployedBytecode)).toBe(artifact.deployedBytecodeKeccak256);
    expect(artifact.sourceCommit).toBe("12cc4694b4ce50021318c53fd19de5ea95738576");
    // The artifact was built from exactly the committed contract source.
    expect(artifact.sourceKeccak256).toBe(ethers.keccak256(readFileSync("contracts/GenesisWeekendClaim.sol")));
  });

  it("artifact source hash matches contracts/GenesisWeekendClaim.sol", () => {
    expect(ethers.keccak256(readFileSync("contracts/GenesisWeekendClaim.sol"))).toBe(artifact.sourceKeccak256);
  });
});

describe("manifest tampering is rejected", () => {
  const cases = {
    "wrong chain": (m) => { m.chainId = 43113; },
    "wrong signer": (m) => { m.signer = "0x0000000000000000000000000000000000000001"; },
    "changed activation deadline": (m) => { m.constructorArgs.activationDeadline = "1793768400"; },
    "changed baseline": (m) => { m.constructorArgs.baselineClaimedSupply = "5"; },
    "changed admin": (m) => { m.constructorArgs.admin = "0x0000000000000000000000000000000000000001"; },
    "changed root": (m) => { m.constructorArgs.merkleRoot = `0x${"11".repeat(32)}`; },
    "changed deploy data": (m) => { m.deploy.data = `${m.deploy.data.slice(0, -2)}01`; },
    "extra revoke": (m) => { m.revokes.push(m.revokes[0]); },
    "revoke calldata swapped to grant": (m) => {
      m.revokes[0].data = new ethers.Interface(["function grantRole(bytes32,address)"]).encodeFunctionData("grantRole", [ethers.id("ISSUER_ROLE"), PLAN.revokeTargets[0]]);
    },
    "revoke of the sale": (m) => { m.revokes[0].target = PLAN.sale; },
    "wrong role id": (m) => { m.roles.issuerRole = ethers.id("DEFAULT_ADMIN_ROLE"); },
    "failing generation": (m) => { m.ok = false; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    it(name, () => {
      const tampered = clone(manifest);
      mutate(tampered);
      expect(verifyManifest(ethers, tampered, artifact).length).toBeGreaterThan(0);
    });
  }

  it("tampered artifact bytecode", () => {
    const bad = clone(artifact);
    bad.bytecode = `${bad.bytecode.slice(0, -2)}00`;
    expect(verifyManifest(ethers, manifest, bad).length).toBeGreaterThan(0);
  });
});

describe("runtime comparison helpers", () => {
  it("accepts the artifact runtime with immutables filled and rejects a changed opcode", () => {
    const refs = artifact.immutableReferences;
    const chars = artifact.deployedBytecode.slice(2).split("");
    for (const ranges of Object.values(refs)) for (const { start, length } of ranges) for (let i = start * 2; i < (start + length) * 2; i += 1) chars[i] = "f";
    const filled = `0x${chars.join("")}`;
    expect(runtimeMatches(filled, artifact)).toBe(true);
    expect(maskImmutables(filled, refs)).toBe(maskImmutables(artifact.deployedBytecode, refs));
    const outside = chars.slice();
    const masked = new Set(Object.values(refs).flat().flatMap(({ start, length }) => Array.from({ length: length * 2 }, (_, k) => start * 2 + k)));
    const index = [...outside.keys()].find((i) => i > 10 && !masked.has(i));
    outside[index] = outside[index] === "0" ? "1" : "0";
    expect(runtimeMatches(`0x${outside.join("")}`, artifact)).toBe(false);
    expect(runtimeMatches("0x", artifact)).toBe(false);
  });

  it("compareDeployState flags every difference", () => {
    const expected = manifest.expectedAfterDeploy;
    expect(compareDeployState(expected, { ...expected })).toEqual([]);
    expect(compareDeployState(expected, { ...expected, active: true, claimEnd: "1" })).toHaveLength(2);
  });

  it("covers reserves gas ceiling times max fee", () => {
    expect(covers(10n ** 16n, 2_000_000n, 5_000_000_000n)).toBe(true);
    expect(covers(21_076_961_628_385n, 2_000_000n, 6_000_000_000n)).toBe(false);
  });
});

describe("signing page safety rules", () => {
  const page = readFileSync(`${DIR}/signing/signing.js`, "utf8");
  const core = readFileSync(`${DIR}/signing/core.js`, "utf8");
  const html = readFileSync(`${DIR}/signing/index.html`, "utf8");
  const all = `${page}\n${core}\n${html}`;

  it("asks the wallet only for accounts, chain id and one transaction per click", () => {
    const methods = [...page.matchAll(/method:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(methods)).toEqual(new Set(["eth_requestAccounts", "eth_chainId", "eth_accounts", "eth_sendTransaction"]));
    expect(page.match(/eth_sendTransaction/g)).toHaveLength(1);
    expect(page).toMatch(/async function onSign\(step\)[\s\S]*eth_sendTransaction/);
  });

  it("never handles key material, signatures or approvals", () => {
    for (const forbidden of [/mnemonic/i, /seed phrase.*input/i, /privateKey/i, /new ethers\.Wallet/, /personal_sign/, /eth_sign\b/, /signTypedData/, /eth_signTypedData/, /\bapprove\(/, /setApprovalForAll/, /wallet_switchEthereumChain/]) {
      expect(all).not.toMatch(forbidden);
    }
  });

  it("loads no remote code and contacts no remote host", () => {
    expect(all).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
    expect(html).toMatch(/<script type="module" src="\.\/signing\.js"><\/script>/);
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(page).toMatch(/from "\.\/vendor\/ethers\.min\.js"/);
    expect(html).toContain(CSP);
  });

  it("sends value 0 with the reviewed gas ceiling and no automatic next step", () => {
    expect(page).toMatch(/from: ARTIST, value: "0x0", nonce: toHex\(pending\), gas: toHex\(ready\.ceiling\)/);
    expect(page).not.toMatch(/onSign\([^s)]/);
    expect(page.match(/onSign\(/g)).toHaveLength(2);
  });

  it("re-checks the artist, re-simulates and refuses a second deploy", () => {
    expect(page).toMatch(/async function onSign[\s\S]*await requireArtist\(\);[\s\S]*await simulate\(ready\.tx, ready\.ceiling\)[\s\S]*eth_sendTransaction/);
    expect(page).toMatch(/async function onCheck[\s\S]*await requireArtist\(\);/);
    expect(page).toContain("nonceAtGeneration");
    expect(page).toMatch(/getCreateAddress\(\{ from: ARTIST, nonce: n \}\)/);
  });

  it("gates activation behind the separate authorization phrase", () => {
    expect(page).toContain('"ACTIVATE 24-HOUR CLAIM"');
    expect(page).toContain('$("activateAuthorized").checked');
  });
});

describe("local signing server", () => {
  let server;
  let port;
  const get = (path, host = `127.0.0.1:${port}`) => new Promise((resolve, reject) => {
    const req = request({ host: HOST, port, path, headers: { host } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end();
  });

  beforeAll(async () => {
    server = createSigningServer(loadFiles());
    await new Promise((resolve) => server.listen(0, HOST, resolve));
    port = server.address().port;
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  it("binds loopback only", () => {
    expect(server.address().address).toBe("127.0.0.1");
  });

  it("serves exactly the allowlisted files with the CSP", async () => {
    expect(Object.keys(FILES).sort()).toEqual(["/", "/artifact.json", "/core.js", "/index.html", "/manifest.json", "/signing.js", "/vendor/ethers.min.js"]);
    const page = await get("/");
    expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).toBe(CSP);
    expect((await get("/artifact.json")).body).toBe(readFileSync(`${DIR}/GenesisWeekendClaim.artifact.json`, "utf8"));
  });

  it("served files match the committed SHA256SUMS", () => {
    expect(checkSums(loadFiles())).toEqual([]);
    const files = loadFiles();
    files["/core.js"] = { ...files["/core.js"], sha256: "00" };
    expect(checkSums(files)).toHaveLength(1);
  });

  it("answers a malformed request line without crashing", async () => {
    const reply = await new Promise((resolve, reject) => {
      const socket = createConnection({ host: HOST, port }, () => socket.write("GET http://[ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"));
      let data = "";
      socket.on("data", (chunk) => { data += chunk; socket.end(); });
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });
    expect(reply).toMatch(/^HTTP\/1\.1 (400|403)/);
    expect((await get("/")).status).toBe(200);
  });

  it("refuses other paths, traversal and foreign Host headers", async () => {
    for (const path of ["/../package.json", "/%2e%2e/package.json", "/.env", "/server/index.js", "/vendor/", "/signing"]) {
      expect((await get(path)).status).toBe(404);
    }
    expect((await get("/", "attacker.example")).status).toBe(403);
  });
});

// Cross-check against the Foundry build when `forge test` has produced out/ (CI runs it before vitest).
const FORGE_OUT = join("out", "GenesisWeekendClaim.sol", "GenesisWeekendClaim.json");
const stripMetadata = (hex) => {
  const code = hex.startsWith("0x") ? hex.slice(2) : hex;
  const length = parseInt(code.slice(-4), 16);
  return code.slice(0, code.length - (length + 2) * 2);
};
describe.skipIf(!existsSync(FORGE_OUT))("Foundry build cross-check", () => {
  it("forge bytecode equals the committed artifact (metadata stripped)", () => {
    const forge = read(FORGE_OUT);
    expect(stripMetadata(forge.bytecode.object)).toBe(stripMetadata(artifact.bytecode));
    expect(stripMetadata(forge.deployedBytecode.object)).toBe(stripMetadata(artifact.deployedBytecode));
  });
});

// Reproducible build of the reviewed GenesisWeekendClaim artifact with solc-js 0.8.24.
//
//   npm install --prefix /tmp/solc-0.8.24 solc@0.8.24
//   node scripts/genesis-weekend-artifact.mjs --solc /tmp/solc-0.8.24/node_modules/solc --source-commit <commit> \
//     [--out deploy/mainnet/genesis-weekend/GenesisWeekendClaim.artifact.json]
//
// Settings match foundry.toml and the previously reviewed artifact: optimizer on, 200 runs, cancun, ipfs metadata
// hash, source key contracts/GenesisWeekendClaim.sol. Rebuilding the reviewed artifact from cc1535f with this
// script reproduces initcode keccak 0x1119432e…d3f6 and runtime keccak 0x19b07b54…8c98 exactly.
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import process from "node:process";
import { keccak256 } from "ethers";

const SOURCE_KEY = "contracts/GenesisWeekendClaim.sol";
const COMPILER = "0.8.24+commit.e11b9ed9.Emscripten.clang";

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
}

export function buildArtifact(solc, content, sourceCommit) {
  if (solc.version() !== COMPILER) throw new Error(`solc-js ${solc.version()} is not the reviewed ${COMPILER}.`);
  const settings = {
    optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", metadata: { bytecodeHash: "ipfs" },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences"] } },
  };
  const output = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources: { [SOURCE_KEY]: { content } }, settings })));
  const errors = (output.errors || []).filter(({ severity }) => severity === "error");
  if (errors.length) throw new Error(errors.map(({ formattedMessage }) => formattedMessage).join("\n"));
  const contract = output.contracts[SOURCE_KEY].GenesisWeekendClaim;
  const artifact = {
    contract: "GenesisWeekendClaim", sourcePath: SOURCE_KEY, sourceCommit,
    sourceKeccak256: keccak256(Buffer.from(content)), sourceSha256: crypto.createHash("sha256").update(content).digest("hex"),
    compiler: solc.version(), settings: { optimizer: settings.optimizer, evmVersion: settings.evmVersion, metadata: settings.metadata },
    abi: contract.abi, immutableReferences: contract.evm.deployedBytecode.immutableReferences,
    bytecode: `0x${contract.evm.bytecode.object}`, deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
  };
  artifact.bytecodeKeccak256 = keccak256(artifact.bytecode);
  artifact.deployedBytecodeKeccak256 = keccak256(artifact.deployedBytecode);
  return artifact;
}

const solcPath = argValue("--solc");
const sourceCommit = argValue("--source-commit");
if (!solcPath || !/^[0-9a-f]{40}$/.test(String(sourceCommit))) {
  console.error("Usage: node scripts/genesis-weekend-artifact.mjs --solc <solc-js 0.8.24 module dir> --source-commit <40-hex commit> [--out <path>]");
  process.exit(2);
}
const solc = createRequire(`${solcPath}/package.json`)(solcPath);
const artifact = buildArtifact(solc, fs.readFileSync(SOURCE_KEY, "utf8"), sourceCommit);
const out = argValue("--out");
if (out) fs.writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify({ sourceKeccak256: artifact.sourceKeccak256, bytecodeKeccak256: artifact.bytecodeKeccak256, deployedBytecodeKeccak256: artifact.deployedBytecodeKeccak256 }));

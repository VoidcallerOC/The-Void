import { readFile, mkdir, writeFile } from "node:fs/promises";
import solc from "solc";
const source = await readFile("contracts/VoidRelease1155.sol", "utf8");
const input = { language: "Solidity", sources: { "VoidRelease1155.sol": { content: source } }, settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } } } };
const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors || []).filter((item) => item.severity === "error");
if (errors.length) { console.error(errors.map((item) => item.formattedMessage).join("\n")); process.exit(1); }
const artifact = output.contracts?.["VoidRelease1155.sol"]?.VoidRelease1155;
if (!artifact?.evm?.bytecode?.object) throw new Error("Compilation produced no bytecode.");
await mkdir("out/VoidRelease1155.sol", { recursive: true });
await writeFile("out/VoidRelease1155.sol/VoidRelease1155.json", JSON.stringify({ abi: artifact.abi, bytecode: { object: artifact.evm.bytecode.object }, deployedBytecode: { object: artifact.evm.deployedBytecode.object } }, null, 2) + "\n");
console.log(JSON.stringify({ compiler: solc.version(), bytecodeBytes: artifact.evm.bytecode.object.length / 2, warnings: (output.errors || []).filter((item) => item.severity !== "error").length }, null, 2));

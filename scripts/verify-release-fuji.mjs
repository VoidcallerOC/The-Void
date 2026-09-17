import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { ethers } from "ethers";

const resultPath = process.argv[2];
if (!resultPath) throw new Error("Usage: node scripts/verify-release-fuji.mjs <deployment-result.json>");
const rpcUrl = process.env.AVALANCHE_FUJI_RPC_URL;
const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
const expectedAdmin = process.env.RELEASE_ADMIN_ADDRESS;
if (!rpcUrl || !privateKey || !expectedAdmin) throw new Error("Required deployment environment is missing.");
if (process.env.DEPLOY_NETWORK !== "fuji") throw new Error("Verification is Fuji-only.");

const provider = new ethers.JsonRpcProvider(rpcUrl, 43113, { staticNetwork: true });
const deployer = new ethers.Wallet(privateKey, provider);
const network = await provider.getNetwork();
if (network.chainId !== 43113n) throw new Error(`Unexpected chain ID: ${network.chainId}`);
const admin = ethers.getAddress(expectedAdmin);
if (admin === ethers.ZeroAddress) throw new Error("Zero release admin refused.");
if (deployer.address.toLowerCase() !== admin.toLowerCase()) throw new Error("The funded deployer must equal RELEASE_ADMIN_ADDRESS for the role-protected smoke test.");

const deployment = JSON.parse(await readFile(resultPath, "utf8"));
const address = ethers.getAddress(deployment.contractAddress);
const txHash = deployment.deploymentTransaction;
const receipt = await provider.getTransactionReceipt(txHash);
if (!receipt || receipt.status !== 1) throw new Error("Deployment transaction receipt is missing or unsuccessful.");
if (receipt.to !== null) throw new Error("Deployment transaction is not a contract creation transaction.");
if (receipt.contractAddress?.toLowerCase() !== address.toLowerCase()) throw new Error("Receipt contract address mismatch.");
if (receipt.from.toLowerCase() !== deployer.address.toLowerCase()) throw new Error("Deployment sender mismatch.");
const code = await provider.getCode(address);
if (code === "0x") throw new Error("No deployed bytecode found.");
const artifact = JSON.parse(await readFile("out/VoidRelease1155.sol/VoidRelease1155.json", "utf8"));
const runtimeHash = `0x${createHash("sha256").update(Buffer.from(code.slice(2), "hex")).digest("hex")}`;
const artifactRuntime = artifact.deployedBytecode?.object ? `0x${artifact.deployedBytecode.object.replace(/^0x/, "")}` : null;
const abi = artifact.abi;
const contract = new ethers.Contract(address, abi, deployer);
const roleNames = { DEFAULT_ADMIN_ROLE: ethers.ZeroHash, ARTIST_ROLE: ethers.id("ARTIST_ROLE"), ISSUER_ROLE: ethers.id("ISSUER_ROLE") };
const roles = {};
for (const [name, role] of Object.entries(roleNames)) roles[name] = await contract.hasRole(role, deployer.address);
if (!roles.DEFAULT_ADMIN_ROLE || !roles.ARTIST_ROLE || !roles.ISSUER_ROLE) throw new Error("Deployer does not hold all initial roles.");
if (!(await contract.hasRole(roleNames.DEFAULT_ADMIN_ROLE, admin))) throw new Error("Release admin does not hold DEFAULT_ADMIN_ROLE.");
const supportsInterface = {};
for (const id of ["0x01ffc9a7", "0xd9b67a26", "0x0e89341c"]) supportsInterface[id] = await contract.supportsInterface(id);
if (!Object.values(supportsInterface).every(Boolean)) throw new Error("Required ERC interfaces are not supported.");
if (await contract.paused()) throw new Error("Contract unexpectedly paused after deployment.");

const suffix = `${Date.now()}`;
const releaseId = ethers.encodeBytes32String(`r${suffix.slice(-7)}`);
const editionId = ethers.encodeBytes32String(`e${suffix.slice(-7)}`);
const metadataUri = `ipfs://fuji-smoke-${suffix}`;
const recipient = "0x0000000000000000000000000000000000001234";
const tokenId = await contract.tokenIdFor(releaseId, editionId);
const createTx = await contract.createEdition(releaseId, editionId, 10n, metadataUri);
const createReceipt = await createTx.wait();
const mintTx = await contract.mint(deployer.address, tokenId, 3n, "0x");
const mintReceipt = await mintTx.wait();
if ((await contract.balanceOf(deployer.address, tokenId)) !== 3n) throw new Error("Mint balance mismatch.");
if ((await contract.uri(tokenId)) !== metadataUri) throw new Error("Metadata URI mismatch.");
const transferTx = await contract.safeTransferFrom(deployer.address, recipient, tokenId, 1n, "0x");
const transferReceipt = await transferTx.wait();
if ((await contract.balanceOf(deployer.address, tokenId)) !== 2n || (await contract.balanceOf(recipient, tokenId)) !== 1n) throw new Error("Transfer balances mismatch.");
const pauseTx = await contract.pause();
const pauseReceipt = await pauseTx.wait();
let blockedWhilePaused = false;
try { await contract.createEdition(ethers.encodeBytes32String(`p${suffix.slice(-7)}`), ethers.encodeBytes32String("paused"), 1n, metadataUri); } catch { blockedWhilePaused = true; }
if (!blockedWhilePaused) throw new Error("Protected operation succeeded while paused.");
const unpauseTx = await contract.unpause();
const unpauseReceipt = await unpauseTx.wait();
if (await contract.paused()) throw new Error("Contract remained paused after unpause.");
const postPauseTx = await contract.createEdition(ethers.encodeBytes32String(`u${suffix.slice(-7)}`), ethers.encodeBytes32String("after"), 1n, metadataUri);
const postPauseReceipt = await postPauseTx.wait();

const record = {
  network: "Avalanche Fuji", chainId: 43113, contractType: "ERC1155", contractName: "VoidRelease1155",
  contractAddress: address, deploymentTransaction: txHash, deploymentBlock: receipt.blockNumber,
  deployer: deployer.address, admin, sourceCommit: process.env.GITHUB_SHA || "504c7a230d40969873afaf06464b7438a28cc470",
  bytecodeHash: runtimeHash, creationBytecodeHash: deployment.bytecodeHash ?? null,
  deployedBytecodeMatchesArtifact: artifactRuntime ? code.toLowerCase() === artifactRuntime.toLowerCase() : null,
  verification: { receiptStatus: receipt.status, deployedBytecode: code !== "0x", roles, paused: await contract.paused(), supportsInterface },
  smokeTest: {
    tokenId: tokenId.toString(), metadataUri, editionCreated: createReceipt.status === 1, minted: mintReceipt.status === 1,
    balances: { deployer: (await contract.balanceOf(deployer.address, tokenId)).toString(), recipient: (await contract.balanceOf(recipient, tokenId)).toString() },
    transferred: transferReceipt.status === 1, paused: pauseReceipt.status === 1, blockedWhilePaused, unpaused: unpauseReceipt.status === 1, resumed: postPauseReceipt.status === 1
  },
  indexerVerification: "NOT_CONFIGURED_IN_WORKFLOW",
  compiler: "solc 0.8.24", optimizer: { enabled: true, runs: 200 }, recordedAt: new Date().toISOString()
};
await mkdir("deployments", { recursive: true });
await writeFile("deployments/release-fuji.json", `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify(record, null, 2));

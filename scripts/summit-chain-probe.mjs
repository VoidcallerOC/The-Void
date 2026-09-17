import deployment from "../config/fuji-release.json" with { type: "json" };
import { ethers } from "ethers";

const provider = new ethers.JsonRpcProvider(deployment.rpcUrl, deployment.chainId, { staticNetwork: true });
const contract = new ethers.Contract(deployment.contractAddress, deployment.abi, provider);
const releaseId = ethers.encodeBytes32String("summit-demo-release");
const editionId = ethers.encodeBytes32String("summit-demo-edition");
const tokenId = await contract.tokenIdFor(releaseId, editionId);
const deploymentReceipt = await provider.getTransactionReceipt(deployment.deploymentTransaction);
const deploymentBlock = await provider.getBlock(deployment.deploymentBlock);
console.log(JSON.stringify({
  network: deployment.networkName,
  chainId: Number((await provider.getNetwork()).chainId),
  currentBlock: await provider.getBlockNumber(),
  contract: deployment.contractAddress,
  codePresent: (await provider.getCode(deployment.contractAddress)) !== "0x",
  deploymentTransaction: deployment.deploymentTransaction,
  deploymentReceipt: deploymentReceipt ? { status: deploymentReceipt.status, blockNumber: deploymentReceipt.blockNumber } : null,
  deploymentBlockHash: deploymentBlock?.hash || null,
  demoRelease: "summit-demo-release",
  demoEdition: "summit-demo-edition",
  tokenId: tokenId.toString(),
  paused: await contract.paused(),
}));

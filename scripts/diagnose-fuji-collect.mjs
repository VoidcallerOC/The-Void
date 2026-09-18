import { ethers } from "ethers";
import deployment from "../config/fuji-release.json" with { type: "json" };

const rpcUrl = process.env.FUJI_RPC_URL || deployment.rpcUrl;
const provider = new ethers.JsonRpcProvider(rpcUrl, deployment.chainId, { staticNetwork: true });
const abi = [
  ...deployment.abi,
  "function edition(uint256) view returns (bytes32 releaseId, bytes32 editionId, address artist, uint256 maxSupply, uint256 mintedSupply, string metadataUri, bool exists)",
  "event EditionCreated(uint256 indexed tokenId, bytes32 indexed releaseId, bytes32 indexed editionId, address artist, uint256 maxSupply, string metadataUri)",
];
const iface = new ethers.Interface(abi);
const contract = new ethers.Contract(deployment.contractAddress, abi, provider);
const releaseText = process.env.RELEASE_ID || "summit-demo-release";
const editionText = process.env.EDITION_ID || "summit-demo-edition";
const releaseId = ethers.encodeBytes32String(releaseText);
const editionId = ethers.encodeBytes32String(editionText);
const tokenId = await contract.tokenIdFor(releaseId, editionId);
const issuerRole = ethers.keccak256(ethers.toUtf8Bytes("ISSUER_ROLE"));
const artistRole = ethers.keccak256(ethers.toUtf8Bytes("ARTIST_ROLE"));
const adminRole = ethers.ZeroHash;
const wallet = process.env.WALLET_ADDRESS || null;
const amount = BigInt(process.env.MINT_AMOUNT || "1");
const result = {
  rpcUrl,
  chainId: Number((await provider.getNetwork()).chainId),
  currentBlock: await provider.getBlockNumber(),
  contract: deployment.contractAddress,
  codePresent: (await provider.getCode(deployment.contractAddress)) !== "0x",
  releaseText,
  editionText,
  tokenId: tokenId.toString(),
  tokenIdMatchesExpected: tokenId.toString() === "7411362830788782394364807220906042636316481552574685730",
  paused: await contract.paused(),
};
if (wallet) {
  const normalized = ethers.getAddress(wallet);
  result.wallet = normalized;
  result.roles = {
    admin: await contract.hasRole(adminRole, normalized),
    artist: await contract.hasRole(artistRole, normalized),
    issuer: await contract.hasRole(issuerRole, normalized),
  };
  result.balance = (await contract.balanceOf(normalized, tokenId)).toString();
  const data = iface.encodeFunctionData("mint", [normalized, tokenId, amount, "0x"]);
  result.mintCalldata = data;
  result.mintTx = { from: normalized, to: deployment.contractAddress, data, value: "0x0" };
  try {
    result.gasEstimate = (await provider.estimateGas(result.mintTx)).toString();
    result.simulation = "PASS";
  } catch (error) {
    result.simulation = "REVERT";
    result.simulationError = { message: error.shortMessage || error.message, data: error.data || error.error?.data || null, reason: error.reason || error.error?.reason || null };
    const dataField = result.simulationError.data;
    if (dataField) {
      try { result.decodedError = iface.parseError(dataField); } catch { result.decodedError = null; }
    }
  }
}
try {
  const edition = await contract.edition(tokenId);
  result.edition = { releaseId: edition.releaseId, editionId: edition.editionId, artist: edition.artist, maxSupply: edition.maxSupply.toString(), mintedSupply: edition.mintedSupply.toString(), metadataUri: edition.metadataUri, exists: edition.exists };
} catch (error) {
  result.edition = null;
  result.editionError = { message: error.shortMessage || error.message, data: error.data || error.error?.data || null };
  const dataField = result.editionError.data;
  if (dataField) { try { result.editionDecodedError = iface.parseError(dataField); } catch {} }
}
const eventTopic = iface.getEvent("EditionCreated").topicHash;
const logs = await provider.getLogs({ address: deployment.contractAddress, fromBlock: deployment.deploymentBlock, toBlock: "latest", topics: [eventTopic] });
result.editionCreatedEvents = logs.map((log) => {
  const parsed = iface.parseLog(log);
  return { txHash: log.transactionHash, blockNumber: log.blockNumber, tokenId: parsed.args.tokenId.toString(), releaseId: parsed.args.releaseId, editionId: parsed.args.editionId, artist: parsed.args.artist, maxSupply: parsed.args.maxSupply.toString(), metadataUri: parsed.args.metadataUri };
});
result.summitEditionCreatedEvents = result.editionCreatedEvents.filter((event) => event.tokenId === tokenId.toString() || (event.releaseId === releaseId && event.editionId === editionId));
console.log(JSON.stringify(result, (_, value) => typeof value === "bigint" ? value.toString() : value, 2));

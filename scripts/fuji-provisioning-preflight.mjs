// Read-only Fuji preflight for one pending Studio provisioning request.
// Proves, against live chain state and deployed bytecode, that the exact
// createRelease transaction the artist will sign succeeds: chain id, factory
// and implementation identity, album capability, unused release key, and an
// eth_call / estimateGas of the exact calldata from the artist wallet.
// No secrets, no signing, no broadcast.
//
// Optional env: FUJI_RPC_URL (defaults to the configured public Fuji endpoint).
import { AbiCoder, Interface, JsonRpcProvider, ZeroAddress, getAddress, id, keccak256, toUtf8Bytes } from "ethers";
import fujiV2 from "../config/fuji-release-per-contract-v2.json" with { type: "json" };

const RPC_URL = process.env.FUJI_RPC_URL || fujiV2.rpcUrl;
const FUJI_CHAIN_ID = 43113n;

// expected_parameters of release_provisioning_requests row cd5fe948-137e-430a-ae5c-162c8a2923f2
// (release fuji-rehearsal-release-a-3), copied verbatim; JSON key order matters for the digest.
const REQUEST = {
  requestId: "cd5fe948-137e-430a-ae5c-162c8a2923f2",
  authorizationDigest: "0x85bdbaaf127657c1117415ee45b8779592957d34371db75fd2c980b395f0188e",
  expectedParameters: {
    chainId: 43113,
    factoryAddress: "0x3e4e0d9187f6fd11bd6d792a7088d0c2de8e3ac8",
    applicationReleaseId: "0xf39a37dac4286594d5ec68fe49016400333515e03e83af61cc9140ea1369d12e",
    applicationReleaseRecordId: "release-0c843ff8-2e63-4433-9b17-c3c5624c76fc",
    releaseKey: "0xb9d25e62e6602a532c1c0e978198ce387c060680849503dbe199e354170f182e",
    artistWallet: "0x284c09a7cc187e096cbbdc88d99defe6df32180a",
    name: "Fuji Rehearsal Release A",
    symbol: "FUJIREHEARS",
    contractURI: "",
  },
};

const ALBUM_SIGNATURES = [
  "createAlbum(bytes32)",
  "createAlbumTrack(bytes32,bytes32,uint256,string,address,uint96,bool,uint64)",
  "closeAlbum(bytes32)",
  "albumCreated()",
  "createEditionWithMintEnd(bytes32,bytes32,uint256,string,address,uint96,uint64)",
  "approveExpandedRelease(bytes32,uint256,uint256)",
];
const hasSelector = (code, signature) => code.toLowerCase().includes(`63${id(signature).slice(2, 10)}`);

const factoryIface = new Interface([
  "function implementation() view returns (address)",
  "function releaseCount() view returns (uint256)",
  "function releaseContractOf(bytes32) view returns (address)",
  "function releasesOf(address) view returns (address[])",
  "function createRelease(bytes32 applicationReleaseId,bytes32 releaseKey,string name,string symbol,string contractURI) returns (address releaseContract,address primarySale,address provenanceAnchor)",
  "error InvalidAddress()",
  "error InvalidReleaseKey()",
  "error ReleaseKeyMismatch(bytes32 expected, bytes32 actual)",
  "error ReleaseAlreadyExists(bytes32 releaseKey, address releaseContract)",
  "error CloneFailed()",
]);

async function view(provider, to, name, args = []) {
  const data = await provider.call({ to, data: factoryIface.encodeFunctionData(name, args) });
  return factoryIface.decodeFunctionResult(name, data);
}

function revertReason(error) {
  const data = error?.data ?? error?.info?.error?.data ?? error?.error?.data;
  if (typeof data === "string" && data.length >= 10) {
    try {
      const parsed = factoryIface.parseError(data);
      if (parsed) return `${parsed.name}(${parsed.args.map(String).join(",")})`;
    } catch {
      // fall through to the raw selector
    }
    return `revert ${data.slice(0, 10)}`;
  }
  return String(error?.shortMessage || error?.message || "unknown").slice(0, 200);
}

async function main() {
  const expected = REQUEST.expectedParameters;
  const factory = getAddress(expected.factoryAddress);
  const artist = getAddress(expected.artistWallet);
  const checks = {};
  const result = { requestId: REQUEST.requestId, rpcHost: new URL(RPC_URL).host, factory, artist, checks };

  // Off-chain integrity: the stored digest, key and app id match the Studio formulas.
  checks.digestMatches = keccak256(toUtf8Bytes(JSON.stringify(expected))) === REQUEST.authorizationDigest;
  checks.applicationReleaseIdMatches = keccak256(toUtf8Bytes(expected.applicationReleaseRecordId)) === expected.applicationReleaseId;
  const derivedKey = keccak256(AbiCoder.defaultAbiCoder().encode(
    ["string", "uint256", "address", "bytes32", "address"],
    ["the-void:studio-release:v2", FUJI_CHAIN_ID, factory, expected.applicationReleaseId, artist],
  ));
  checks.releaseKeyMatchesOnChainFormula = derivedKey === expected.releaseKey;
  checks.factoryMatchesConfig = factory === getAddress(fujiV2.factoryAddress);

  const provider = new JsonRpcProvider(RPC_URL, Number(FUJI_CHAIN_ID), { staticNetwork: true });
  const [network, block] = await Promise.all([provider.send("eth_chainId", []), provider.getBlockNumber()]);
  result.block = block;
  checks.chainIdIs43113 = BigInt(network) === FUJI_CHAIN_ID;

  const factoryCode = await provider.getCode(factory);
  checks.factoryHasCode = factoryCode !== "0x";
  const [implementation] = await view(provider, factory, "implementation");
  result.implementation = implementation;
  checks.implementationMatchesConfig = getAddress(implementation) === getAddress(fujiV2.implementationAddress);
  const implementationCode = await provider.getCode(implementation);
  result.implementationCodeBytes = (implementationCode.length - 2) / 2;
  checks.implementationAlbumCapable = ALBUM_SIGNATURES.every((signature) => hasSelector(implementationCode, signature));
  checks.factoryHasCreateRelease = hasSelector(factoryCode, "createRelease(bytes32,bytes32,string,string,string)");

  const [existing] = await view(provider, factory, "releaseContractOf", [expected.releaseKey]);
  checks.releaseKeyUnused = existing === ZeroAddress;
  const [count] = await view(provider, factory, "releaseCount");
  result.factoryReleaseCount = count.toString();
  const [artistReleases] = await view(provider, factory, "releasesOf", [artist]);
  result.artistReleasesOnFactory = artistReleases.length;

  const data = factoryIface.encodeFunctionData("createRelease", [
    expected.applicationReleaseId, expected.releaseKey, expected.name, expected.symbol, expected.contractURI,
  ]);
  result.transaction = { to: factory, from: artist, value: "0", selector: data.slice(0, 10), calldataKeccak: keccak256(data), calldataBytes: (data.length - 2) / 2 };

  try {
    const returned = await provider.call({ from: artist, to: factory, data });
    const [releaseContract, primarySale, provenanceAnchor] = factoryIface.decodeFunctionResult("createRelease", returned);
    checks.simulationSucceeds = true;
    result.predictedAtCurrentState = { releaseContract, primarySale, provenanceAnchor, note: "CREATE addresses; valid only if no other release is created first" };
  } catch (error) {
    checks.simulationSucceeds = false;
    result.simulationRevert = revertReason(error);
  }

  if (checks.simulationSucceeds) {
    const [gas, feeData, balance] = await Promise.all([
      provider.estimateGas({ from: artist, to: factory, data }),
      provider.getFeeData(),
      provider.getBalance(artist),
    ]);
    const price = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
    result.gas = { estimate: gas.toString(), maxFeePerGasWei: price.toString(), worstCaseCostWei: (gas * price).toString(), artistBalanceWei: balance.toString() };
    checks.artistCanPayGas = balance >= gas * price;
  }

  result.ok = Object.values(checks).every(Boolean);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: String(error?.shortMessage || error?.message || error).slice(0, 300) })}\n`);
  process.exitCode = 1;
});

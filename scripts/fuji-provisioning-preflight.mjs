import { pathToFileURL } from "node:url";
// Read-only Fuji preflight for Studio provisioning requests.
//
// Each request carries an explicit lifecycle status:
// - "pending": proves, against live chain state and deployed bytecode, that the exact
//   createRelease transaction the artist will sign succeeds: chain id, factory and
//   implementation identity, album capability, unused release key, and an eth_call /
//   estimateGas of the exact calldata from the artist wallet.
// - "fulfilled": proves the request was mined exactly once as recorded: the release key is
//   bound to the recorded clone, the recorded transaction succeeded from the artist with the
//   request's exact calldata and emitted the matching ReleaseCreated event, and a repeat of
//   the same calldata is refused with ReleaseAlreadyExists for that clone.
// Any other status, any mismatch, or any unexpected revert fails the preflight.
// No secrets, no signing, no broadcast.
//
// Optional env: FUJI_RPC_URL (defaults to the configured public Fuji endpoint).
import process from "node:process";
import { AbiCoder, Interface, JsonRpcProvider, ZeroAddress, getAddress, id, keccak256, toUtf8Bytes } from "ethers";
import fujiV2 from "../config/fuji-release-per-contract-v2.json" with { type: "json" };

const FUJI_CHAIN_ID = 43113n;

export const REQUESTS = [
  // expected_parameters of release_provisioning_requests row cd5fe948-137e-430a-ae5c-162c8a2923f2
  // (release fuji-rehearsal-release-a-3), copied verbatim; JSON key order matters for the digest.
  // Fulfilled by the artist on 2026-10-10 16:24:19Z. The ReleaseCreated event in the transaction
  // below binds this release key to clone 0xBf75…4CB9 (index 0 on the factory; see
  // ALBUM-SINGLE-REDEPLOY-AND-ACCEPTANCE.md section 6).
  {
    requestId: "cd5fe948-137e-430a-ae5c-162c8a2923f2",
    status: "fulfilled",
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
    fulfillment: {
      transactionHash: "0x7ca0dc94ff7b69234bb2a07d4e29ba1e6a8a46f2cb21327f0cd1cd89f748d711",
      blockNumber: 59273699,
      releaseContract: "0xBf753E65e4A10a3074ea6889F25D840A04B04CB9",
    },
  },
];

const ALBUM_SIGNATURES = [
  "createAlbum(bytes32)",
  "createAlbumTrack(bytes32,bytes32,uint256,string,address,uint96,bool,uint64)",
  "closeAlbum(bytes32)",
  "albumCreated()",
  "createEditionWithMintEnd(bytes32,bytes32,uint256,string,address,uint96,uint64)",
  "approveExpandedRelease(bytes32,uint256,uint256)",
];
const hasSelector = (code, signature) => code.toLowerCase().includes(`63${id(signature).slice(2, 10)}`);

export const factoryIface = new Interface([
  "function implementation() view returns (address)",
  "function releaseCount() view returns (uint256)",
  "function releaseContractOf(bytes32) view returns (address)",
  "function releasesOf(address) view returns (address[])",
  "function createRelease(bytes32 applicationReleaseId,bytes32 releaseKey,string name,string symbol,string contractURI) returns (address releaseContract,address primarySale,address provenanceAnchor)",
  "event ReleaseCreated(address indexed releaseContract,bytes32 indexed releaseKey,address indexed artist,address primarySale,address provenanceAnchor,address implementation,uint256 index,uint16 version)",
  "error InvalidAddress()",
  "error InvalidReleaseKey()",
  "error ReleaseKeyMismatch(bytes32 expected, bytes32 actual)",
  "error ReleaseAlreadyExists(bytes32 releaseKey, address releaseContract)",
  "error CloneFailed()",
]);

export function studioReleaseKey(factory, applicationReleaseId, artist) {
  return keccak256(AbiCoder.defaultAbiCoder().encode(
    ["string", "uint256", "address", "bytes32", "address"],
    ["the-void:studio-release:v2", FUJI_CHAIN_ID, getAddress(factory), applicationReleaseId, getAddress(artist)],
  ));
}

async function view(provider, to, name, args = []) {
  const data = await provider.call({ to, data: factoryIface.encodeFunctionData(name, args) });
  return factoryIface.decodeFunctionResult(name, data);
}

function revertData(error) {
  const data = error?.data ?? error?.info?.error?.data ?? error?.error?.data;
  return typeof data === "string" && data.length >= 10 ? data : null;
}

function revertReason(error) {
  const data = revertData(error);
  if (data) {
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

function recordedFactories(config) {
  return new Set([config.factoryAddress, ...(config.historicalDeployments || []).map((item) => item.factoryAddress)]
    .filter(Boolean).map((value) => getAddress(value)));
}

/** Preflights one request. Returns { ok, checks, ... }; never signs or broadcasts. */
export async function preflightRequest(request, provider, config = fujiV2) {
  const expected = request.expectedParameters;
  const factory = getAddress(expected.factoryAddress);
  const artist = getAddress(expected.artistWallet);
  const checks = {};
  const result = { requestId: request.requestId, status: request.status, factory, artist, checks };
  if (request.status !== "pending" && request.status !== "fulfilled") {
    checks.knownStatus = false;
    result.ok = false;
    return result;
  }

  // Off-chain integrity: the stored digest, key and app id match the Studio formulas.
  checks.digestMatches = keccak256(toUtf8Bytes(JSON.stringify(expected))) === request.authorizationDigest;
  checks.applicationReleaseIdMatches = keccak256(toUtf8Bytes(expected.applicationReleaseRecordId)) === expected.applicationReleaseId;
  checks.releaseKeyMatchesOnChainFormula = studioReleaseKey(factory, expected.applicationReleaseId, artist) === expected.releaseKey;

  const network = await provider.send("eth_chainId", []);
  checks.chainIdIs43113 = BigInt(network) === FUJI_CHAIN_ID;
  const factoryCode = await provider.getCode(factory);
  checks.factoryHasCode = factoryCode !== "0x";
  checks.factoryHasCreateRelease = hasSelector(factoryCode, "createRelease(bytes32,bytes32,string,string,string)");

  const data = factoryIface.encodeFunctionData("createRelease", [
    expected.applicationReleaseId, expected.releaseKey, expected.name, expected.symbol, expected.contractURI,
  ]);
  result.transaction = { to: factory, from: artist, value: "0", selector: data.slice(0, 10), calldataKeccak: keccak256(data), calldataBytes: (data.length - 2) / 2 };
  const [existing] = await view(provider, factory, "releaseContractOf", [expected.releaseKey]);
  result.releaseContractOfKey = existing;

  let simulation;
  try {
    simulation = { returned: await provider.call({ from: artist, to: factory, data }) };
  } catch (error) {
    simulation = { error };
    result.simulationRevert = revertReason(error);
  }

  if (request.status === "fulfilled") {
    const recorded = getAddress(request.fulfillment.releaseContract);
    checks.factoryIsRecordedDeployment = recordedFactories(config).has(factory);
    checks.releaseKeyBoundToRecordedRelease = existing !== ZeroAddress && getAddress(existing) === recorded;

    const [receipt, transaction] = await Promise.all([
      provider.getTransactionReceipt(request.fulfillment.transactionHash),
      provider.getTransaction(request.fulfillment.transactionHash),
    ]);
    checks.fulfillmentReceiptSucceeded = Boolean(receipt) && receipt.status === 1
      && receipt.blockNumber === request.fulfillment.blockNumber
      && getAddress(receipt.to ?? ZeroAddress) === factory && getAddress(receipt.from) === artist;
    checks.fulfillmentCalldataMatches = Boolean(transaction) && keccak256(transaction.data) === keccak256(data);
    const event = (receipt?.logs || [])
      .filter((log) => getAddress(log.address) === factory)
      .map((log) => { try { return factoryIface.parseLog(log); } catch { return null; } })
      .find((parsed) => parsed?.name === "ReleaseCreated");
    checks.fulfillmentEventMatches = Boolean(event) && getAddress(event.args.releaseContract) === recorded
      && event.args.releaseKey === expected.releaseKey && getAddress(event.args.artist) === artist;

    // The factory's duplicate protection must refuse a repeat with exactly this key and clone.
    let duplicate = null;
    try { duplicate = simulation.error && factoryIface.parseError(revertData(simulation.error) || "0x"); } catch { duplicate = null; }
    checks.duplicateCreationRefused = Boolean(duplicate) && duplicate.name === "ReleaseAlreadyExists"
      && duplicate.args.releaseKey === expected.releaseKey && getAddress(duplicate.args.releaseContract) === recorded;
    result.fulfillment = { ...request.fulfillment, releaseContract: recorded };
  } else {
    checks.factoryMatchesConfig = factory === getAddress(config.factoryAddress);
    const [implementation] = await view(provider, factory, "implementation");
    result.implementation = implementation;
    checks.implementationMatchesConfig = getAddress(implementation) === getAddress(config.implementationAddress);
    const implementationCode = await provider.getCode(implementation);
    result.implementationCodeBytes = (implementationCode.length - 2) / 2;
    checks.implementationAlbumCapable = ALBUM_SIGNATURES.every((signature) => hasSelector(implementationCode, signature));
    checks.releaseKeyUnused = existing === ZeroAddress;
    const [count] = await view(provider, factory, "releaseCount");
    result.factoryReleaseCount = count.toString();
    const [artistReleases] = await view(provider, factory, "releasesOf", [artist]);
    result.artistReleasesOnFactory = artistReleases.length;

    checks.simulationSucceeds = Boolean(simulation.returned);
    if (checks.simulationSucceeds) {
      const [releaseContract, primarySale, provenanceAnchor] = factoryIface.decodeFunctionResult("createRelease", simulation.returned);
      result.predictedAtCurrentState = { releaseContract, primarySale, provenanceAnchor, note: "CREATE addresses; valid only if no other release is created first" };
      const [gas, feeData, balance] = await Promise.all([
        provider.estimateGas({ from: artist, to: factory, data }),
        provider.getFeeData(),
        provider.getBalance(artist),
      ]);
      const price = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
      result.gas = { estimate: gas.toString(), maxFeePerGasWei: price.toString(), worstCaseCostWei: (gas * price).toString(), artistBalanceWei: balance.toString() };
      checks.artistCanPayGas = balance >= gas * price;
    }
  }

  result.ok = Object.values(checks).every(Boolean);
  return result;
}

/** Preflights every request; ok only if each one passes for its declared status. */
export async function runPreflight(requests, provider, config = fujiV2) {
  const results = [];
  for (const request of requests) results.push(await preflightRequest(request, provider, config));
  return {
    pendingRequests: requests.filter((request) => request.status === "pending").length,
    requests: results,
    ok: results.length > 0 && results.every((item) => item.ok),
  };
}

async function main() {
  const rpcUrl = process.env.FUJI_RPC_URL || fujiV2.rpcUrl;
  const provider = new JsonRpcProvider(rpcUrl, Number(FUJI_CHAIN_ID), { staticNetwork: true });
  const summary = await runPreflight(REQUESTS, provider);
  const output = { rpcHost: new URL(rpcUrl).host, block: await provider.getBlockNumber(), ...summary };
  process.stdout.write(`${JSON.stringify(output, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2)}\n`);
  process.exitCode = output.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(error?.shortMessage || error?.message || error).slice(0, 300) })}\n`);
    process.exitCode = 1;
  });
}

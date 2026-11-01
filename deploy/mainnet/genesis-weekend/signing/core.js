// Pure verification logic for the Genesis weekend owner-signing page. The page and the tests both use it.
// `ethers` is passed in so the same file runs in the browser (local vendored copy) and under Node.

export const PLAN = Object.freeze({
  chainId: 43114,
  signer: "0x284C09a7CC187E096cbbdc88d99DEFE6df32180a",
  release: "0xF0C091A159DE16cF0F306b2B61d37685EC5A830e",
  sale: "0xB4dAAe78a53c33f52C6EB573c4d6EFC7B86F3845",
  priorClaims: ["0x8512be04a4E54cd8551738165F9c05C3303187a0", "0x7D1a068F532aD6c0f591d4Fb9F82fd5b97495363", "0xd70dBA7fF6419481d62D4689bDf271ad441766b8"],
  revokeTargets: ["0x7D1a068F532aD6c0f591d4Fb9F82fd5b97495363", "0xd70dBA7fF6419481d62D4689bDf271ad441766b8"],
  claimEnd: "1793595599",
  baseline: "4",
  tokenId: "1",
});

export const RELEASE_ABI = [
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function grantRole(bytes32 role, address account)",
  "function revokeRole(bytes32 role, address account)",
  "function edition(uint256 tokenId) view returns ((bytes32 releaseId,bytes32 editionId,address artist,uint256 maxSupply,uint256 mintedSupply,string metadataUri,bool exists))",
];
export const SALE_ABI = ["function sales(uint256) view returns (uint256,uint256,uint256,uint256,uint64,uint64,bool,bool)"];

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** Checks the manifest against the artifact and the reviewed plan. Returns a list of problems; empty means valid. */
export function verifyManifest(ethers, manifest, artifact) {
  const problems = [];
  const expect = (condition, message) => { if (!condition) problems.push(message); };
  expect(manifest?.format === "the-void:genesis-weekend-signing-manifest:v1", "Unknown manifest format.");
  expect(manifest?.ok === true && Array.isArray(manifest.failures) && manifest.failures.length === 0, "The manifest was generated with failing checks.");
  expect(Number(manifest?.chainId) === PLAN.chainId, "The manifest is not for Avalanche C-Chain 43114.");
  expect(same(manifest?.signer, PLAN.signer), "The manifest signer is not the authorized artist wallet.");
  // Artifact integrity.
  expect(ethers.keccak256(artifact.bytecode) === artifact.bytecodeKeccak256, "The artifact bytecode does not match its own hash.");
  expect(ethers.keccak256(artifact.deployedBytecode) === artifact.deployedBytecodeKeccak256, "The artifact runtime code does not match its own hash.");
  for (const key of ["sourceCommit", "sourceKeccak256", "bytecodeKeccak256", "deployedBytecodeKeccak256"]) {
    expect(manifest.artifact?.[key] === artifact[key], `The manifest artifact ${key} differs from the artifact file.`);
  }
  // Constructor arguments pinned to the reviewed plan.
  const args = manifest.constructorArgs || {};
  expect(same(args.releaseContract, PLAN.release) && same(args.primarySale, PLAN.sale), "Constructor release or sale differs from the plan.");
  expect(String(args.tokenId) === PLAN.tokenId && String(args.claimEnd) === PLAN.claimEnd && String(args.baselineClaimedSupply) === PLAN.baseline, "Constructor token, close or baseline differs from the plan.");
  expect(same(args.admin, PLAN.signer), "Constructor admin is not the artist wallet.");
  expect(Array.isArray(args.priorClaims) && args.priorClaims.length === 3 && args.priorClaims.every((address, i) => same(address, PLAN.priorClaims[i])), "Constructor prior claims differ from the plan.");
  expect(args.merkleRoot === manifest.snapshot?.merkleRoot && args.snapshotHash === manifest.snapshot?.snapshotHash
    && String(args.eligibleWallets) === String(manifest.snapshot?.eligibleWallets)
    && String(args.snapshotCChainBlock) === String(manifest.snapshot?.cchainBlock) && String(args.snapshotGrottoBlock) === String(manifest.snapshot?.grottoBlock), "Constructor snapshot fields differ from the manifest snapshot.");
  // Rebuild the creation data from the artifact and the arguments; it must equal the manifest byte for byte.
  try {
    const iface = new ethers.Interface(artifact.abi);
    const config = { ...args, tokenId: BigInt(args.tokenId), eligibleWallets: BigInt(args.eligibleWallets), snapshotCChainBlock: BigInt(args.snapshotCChainBlock),
      snapshotGrottoBlock: BigInt(args.snapshotGrottoBlock), claimEnd: BigInt(args.claimEnd), baselineClaimedSupply: BigInt(args.baselineClaimedSupply) };
    const data = `${artifact.bytecode}${ethers.AbiCoder.defaultAbiCoder().encode(iface.deploy.inputs, [config]).slice(2)}`;
    expect(data === manifest.deploy?.data, "The deployment data does not rebuild from the artifact and arguments.");
    expect(ethers.keccak256(data) === manifest.deploy?.dataKeccak256, "The deployment data hash differs from the manifest.");
  } catch (error) {
    problems.push(`The deployment data could not be rebuilt: ${error.message}`);
  }
  // Role calls: exactly the reviewed revocations, on the release, for ISSUER_ROLE.
  const release = new ethers.Interface(RELEASE_ABI);
  const issuer = manifest.roles?.issuerRole;
  expect(issuer === ethers.id("ISSUER_ROLE"), "The issuer role id is not keccak256(\"ISSUER_ROLE\").");
  expect(Array.isArray(manifest.revokes) && manifest.revokes.length === PLAN.revokeTargets.length, "The manifest does not list exactly the reviewed revocations.");
  (manifest.revokes || []).forEach((revoke, i) => {
    expect(same(revoke.to, PLAN.release) && same(revoke.target, PLAN.revokeTargets[i]), `Revocation ${i + 1} targets the wrong contract.`);
    let decoded;
    try { decoded = release.parseTransaction({ data: revoke.data }); } catch { decoded = null; }
    expect(decoded?.name === "revokeRole" && decoded.args[0] === issuer && same(decoded.args[1], PLAN.revokeTargets[i]), `Revocation ${i + 1} calldata is not revokeRole(ISSUER_ROLE, ${PLAN.revokeTargets[i]}).`);
  });
  expect(same(manifest.grant?.to, PLAN.release) && manifest.grant?.role === issuer, "The grant is not ISSUER_ROLE on the release.");
  return problems;
}

/** Masks every immutable in runtime code so the deployed code can be compared with the artifact exactly. */
export function maskImmutables(code, immutableReferences) {
  const bytes = code.startsWith("0x") ? code.slice(2) : code;
  const chars = bytes.split("");
  for (const ranges of Object.values(immutableReferences || {})) {
    for (const { start, length } of ranges) for (let i = start * 2; i < (start + length) * 2; i += 1) chars[i] = "0";
  }
  return `0x${chars.join("")}`;
}

export function runtimeMatches(deployedCode, artifact) {
  if (!deployedCode || deployedCode === "0x" || deployedCode.length !== artifact.deployedBytecode.length) return false;
  return maskImmutables(deployedCode, artifact.immutableReferences) === maskImmutables(artifact.deployedBytecode, artifact.immutableReferences);
}

/** Compares the deployed claim's views with the manifest's expectedAfterDeploy. Returns a list of problems. */
export function compareDeployState(expected, actual) {
  const problems = [];
  for (const [key, value] of Object.entries(expected)) {
    const got = actual[key];
    const equal = typeof value === "boolean" ? got === value : same(String(got), String(value));
    if (!equal) problems.push(`${key}: expected ${value}, read ${got}`);
  }
  return problems;
}

export function toHex(value) {
  return `0x${BigInt(value).toString(16)}`;
}

/** Whether `balance` covers `gasCeiling` at `maxFeePerGas` (what the wallet reserves up front). */
export function covers(balance, gasCeiling, maxFeePerGas) {
  return BigInt(balance) >= BigInt(gasCeiling) * BigInt(maxFeePerGas);
}

import { describe, expect, it } from "vitest";
import { ethers } from "ethers";
import { FUJI_RELEASE_CONFIG, FUJI_RELEASE_ABI, FUJI_ROLES, assertFujiAddress, assertFujiTransactionTarget, assertProvenanceAnchorTarget, decodeFujiRevert, encodeCreateFujiEdition, encodeFujiMint, explainFujiEditionError, fujiSlug, fujiTokenId, isCertifiedFujiEdition, isFujiEditionNotFoundError, readFujiEdition, sendFujiTransaction, simulateCreateFujiEdition } from "./fuji-release.js";

describe("certified Fuji VoidRelease1155 integration", () => {
  it("uses a valid certified Fuji release configuration", () => {
    expect(FUJI_RELEASE_CONFIG.chainId).toBe(43113);
    expect(ethers.isAddress(FUJI_RELEASE_CONFIG.contractAddress)).toBe(true);
    expect(FUJI_RELEASE_ABI.join(" ")).toContain("createEdition");
    if (FUJI_RELEASE_CONFIG.contractName === "VoidRelease1155V2") {
      expect(ethers.getAddress(FUJI_RELEASE_CONFIG.contractAddress)).toBe("0x82b26Da27136935454Bdf1e40801190B521b82e5");
      expect(ethers.getAddress(FUJI_RELEASE_CONFIG.primarySaleAddress)).toBe("0xcc26cd6D6dc25654652D1FBB64dB5F61E20F60F1");
      const expectedV2Address = globalThis.process?.env?.EXPECTED_FUJI_V2_RELEASE_ADDRESS;
      if (expectedV2Address) expect(FUJI_RELEASE_CONFIG.contractAddress.toLowerCase()).toBe(expectedV2Address.toLowerCase());
    } else {
      expect(FUJI_RELEASE_CONFIG.contractName).toBe("VoidRelease1155");
      expect(FUJI_RELEASE_CONFIG.contractAddress).toBe("0x262B774cf9a1949170B58E2d57F6189980FE757b");
    }
  });

  it("derives token IDs with abi.encode-compatible hashing", () => {
    const release = "fuji-test-release-001";
    const edition = "fuji-test-edition-001";
    const expected = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32", "bytes32"], ["the-void:edition:v1", ethers.encodeBytes32String(release), ethers.encodeBytes32String(edition)])));
    expect(fujiTokenId(release, edition)).toBe(expected === 0n ? 1n : expected);
  });

  it("encodes createEdition and mint for the certified contract path", () => {
    const edition = encodeCreateFujiEdition({ releaseId: "fuji-test-release-001", editionId: "fuji-test-edition-001", maxSupply: 10, metadataUri: "ipfs://test" });
    expect(edition.data.slice(0, 10)).toBe(ethers.id("createEdition(bytes32,bytes32,uint256,string)").slice(0, 10));
    const mint = encodeFujiMint({ to: "0x0000000000000000000000000000000000000001", tokenId: edition.tokenId, amount: 1 });
    expect(mint.slice(0, 10)).toBe(ethers.id("mint(address,uint256,uint256,bytes)").slice(0, 10));
    const withRoyalty = encodeCreateFujiEdition({ releaseId: "fuji-test-release-001", editionId: "fuji-test-edition-001", maxSupply: 10, metadataUri: "ipfs://test", payout: "0x0000000000000000000000000000000000000001", royaltyBps: 500 });
    expect(withRoyalty.data.slice(0, 10)).toBe(ethers.id("createEdition(bytes32,bytes32,uint256,string,address,uint96)").slice(0, 10));
    expect(withRoyalty.tokenId).toBe(edition.tokenId);
  });

  it("decodes every field from the deployed Edition struct return", async () => {
    const releaseId = ethers.encodeBytes32String("fuji-release");
    const editionId = ethers.encodeBytes32String("chapter-one");
    const artist = "0x00000000000000000000000000000000000000A1";
    const metadataUri = "ipfs://QmFujiEditionMetadata";
    const editionIface = new ethers.Interface([
      "function edition(uint256) view returns (tuple(bytes32 releaseId, bytes32 editionId, address artist, uint256 maxSupply, uint256 mintedSupply, string metadataUri, bool exists))",
    ]);
    const result = editionIface.encodeFunctionResult("edition", [[releaseId, editionId, artist, 25n, 7n, metadataUri, true]]);
    const provider = {
      request: async ({ method }) => {
        if (method === "eth_chainId") return "0xa869";
        if (method === "eth_call") return result;
        throw new Error(`unexpected provider method: ${method}`);
      },
    };

    await expect(readFujiEdition(provider, 123n)).resolves.toEqual({
      releaseId,
      editionId,
      artist: ethers.getAddress(artist),
      maxSupply: 25n,
      mintedSupply: 7n,
      metadataUri,
      exists: true,
    });
  });

  it("rejects arbitrary contract injection", () => {
    expect(() => assertFujiAddress("0x0000000000000000000000000000000000000001")).toThrow(/certified Fuji/);
    expect(assertFujiAddress(FUJI_RELEASE_CONFIG.contractAddress)).toBe(FUJI_RELEASE_CONFIG.contractAddress);
    expect(assertFujiTransactionTarget(FUJI_RELEASE_CONFIG.contractAddress)).toBe(ethers.getAddress(FUJI_RELEASE_CONFIG.contractAddress));
    expect(() => assertFujiTransactionTarget("0x0000000000000000000000000000000000000001")).toThrow(/primary sale/);
    expect(() => assertProvenanceAnchorTarget(FUJI_RELEASE_CONFIG.contractAddress)).toThrow(/release contract/);
    expect(assertProvenanceAnchorTarget("0x3333333333333333333333333333333333333333")).toBe("0x3333333333333333333333333333333333333333");
  });

  it("recognizes only the expected missing-edition provider failures", () => {
    expect(isFujiEditionNotFoundError(new Error("RPC Request failed: execution reverted"))).toBe(true);
    expect(isFujiEditionNotFoundError(new Error("wallet disconnected"))).toBe(false);
  });

  it("accepts Fuji-safe slugs and rejects oversize identifiers", () => {
    expect(fujiSlug("Chapter I — The Repair")).toBe("chapter-i-the-repair");
    expect(() => fujiSlug("this-identifier-is-definitely-too-long-for-bytes32")).toThrow(/31/);
    expect(isCertifiedFujiEdition({ contractAddress: FUJI_RELEASE_CONFIG.contractAddress, chainId: 43113 })).toBe(true);
    expect(isCertifiedFujiEdition({ contractAddress: FUJI_RELEASE_CONFIG.contractAddress, chainId: 43114 })).toBe(false);
  });
});


// ---------------------------------------------------------------------------
// createEdition revert diagnosis (regression for the generic
// "Fuji transaction reverted or did not receive a successful receipt." error)
// ---------------------------------------------------------------------------

const V2_ERRORS = new ethers.Interface([
  "error AccessDenied(bytes32 role, address account)",
  "error AlreadyInitialized(uint256 tokenId)",
  "error ContractPaused()",
  "error InvalidSupply()",
  "error RoyaltyTooHigh(uint96 bps, uint96 cap)",
]);
const CONNECTED_WALLET = "0x00000000000000000000000000000000000000A1";
const VALID_CREATE = () => encodeCreateFujiEdition({
  releaseId: "voidcaller",
  editionId: "self-titled",
  maxSupply: 25,
  metadataUri: "ipfs://QmMeta",
  payout: CONNECTED_WALLET,
  royaltyBps: 500,
}).data;

// eth_call provider double that reverts with the given custom-error calldata.
function revertingProvider(errorName, args = []) {
  const data = V2_ERRORS.encodeErrorResult(errorName, args);
  return {
    request: async ({ method }) => {
      if (method === "eth_chainId") return "0xa869";
      if (method === "eth_call") { const err = new Error("execution reverted"); err.data = data; throw err; }
      throw new Error(`unexpected provider method: ${method}`);
    },
  };
}

describe("createEdition revert decoding", () => {
  it("decodes each deployed V2 custom error to a specific, actionable message", () => {
    const already = explainFujiEditionError({ data: V2_ERRORS.encodeErrorResult("AlreadyInitialized", [123n]) });
    expect(already).toMatchObject({ code: "AlreadyInitialized" });
    expect(already.message).toMatch(/already exists on Fuji/i);
    expect(already.revertData).toMatch(/^0x/);

    expect(explainFujiEditionError({ data: V2_ERRORS.encodeErrorResult("AccessDenied", [FUJI_ROLES.ARTIST_ROLE, CONNECTED_WALLET]) }))
      .toMatchObject({ code: "AccessDenied", message: expect.stringMatching(/not authorized to create Fuji editions/i) });
    expect(explainFujiEditionError({ data: V2_ERRORS.encodeErrorResult("ContractPaused", []) }))
      .toMatchObject({ code: "ContractPaused", message: expect.stringMatching(/paused/i) });
    expect(explainFujiEditionError({ data: V2_ERRORS.encodeErrorResult("InvalidSupply", []) }))
      .toMatchObject({ code: "InvalidSupply", message: expect.stringMatching(/greater than zero/i) });
  });

  it("preserves raw revert data and reports a wallet rejection distinctly", () => {
    const decoded = decodeFujiRevert({ data: V2_ERRORS.encodeErrorResult("AlreadyInitialized", [7n]) });
    expect(decoded.name).toBe("AlreadyInitialized");
    expect(decoded.args[0]).toBe(7n);
    expect(explainFujiEditionError({ code: 4001, message: "user rejected the request" }))
      .toMatchObject({ code: "ACTION_REJECTED", message: expect.stringMatching(/rejected in the wallet/i) });
  });

  it("returns a null message for an unknown revert so callers keep their fallback", () => {
    expect(explainFujiEditionError({ message: "execution reverted" }).message).toBeNull();
  });
});

describe("simulateCreateFujiEdition (pre-broadcast)", () => {
  it("throws 'already exists' and never broadcasts when the edition is initialized", async () => {
    const provider = revertingProvider("AlreadyInitialized", [fujiTokenId("voidcaller", "self-titled")]);
    await expect(simulateCreateFujiEdition(provider, { from: CONNECTED_WALLET, data: VALID_CREATE() }))
      .rejects.toMatchObject({ code: "AlreadyInitialized", message: expect.stringMatching(/already exists on Fuji/i) });
  });

  it("throws the ARTIST_ROLE message when the wallet lacks the role", async () => {
    const provider = revertingProvider("AccessDenied", [FUJI_ROLES.ARTIST_ROLE, CONNECTED_WALLET]);
    await expect(simulateCreateFujiEdition(provider, { from: CONNECTED_WALLET, data: VALID_CREATE() }))
      .rejects.toMatchObject({ code: "AccessDenied", message: expect.stringMatching(/not authorized/i) });
  });

  it("throws the paused message when the contract is paused", async () => {
    const provider = revertingProvider("ContractPaused", []);
    await expect(simulateCreateFujiEdition(provider, { from: CONNECTED_WALLET, data: VALID_CREATE() }))
      .rejects.toMatchObject({ code: "ContractPaused" });
  });

  it("resolves quietly when the simulation succeeds (valid, non-existent edition)", async () => {
    const provider = {
      request: async ({ method }) => {
        if (method === "eth_chainId") return "0xa869";
        if (method === "eth_call") return "0x"; // createEdition returns tokenId; empty is fine for the sim
        throw new Error(`unexpected provider method: ${method}`);
      },
    };
    await expect(simulateCreateFujiEdition(provider, { from: CONNECTED_WALLET, data: VALID_CREATE() })).resolves.toBeUndefined();
  });
});

describe("sendFujiTransaction failure preserves evidence", () => {
  it("keeps the tx hash and decodes the revert reason on a failed receipt", async () => {
    const failingHash = `0x${"ab".repeat(32)}`;
    const provider = {
      request: async ({ method }) => {
        if (method === "eth_chainId") return "0xa869";
        if (method === "eth_sendTransaction") return failingHash;
        if (method === "eth_getTransactionReceipt") return { status: "0x0", blockNumber: "0x10" };
        if (method === "eth_call") { const err = new Error("execution reverted"); err.data = V2_ERRORS.encodeErrorResult("AlreadyInitialized", [9n]); throw err; }
        throw new Error(`unexpected provider method: ${method}`);
      },
    };
    await expect(sendFujiTransaction({ provider, from: CONNECTED_WALLET, data: VALID_CREATE() }))
      .rejects.toMatchObject({
        code: "AlreadyInitialized",
        transactionHash: failingHash,
        message: expect.stringMatching(/already exists on Fuji/i),
        contractAddress: FUJI_RELEASE_CONFIG.contractAddress,
        chainId: 43113,
        receiptStatus: "0x0",
        blockNumber: 16,
        explorerUrl: expect.stringContaining(failingHash),
      });
  });

  it("still preserves the tx hash with the generic message when the reason cannot be decoded", async () => {
    const failingHash = `0x${"cd".repeat(32)}`;
    const provider = {
      request: async ({ method }) => {
        if (method === "eth_chainId") return "0xa869";
        if (method === "eth_sendTransaction") return failingHash;
        if (method === "eth_getTransactionReceipt") return { status: "0x0" };
        if (method === "eth_call") return "0x"; // replay does not revert
        throw new Error(`unexpected provider method: ${method}`);
      },
    };
    await expect(sendFujiTransaction({ provider, from: CONNECTED_WALLET, data: VALID_CREATE() }))
      .rejects.toMatchObject({
        code: "TX_REVERTED",
        transactionHash: failingHash,
        contractAddress: FUJI_RELEASE_CONFIG.contractAddress,
        chainId: 43113,
        explorerUrl: expect.stringContaining(failingHash),
        blockNumber: null,
      });
  });
});

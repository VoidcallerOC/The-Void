import { Interface, getAddress, id, keccak256 } from "ethers";
import { ALBUM_SIGNATURES } from "../../scripts/deploy-release-per-contract-fuji.mjs";

// An in-memory C-Chain for the owner-signing tests: nonces, code, read-only views, and mined
// transactions built from a reviewed signing request (as Rabby would submit it), with overrides to
// model a wallet or chain that deviates from the review. No key exists anywhere in it.
export const RECIPIENT = getAddress("0xb65C575CaE01574296Fab6E620B9A15cC0121ce4");
export const ARTIST = getAddress("0x284C09a7CC187E096cbbdc88d99DEFE6df32180a");
export const DEPLOYER = getAddress("0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174");

const selectors = (signatures) => signatures.map((signature) => `63${id(signature).slice(2, 10)}`).join("");
export const albumRuntime = `0x${selectors(ALBUM_SIGNATURES)}${selectors(["REQUIRED_ROYALTY_BPS()", "platformFeeRecipient()"])}`;
export const marketplaceRuntime = `0x${selectors(["REQUIRED_ROYALTY_BPS()", "REQUIRED_PLATFORM_FEE_BPS()"])}`;

export const FACTORY_ABI = [
  { type: "constructor", inputs: [{ name: "platformRecipient_", type: "address" }], stateMutability: "nonpayable" },
  ...new Interface([
    "function implementation() view returns (address)", "function platformRecipient() view returns (address)", "function PLATFORM_FEE_BPS() view returns (uint96)",
    "function RELEASE_VERSION() view returns (uint8)", "function REQUIRED_ROYALTY_BPS() view returns (uint96)",
  ]).fragments.map((fragment) => JSON.parse(fragment.format("json"))),
];
export const MARKETPLACE_ABI = [
  { type: "constructor", inputs: [{ name: "feeRecipient_", type: "address" }, { name: "platformFeeBps_", type: "uint256" }, { name: "releaseFactory_", type: "address" }], stateMutability: "nonpayable" },
  ...new Interface([
    "function registry() view returns (address)", "function feeRecipient() view returns (address)", "function platformFeeBps() view returns (uint256)",
    "function deploymentChainId() view returns (uint256)", "function REQUIRED_ROYALTY_BPS() view returns (uint96)",
  ]).fragments.map((fragment) => JSON.parse(fragment.format("json"))),
];
const IMPLEMENTATION_VIEWS = new Interface(["function REQUIRED_ROYALTY_BPS() view returns (uint96)", "function platformFeeRecipient() view returns (address)"]);

/** Artifact loader with the real constructor shapes and distinct creation code per contract. */
export const artifacts = async (path) => {
  if (path.includes("Factory")) return { abi: FACTORY_ABI, bytecode: { object: "0x6001600155" }, deployedBytecode: { object: "0x6001" } };
  if (path.includes("Marketplace")) return { abi: MARKETPLACE_ABI, bytecode: { object: "0x6002600255" }, deployedBytecode: { object: marketplaceRuntime } };
  return { abi: [], bytecode: { object: "0x6003" }, deployedBytecode: { object: albumRuntime } };
};

export function fakeChain({ chainId = 43114n, nonce = 0, pendingNonce, balance = 10n ** 18n, code = {} } = {}) {
  const state = { balance, nonce, pendingNonce: pendingNonce ?? nonce, code: Object.fromEntries(Object.entries(code).map(([k, v]) => [getAddress(k), v])), views: {}, txs: {} };
  let counter = 0;
  const chain = {
    state,
    send: async (method) => { if (method !== "eth_chainId") throw new Error(`unexpected ${method}`); return `0x${chainId.toString(16)}`; },
    getNetwork: async () => ({ chainId }),
    getTransactionCount: async (_address, tag) => (tag === "pending" ? state.pendingNonce : state.nonce),
    getBalance: async () => state.balance,
    getCode: async (target) => state.code[getAddress(target)] ?? "0x",
    getFeeData: async () => ({ maxFeePerGas: 10_000_000_000n }),
    estimateGas: async () => 1_000_000n,
    call: async ({ to, data }) => {
      const handler = state.views[getAddress(to)];
      if (!handler) throw new Error(`no contract at ${to}`);
      return handler(data);
    },
    getTransactionReceipt: async (hash) => state.txs[hash]?.receipt ?? null,
    getTransaction: async (hash) => state.txs[hash]?.tx ?? null,
    /** Mines a request the way the wallet would submit it; `overrides` model a deviation. */
    mine(request, overrides = {}) {
      counter += 1;
      const hash = `0x${counter.toString(16).padStart(64, "0")}`;
      const tx = { hash, chainId: BigInt(request.chainId), from: request.from, nonce: request.nonce, to: null, value: 0n, data: request.data, ...overrides.tx };
      const contractAddress = overrides.contractAddress ?? request.predictedAddress;
      const receipt = { hash, status: overrides.status ?? 1, blockNumber: 100 + counter, gasUsed: 900_000n, contractAddress };
      state.txs[hash] = { tx, receipt };
      state.nonce += 1;
      state.pendingNonce = state.nonce;
      const runtime = overrides.runtime ?? (request.contract === "ReleaseMarketplaceV4" ? marketplaceRuntime : "0x6001");
      if (receipt.status === 1) state.code[getAddress(contractAddress)] = runtime;
      return hash;
    },
    /** Read-only views of a mined factory and its implementation. */
    factoryViews(factory, { implementation, recipient = RECIPIENT, fee = 250n, version = 2n, royalty = 250n, forbidden = recipient, implementationCode = albumRuntime } = {}) {
      const iface = new Interface(FACTORY_ABI);
      const values = { implementation: [implementation], platformRecipient: [recipient], PLATFORM_FEE_BPS: [fee], RELEASE_VERSION: [version], REQUIRED_ROYALTY_BPS: [royalty] };
      state.views[getAddress(factory)] = (data) => { const fn = iface.parseTransaction({ data }).name; return iface.encodeFunctionResult(fn, values[fn]); };
      state.code[getAddress(implementation)] = implementationCode;
      state.views[getAddress(implementation)] = (data) => {
        const fn = IMPLEMENTATION_VIEWS.parseTransaction({ data }).name;
        return IMPLEMENTATION_VIEWS.encodeFunctionResult(fn, [fn === "REQUIRED_ROYALTY_BPS" ? 250n : forbidden]);
      };
    },
    marketplaceViews(marketplace, { registry, feeRecipient = RECIPIENT, fee = 250n, chain = 43114n, royalty = 250n } = {}) {
      const iface = new Interface(MARKETPLACE_ABI);
      const values = { registry: [registry], feeRecipient: [feeRecipient], platformFeeBps: [fee], deploymentChainId: [chain], REQUIRED_ROYALTY_BPS: [royalty] };
      state.views[getAddress(marketplace)] = (data) => { const fn = iface.parseTransaction({ data }).name; return iface.encodeFunctionResult(fn, values[fn]); };
    },
  };
  return chain;
}

export const dataHash = (data) => keccak256(data);

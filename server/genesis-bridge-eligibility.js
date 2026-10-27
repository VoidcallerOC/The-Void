// Fail-closed Grotto bridge eligibility for Genesis recovery.
// Only enabled when GENESIS_BRIDGE_ELIGIBILITY=true AND all verified bindings match live state.
// Never accepts Teleporter message receipt alone. Requires TokensBridged + destination mint evidence.

import process from "node:process";
import { Contract, Interface, getAddress, id } from "ethers";

export const GROTTO_CHAIN_ID = 36463;
export const GROTTO_RPC = "https://subnets.avax.network/thegrotto/mainnet/rpc";
export const SOURCE_BRIDGE = "0x68539f95FB2758327A9C7EdEDa1002b0F3Ec8992";
export const REMOTE_BRIDGE = "0x0d6Fa9968aa57295217737379c44eBbc1130B1Fa";
export const TELEPORTER = "0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf";
export const GROTTO_BLOCKCHAIN_ID = "0x4d17dde28b48d8261d0e157ff214900e6575600325f02d6efb416eebdbde4ba9";
export const GENESIS = "0xD1B4367dd9f235f9ee61878019d66E31511E98eE";

export const TOKENS_BRIDGED_TOPIC = id("TokensBridged(address,address,uint256[],uint256[],bytes32)");

const SOURCE_BRIDGE_IFACE = new Interface([
  "event TokensBridged(address indexed sender, address indexed recipient, uint256[] tokenIds, uint256[] amounts, bytes32 messageID)",
  "function nftContract() view returns (address)",
  "function remoteBridge() view returns (address)",
  "function remoteBlockchainID() view returns (bytes32)",
  "function teleporter() view returns (address)",
]);

export function bridgeEligibilityEnabled(env = process.env) {
  return String(env.GENESIS_BRIDGE_ELIGIBILITY || "").toLowerCase() === "true";
}

/**
 * Fail-closed check. Returns { eligible: false, reason } unless every verified condition holds.
 * Currently disabled by default. When enabled, still requires destination mint confirmation
 * that is not yet fully verified against live wrapped-token contract.
 */
export async function checkBridgeEligibility({ sourceProvider, grottoProvider, env = process.env }) {
  if (!bridgeEligibilityEnabled(env)) {
    return { eligible: false, reason: "BRIDGE_DISABLED", detail: "Grotto bridge eligibility is disabled pending full destination-execution verification." };
  }
  if (!sourceProvider || !grottoProvider) {
    return { eligible: false, reason: "PROVIDERS_MISSING", detail: "Source and Grotto providers required." };
  }
  try {
    const source = new Contract(SOURCE_BRIDGE, SOURCE_BRIDGE_IFACE, sourceProvider);
    const nft = await source.nftContract();
    const remote = await source.remoteBridge();
    const bcid = await source.remoteBlockchainID();
    const tele = await source.teleporter();
    if (getAddress(nft) !== getAddress(GENESIS)) return { eligible: false, reason: "WRONG_GENESIS", detail: "Source bridge nftContract mismatch." };
    if (getAddress(remote) !== getAddress(REMOTE_BRIDGE)) return { eligible: false, reason: "WRONG_REMOTE", detail: "Source remoteBridge mismatch." };
    if (bcid.toLowerCase() !== GROTTO_BLOCKCHAIN_ID.toLowerCase()) return { eligible: false, reason: "WRONG_BCID", detail: "remoteBlockchainID mismatch." };
    if (getAddress(tele) !== getAddress(TELEPORTER)) return { eligible: false, reason: "WRONG_TELEPORTER", detail: "Teleporter mismatch." };

    // Destination execution / wrapped mint confirmation not yet fully verified.
    // Fail closed until wrapped-token contract and successful destination mint can be proven.
    return { eligible: false, reason: "DESTINATION_PROOF_INCOMPLETE", detail: "TokensBridged and bindings verified, but destination mint and current wrapped balance proof not yet complete. Bridge remains fail-closed." };
  } catch (err) {
    return { eligible: false, reason: "BRIDGE_CHECK_FAILED", detail: String(err.message || err) };
  }
}

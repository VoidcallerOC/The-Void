#!/usr/bin/env node
// Read-only: the platform recipient's pull-payment balances on every
// VoidPrimarySale created by the Fuji release factories (active + historical).
//
//   node scripts/platform-earnings.mjs            # table + JSON report
//   node scripts/platform-earnings.mjs --json     # JSON only
//
// The script never signs or sends. For each sale holding a balance it prints
// the exact withdraw() transaction; the operator submits it from the platform
// recipient wallet (EOA or Safe) as a separate, explicit action. withdraw()
// pays msg.sender, so only the recipient itself can collect.
import { Interface, JsonRpcProvider, formatEther, getAddress } from "ethers";
import { FUJI_RELEASE_PER_CONTRACT_V2, FUJI_RELEASE_PER_CONTRACT_V2_DEPLOYMENTS } from "../config/release-network.js";

const RPC = process.env.AVALANCHE_FUJI_RPC_URL || process.env.FUJI_RPC_URL || FUJI_RELEASE_PER_CONTRACT_V2.rpcUrl;

const factoryIface = new Interface([
  "function releaseCount() view returns (uint256)",
  "function releaseAt(uint256) view returns (address)",
  "function primarySaleOf(address) view returns (address)",
]);
const saleIface = new Interface([
  "function balances(address) view returns (uint256)",
  "function platformRecipient() view returns (address)",
  "function withdraw()",
]);
export const WITHDRAW_CALLDATA = saleIface.encodeFunctionData("withdraw", []);

async function call(provider, to, iface, name, args = []) {
  const result = await provider.request({ method: "eth_call", params: [{ to, data: iface.encodeFunctionData(name, args) }, "latest"] });
  return iface.decodeFunctionResult(name, result)[0];
}

/** Enumerates factory releases on-chain and reads balances(recipient) on each sale. */
export async function collectPlatformEarnings(provider, { deployments = FUJI_RELEASE_PER_CONTRACT_V2_DEPLOYMENTS, recipient = FUJI_RELEASE_PER_CONTRACT_V2.platformRecipient } = {}) {
  const expected = getAddress(recipient);
  const sales = [];
  for (const deployment of deployments) {
    const factory = getAddress(deployment.factoryAddress);
    const count = Number(await call(provider, factory, factoryIface, "releaseCount"));
    for (let index = 0; index < count; index += 1) {
      const releaseContract = getAddress(await call(provider, factory, factoryIface, "releaseAt", [index]));
      const sale = getAddress(await call(provider, factory, factoryIface, "primarySaleOf", [releaseContract]));
      const saleRecipient = getAddress(await call(provider, sale, saleIface, "platformRecipient"));
      const balanceWei = BigInt(await call(provider, sale, saleIface, "balances", [expected]));
      sales.push({
        factory, factoryActive: Boolean(deployment.active), index, releaseContract, sale, saleRecipient,
        recipientMatches: saleRecipient === expected,
        balanceWei: balanceWei.toString(), balanceAvax: formatEther(balanceWei),
        ...(balanceWei > 0n ? { withdrawTransaction: { from: expected, to: sale, data: WITHDRAW_CALLDATA, value: "0" } } : {}),
      });
    }
  }
  const totalWei = sales.reduce((sum, item) => sum + BigInt(item.balanceWei), 0n);
  return { chainId: Number(FUJI_RELEASE_PER_CONTRACT_V2.chainId), recipient: expected, totalWei: totalWei.toString(), totalAvax: formatEther(totalWei), salesWithBalance: sales.filter((item) => item.withdrawTransaction).length, sales, sendsTransactions: false };
}

async function main() {
  const jsonOnly = process.argv.includes("--json");
  const rpc = new JsonRpcProvider(RPC, Number(FUJI_RELEASE_PER_CONTRACT_V2.chainId), { staticNetwork: true });
  const provider = { request: ({ method, params }) => rpc.send(method, params) };
  const report = await collectPlatformEarnings(provider);
  if (!jsonOnly) {
    console.log(`Platform recipient ${report.recipient} on chain ${report.chainId}`);
    for (const item of report.sales) {
      console.log(`${item.factoryActive ? "active    " : "historical"} #${item.index} sale ${item.sale}  ${item.balanceAvax} AVAX${item.recipientMatches ? "" : `  (sale pays ${item.saleRecipient}, not this recipient)`}`);
    }
    console.log(`Total: ${report.totalAvax} AVAX across ${report.salesWithBalance} sale(s).`);
    if (report.salesWithBalance) console.log("Nothing was sent. To withdraw, submit each withdrawTransaction below from the recipient wallet.");
  }
  console.log(JSON.stringify(report, null, 2));
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) main().catch((error) => { console.error(error); process.exit(1); });

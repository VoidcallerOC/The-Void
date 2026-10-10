import { AbiCoder, Interface, getAddress, parseEther } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { WITHDRAW_CALLDATA, collectPlatformEarnings } from "./platform-earnings.mjs";

const RECIPIENT = "0xb65C575CaE01574296Fab6E620B9A15cC0121ce4";
const ACTIVE = "0x3e4E0d9187f6fD11bD6d792a7088D0c2dE8E3aC8";
const OLD = "0xa5CbA0F91cb0A81e0A9Ce89A6722Cbe4eeC93505";
const iface = new Interface([
  "function releaseCount() view returns (uint256)",
  "function releaseAt(uint256) view returns (address)",
  "function primarySaleOf(address) view returns (address)",
  "function balances(address) view returns (uint256)",
  "function platformRecipient() view returns (address)",
]);
const coder = AbiCoder.defaultAbiCoder();
const release = (n) => getAddress(`0x${String(n).repeat(40)}`);
const sale = (n) => getAddress(`0x${String(n + 5).repeat(40)}`);

describe("platform earnings script", () => {
  it("enumerates both factories, reads balances(recipient) and only proposes withdraw() for non-zero sales", async () => {
    const releases = { [ACTIVE.toLowerCase()]: [release(1)], [OLD.toLowerCase()]: [release(2), release(3)] };
    const balances = { [sale(1).toLowerCase()]: parseEther("0.00025"), [sale(2).toLowerCase()]: 0n, [sale(3).toLowerCase()]: parseEther("0.001") };
    const provider = {
      request: vi.fn(async ({ method, params: [{ to, data }] }) => {
        expect(method).toBe("eth_call");
        const parsed = iface.parseTransaction({ data });
        const key = to.toLowerCase();
        if (parsed.name === "releaseCount") return coder.encode(["uint256"], [releases[key].length]);
        if (parsed.name === "releaseAt") return coder.encode(["address"], [releases[key][Number(parsed.args[0])]]);
        if (parsed.name === "primarySaleOf") return coder.encode(["address"], [sale(Number(parsed.args[0].slice(2, 3)))]);
        if (parsed.name === "platformRecipient") return coder.encode(["address"], [RECIPIENT]);
        if (parsed.name === "balances") { expect(parsed.args[0]).toBe(RECIPIENT); return coder.encode(["uint256"], [balances[key]]); }
        throw new Error(parsed.name);
      }),
    };
    const report = await collectPlatformEarnings(provider, { deployments: [{ factoryAddress: ACTIVE, active: true }, { factoryAddress: OLD, active: false }], recipient: RECIPIENT });
    expect(report.sendsTransactions).toBe(false);
    expect(report.sales.map((item) => [item.factory, item.sale, item.balanceAvax])).toEqual([[ACTIVE, sale(1), "0.00025"], [OLD, sale(2), "0.0"], [OLD, sale(3), "0.001"]]);
    expect(report.totalAvax).toBe("0.00125");
    expect(report.salesWithBalance).toBe(2);
    expect(report.sales[0].withdrawTransaction).toEqual({ from: RECIPIENT, to: sale(1), data: WITHDRAW_CALLDATA, value: "0" });
    expect(report.sales[1].withdrawTransaction).toBeUndefined();
    expect(provider.request.mock.calls.every(([request]) => request.method === "eth_call")).toBe(true);
  });
});

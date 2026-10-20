// Vetting aid for the collection allowlist (finding M-1): an ERC-2981 `royaltyInfo` that reads gasleft(), tx.origin or other
// per-call environment can answer differently depending on who buys and how. This samples one token id and price over several gas limits and
// callers and reports any difference. It is evidence for a human reviewer, NOT proof: it cannot see time-, block- or state-dependent logic,
// and a hostile collection can behave only at the gas levels the marketplace actually produces. Pure: the caller injects `call`.
import { Interface } from "ethers";

const ROYALTY = new Interface(["function royaltyInfo(uint256 tokenId, uint256 salePrice) view returns (address receiver, uint256 royaltyAmount)"]);
export const DEFAULT_GAS_LIMITS = Object.freeze([40_000, 100_000, 1_000_000, 30_000_000]);
export const DEFAULT_CALLERS = Object.freeze([
  "0x0000000000000000000000000000000000000001",
  "0x1111111111111111111111111111111111111111",
  "0x2222222222222222222222222222222222222222",
]);

/**
 * @param {{call: (tx: {to:string, data:string, gas:number, from:string}) => Promise<string>, token: string, tokenIds: Array<number|string|bigint>, prices?: bigint[], gasLimits?: number[], callers?: string[]}} input
 * @returns {Promise<{ok: boolean, samples: number, findings: string[]}>}
 */
export async function checkRoyaltyInvariance({ call, token, tokenIds, prices = [10n ** 18n, 333n], gasLimits = DEFAULT_GAS_LIMITS, callers = DEFAULT_CALLERS }) {
  const findings = [];
  let samples = 0;
  for (const tokenId of tokenIds) {
    for (const price of prices) {
      const data = ROYALTY.encodeFunctionData("royaltyInfo", [tokenId, price]);
      const seen = new Map();
      for (const gas of gasLimits) {
        for (const from of callers) {
          samples += 1;
          let answer;
          try { answer = String(await call({ to: token, data, gas, from })).toLowerCase(); } catch (error) { answer = `error:${String(error?.shortMessage || error?.message || error).slice(0, 80)}`; }
          if (!seen.has(answer)) seen.set(answer, []);
          seen.get(answer).push({ gas, from });
        }
      }
      if (seen.size > 1) {
        const groups = [...seen.entries()].map(([answer, where]) => `${answer.slice(0, 24)}… at gas ${[...new Set(where.map((item) => item.gas))].join("/")}`).join(" vs ");
        findings.push(`token ${tokenId} price ${price}: royaltyInfo answered differently depending on gas or caller (${groups})`);
      }
    }
  }
  return { ok: findings.length === 0, samples, findings };
}

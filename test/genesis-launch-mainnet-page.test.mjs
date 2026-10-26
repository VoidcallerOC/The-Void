import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { Interface, Signature, Wallet, getAddress, getCreateAddress, id, verifyTypedData } from "ethers";
import { describe, expect, it } from "vitest";

// The artist's mainnet Genesis launch page: every hard-coded value is recomputed here from first principles.
const html = readFileSync(new URL("../public/genesis-launch-mainnet.html", import.meta.url), "utf8");
const js = readFileSync(new URL("../public/genesis-launch-mainnet.js", import.meta.url), "utf8");
const constant = (name) => new RegExp(`var ${name} = "([^"]+)"`).exec(js)[1];
const number = (name) => Number(new RegExp(`var ${name} = (\\d+);`).exec(js)[1]);

const DEPLOYER = "0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174";
const sale = new Interface(["function configureSale(uint256,uint256,uint256,uint256,uint64,uint64,bool)", "function sales(uint256)"]);
const release = new Interface(["function grantRole(bytes32,address)", "function revokeRole(bytes32,address)", "function hasRole(bytes32,address)"]);
const early = new Interface(["function configureEarlyAccess(address,uint64,uint64)", "function earlyAccessMint((address,uint256,address,uint256,uint256,uint256,uint256,uint256,uint256),bytes)"]);
const claim = new Interface(["function earlyAccessEnabled()", "function earlyAccessClaimed()", "function earlyAccessWallet()", "function earlyAccessStart()", "function earlyAccessEnd()", "function signer()", "function admin()", "function claimStart()", "function claimEnd()", "function publicSaleEnd()", "function releaseContract()", "function primarySale()", "function tokenId()"]);

describe("mainnet Genesis launch artist page", () => {
  it("targets the live release, sale, old claim and the deployer's nonce-11 claim with the dedicated signer", () => {
    expect(js).toMatch(/var CHAIN_ID = 43114;/);
    expect(getAddress(constant("ARTIST"))).toBe("0x284C09a7CC187E096cbbdc88d99DEFE6df32180a");
    expect(getAddress(constant("RELEASE"))).toBe("0xF0C091A159DE16cF0F306b2B61d37685EC5A830e");
    expect(getAddress(constant("SALE"))).toBe("0xB4dAAe78a53c33f52C6EB573c4d6EFC7B86F3845");
    expect(getAddress(constant("OLD_CLAIM"))).toBe("0x8512be04a4E54cd8551738165F9c05C3303187a0");
    expect(getAddress(constant("NEW_CLAIM"))).toBe(getCreateAddress({ from: DEPLOYER, nonce: 11 }));
    expect(getAddress(constant("SIGNER"))).toBe("0xAD3A1026b06c2A0B2091322410254363e2764c4e");
    expect(constant("ISSUER_ROLE")).toBe(id("ISSUER_ROLE"));
  });

  it("schedules a 24h claim with the sale paused, then 7 full paid days, at 0.25 AVAX, 3 per wallet", () => {
    const [start, end, saleEnd] = [number("CLAIM_START"), number("CLAIM_END"), number("SALE_END")];
    // Mon Oct 26 2026 09:00 EDT (UTC-4) = 13:00 UTC; the sale's last second is 7 x 24 h after claim close: Tue Nov 3 12:59:59 UTC = 07:59:59 EST (DST ends Nov 1).
    expect(start).toBe(Date.UTC(2026, 9, 26, 13) / 1000);
    expect([start, end, saleEnd]).toEqual([1793019600, 1793106000, 1793710799]);
    expect(new Date(saleEnd * 1000).toLocaleString("en-US", { timeZone: "America/New_York" })).toBe("11/3/2026, 7:59:59 AM");
    expect(end - start).toBe(86_400);
    expect(saleEnd - end + 1).toBe(7 * 86_400);
    expect(saleEnd - start + 1).toBe(8 * 86_400); // the claim contract's public window: whole hours, 7-14 days
    expect(constant("PRICE_WEI")).toBe("250000000000000000");
    const args = (paused) => [1, 250000000000000000n, 0, 3, start, saleEnd, paused];
    expect(constant("RESCHEDULE")).toBe(sale.encodeFunctionData("configureSale", args(false)).toLowerCase());
    expect(constant("PAUSE")).toBe(sale.encodeFunctionData("configureSale", args(true)).toLowerCase());
    expect(constant("SALES_1")).toBe(sale.encodeFunctionData("sales", [1]).toLowerCase());
  });

  it("configures exactly one early-access test mint to 0x6a86…d2fb from 05:00 EDT to one minute before the claim", () => {
    const [earlyStart, earlyEnd, start] = [number("EARLY_START"), number("EARLY_END"), number("CLAIM_START")];
    expect(getAddress(constant("TEST_WALLET"))).toBe("0x6a86EfA012fEDA64b70112022487fEE22E67d2fb");
    expect(new Date(earlyStart * 1000).toLocaleString("en-US", { timeZone: "America/New_York" })).toBe("10/26/2026, 5:00:00 AM");
    expect(earlyStart).toBe(start - 4 * 3600);
    expect(earlyEnd).toBe(start - 60); // runbook window rule: end (first refused second) one minute before claimStart
    expect(constant("EARLY_CONFIG")).toBe(early.encodeFunctionData("configureEarlyAccess", ["0x6a86EfA012fEDA64b70112022487fEE22E67d2fb", earlyStart, earlyEnd]).toLowerCase());
    expect(js).toContain(`var EARLY_MINT = "${early.getFunction("earlyAccessMint").selector}";`);
    // The test mint is checked field by field against the fixed recipient, token 1 and quantity 1 before sending.
    expect(js).toMatch(/String\(v\.quantity\) !== "1"/);
    expect(js).toMatch(/v\.claimant\.toLowerCase\(\) !== TEST_WALLET/);
    expect(js).toMatch(/from: TEST_WALLET, title: "Test mint/);
  });

  it("grants the new claim and revokes the old one, and reads the claim's own views", () => {
    const role = id("ISSUER_ROLE");
    expect(constant("GRANT")).toBe(release.encodeFunctionData("grantRole", [role, getCreateAddress({ from: DEPLOYER, nonce: 11 })]).toLowerCase());
    expect(constant("REVOKE")).toBe(release.encodeFunctionData("revokeRole", [role, "0x8512be04a4E54cd8551738165F9c05C3303187a0"]).toLowerCase());
    expect(constant("HAS_ROLE")).toBe(release.getFunction("hasRole").selector);
    for (const name of ["earlyAccessEnabled", "earlyAccessClaimed", "earlyAccessWallet", "earlyAccessStart", "earlyAccessEnd", "signer", "admin", "claimStart", "claimEnd", "publicSaleEnd", "releaseContract", "primarySale", "tokenId"]) {
      expect(js).toContain(`${name}: "${claim.getFunction(name).selector}"`);
    }
  });

  it("sends only from a click, after re-checking, through the wallet, with zero value", () => {
    expect(js.match(/eth_sendTransaction/g)).toHaveLength(1);
    expect(js).toMatch(/async function send\(step\)[\s\S]*live = await read\(\)[\s\S]*every\([\s\S]*eth_sendTransaction/);
    expect(js).toMatch(/value: "0x0"/);
    expect(js).toMatch(/from: step\.from/);
  });

  it("asks for no key and loads no remote code", () => {
    expect(`${html}\n${js}`).not.toMatch(/private ?key|mnemonic|seed phrase|new Wallet\(|signTransaction|eth_sendRawTransaction|https?:\/\//i);
    expect(js.match(/fetch\(/g)).toHaveLength(1);
    expect(js).toContain('fetch("/api/claims/early-access/vouchers"');
    expect(html).toContain('<script src="/genesis-launch-mainnet.js"></script>');
  });
});

describe("mainnet test mint call data", () => {
  // Runs the page's own voucher check and encoder against a voucher signed by a throwaway test key.
  const source = js.slice(js.indexOf("  function w(hex)"), js.indexOf("  function row("));
  const consts = ["CHAIN_ID = 43114", `TEST_WALLET = "${constant("TEST_WALLET")}"`, `RELEASE = "${constant("RELEASE")}"`, `EARLY_START = ${number("EARLY_START")}`, `EARLY_END = ${number("EARLY_END")}`, `EARLY_MINT = "${constant("EARLY_MINT")}"`].map((c) => `var ${c};`).join("\n");
  const testKey = new Wallet(`0x${"42".repeat(32)}`);
  const domain = { name: "The Void Genesis Holder Claim", version: "1", chainId: 43114, verifyingContract: getCreateAddress({ from: DEPLOYER, nonce: 11 }) };
  const types = { EarlyAccessVoucher: ["claimant:address", "destinationChainId:uint256", "releaseContract:address", "tokenId:uint256", "quantity:uint256", "windowStart:uint256", "windowEnd:uint256", "nonce:uint256", "deadline:uint256"].map((f) => ({ name: f.split(":")[0], type: f.split(":")[1] })) };
  const voucher = { claimant: "0x6a86EfA012fEDA64b70112022487fEE22E67d2fb", destinationChainId: "43114", releaseContract: "0xF0C091A159DE16cF0F306b2B61d37685EC5A830e", tokenId: "1", quantity: "1", windowStart: String(number("EARLY_START")), windowEnd: String(number("EARLY_END")), nonce: "123456789", deadline: String(number("EARLY_END") - 1) };
  const build = async (v, signature) => {
    const ctx = { BigInt, Number, String, JSON, Error, fetch: async () => ({ ok: true, json: async () => ({ data: { voucher: v, signature } }) }) };
    runInNewContext(`${consts}\n${source}\nthis.testMintData = testMintData;`, ctx);
    return ctx.testMintData();
  };

  it("encodes earlyAccessMint(voucher, signature) exactly as ethers does, for a signature the contract can recover", async () => {
    const signature = await testKey.signTypedData(domain, types, voucher);
    const data = await build(voucher, signature);
    expect(data).toBe(early.encodeFunctionData("earlyAccessMint", [Object.values(voucher), signature]).toLowerCase());
    const [decoded, sig] = early.decodeFunctionData("earlyAccessMint", data);
    expect(getAddress(decoded[0])).toBe("0x6a86EfA012fEDA64b70112022487fEE22E67d2fb");
    expect([decoded[3], decoded[4]]).toEqual([1n, 1n]);
    expect(Signature.from(sig).serialized).toBe(signature);
    expect(verifyTypedData(domain, types, voucher, sig)).toBe(testKey.address);
  });

  it("refuses a voucher for another wallet, token, quantity or window, or a malformed signature", async () => {
    const signature = await testKey.signTypedData(domain, types, voucher);
    for (const change of [{ claimant: DEPLOYER }, { tokenId: "2" }, { quantity: "2" }, { windowStart: "1" }, { destinationChainId: "43113" }]) {
      await expect(build({ ...voucher, ...change }, signature)).rejects.toThrow(/does not match the reviewed test mint/);
    }
    await expect(build(voucher, "0x1234")).rejects.toThrow(/does not match/);
  });
});

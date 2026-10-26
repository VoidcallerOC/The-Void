import { readFileSync } from "node:fs";
import { Interface, getAddress, getCreateAddress, id } from "ethers";
import { describe, expect, it } from "vitest";

// The artist's mainnet Genesis launch page: every hard-coded value is recomputed here from first principles.
const html = readFileSync(new URL("../public/genesis-launch-mainnet.html", import.meta.url), "utf8");
const js = readFileSync(new URL("../public/genesis-launch-mainnet.js", import.meta.url), "utf8");
const constant = (name) => new RegExp(`var ${name} = "([^"]+)"`).exec(js)[1];
const number = (name) => Number(new RegExp(`var ${name} = (\\d+);`).exec(js)[1]);

const DEPLOYER = "0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174";
const sale = new Interface(["function configureSale(uint256,uint256,uint256,uint256,uint64,uint64,bool)", "function sales(uint256)"]);
const release = new Interface(["function grantRole(bytes32,address)", "function revokeRole(bytes32,address)", "function hasRole(bytes32,address)"]);
const claim = new Interface(["function signer()", "function admin()", "function claimStart()", "function claimEnd()", "function publicSaleEnd()", "function releaseContract()", "function primarySale()", "function tokenId()"]);

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
    expect([start, end, saleEnd]).toEqual([1793059200, 1793145600, 1793750399]);
    expect(end - start).toBe(86_400);
    expect(saleEnd - end + 1).toBe(7 * 86_400);
    expect(saleEnd - start + 1).toBe(8 * 86_400); // the claim contract's public window: whole hours, 7-14 days
    expect(constant("PRICE_WEI")).toBe("250000000000000000");
    const args = (paused) => [1, 250000000000000000n, 0, 3, start, saleEnd, paused];
    expect(constant("RESCHEDULE")).toBe(sale.encodeFunctionData("configureSale", args(false)).toLowerCase());
    expect(constant("PAUSE")).toBe(sale.encodeFunctionData("configureSale", args(true)).toLowerCase());
    expect(constant("SALES_1")).toBe(sale.encodeFunctionData("sales", [1]).toLowerCase());
  });

  it("grants the new claim and revokes the old one, and reads the claim's own views", () => {
    const role = id("ISSUER_ROLE");
    expect(constant("GRANT")).toBe(release.encodeFunctionData("grantRole", [role, getCreateAddress({ from: DEPLOYER, nonce: 11 })]).toLowerCase());
    expect(constant("REVOKE")).toBe(release.encodeFunctionData("revokeRole", [role, "0x8512be04a4E54cd8551738165F9c05C3303187a0"]).toLowerCase());
    expect(constant("HAS_ROLE")).toBe(release.getFunction("hasRole").selector);
    for (const name of ["signer", "admin", "claimStart", "claimEnd", "publicSaleEnd", "releaseContract", "primarySale", "tokenId"]) {
      expect(js).toContain(`${name}: "${claim.getFunction(name).selector}"`);
    }
  });

  it("sends only from a click, after re-checking, through the wallet, with zero value", () => {
    expect(js.match(/eth_sendTransaction/g)).toHaveLength(1);
    expect(js).toMatch(/async function send\(step\)[\s\S]*live = await read\(\)[\s\S]*every\([\s\S]*eth_sendTransaction/);
    expect(js).toMatch(/value: "0x0"/);
    expect(js).toMatch(/from: ARTIST/);
  });

  it("asks for no key and loads no remote code", () => {
    expect(`${html}\n${js}`).not.toMatch(/private ?key|mnemonic|seed phrase|new Wallet\(|signTransaction|eth_sendRawTransaction|https?:\/\//i);
    expect(html).toContain('<script src="/genesis-launch-mainnet.js"></script>');
  });
});

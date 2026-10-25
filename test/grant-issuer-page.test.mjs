import { readFileSync } from "node:fs";
import { Interface, getAddress } from "ethers";
import { describe, expect, it } from "vitest";

const ARTIST = "0x284C09a7CC187E096cbbdc88d99DEFE6df32180a";
const ISSUER_ROLE = "0x114e74f6ea3bd819998f78687bfcb11b140da08e9b7d222fa9c1f1ba1f2aa122";

const pages = [
  { name: "Fuji", file: "grant-issuer", chainId: 43113, release: "0xe87410E9a2c703B6BB696D4bFB5f268d3C5BCf65", claim: "0x16C7A0f55847F508c9326A4c5AEEa99CcBE488f6" },
  // Mainnet Forgive & Forget release and the verified GenesisHolderClaim (tx 0x0f4d19ce…410f, verify run 40242331652).
  { name: "Mainnet", file: "grant-issuer-mainnet", chainId: 43114, release: "0xF0C091A159DE16cF0F306b2B61d37685EC5A830e", claim: "0x8512be04a4E54cd8551738165F9c05C3303187a0" },
];

for (const { name, file, chainId, release: RELEASE, claim: CLAIM } of pages) {
const html = readFileSync(new URL(`../public/${file}.html`, import.meta.url), "utf8");
const js = readFileSync(new URL(`../public/${file}.js`, import.meta.url), "utf8");
const constant = (key) => new RegExp(`var ${key} = "([^"]+)"`).exec(js)[1];
describe(`${name} ISSUER_ROLE grant page`, () => {
  const iface = new Interface(["function grantRole(bytes32 role, address account)", "function hasRole(bytes32 role, address account)"]);

  it("hard-codes exactly the reviewed call", () => {
    expect(getAddress(constant("RELEASE"))).toBe(RELEASE);
    expect(getAddress(constant("CLAIM"))).toBe(CLAIM);
    expect(getAddress(constant("ARTIST"))).toBe(ARTIST);
    expect(constant("ISSUER_ROLE")).toBe(ISSUER_ROLE);
    expect(constant("DATA")).toBe(iface.encodeFunctionData("grantRole", [ISSUER_ROLE, CLAIM]).toLowerCase());
    expect(constant("SELECTOR")).toBe(iface.getFunction("grantRole").selector);
    expect(constant("HAS_ROLE")).toBe(iface.getFunction("hasRole").selector);
    expect(js).toMatch(new RegExp(`var CHAIN_ID = ${chainId};`));
  });

  it("submits only from the click handler, once, through the wallet, with zero value", () => {
    expect(js.match(/eth_sendTransaction/g)).toHaveLength(1);
    expect(js).toMatch(/\$\("send"\)\.addEventListener\("click"[\s\S]*eth_sendTransaction/);
    expect(js).toMatch(/value: "0x0"/);
    expect(js).toMatch(/!ready\(\)/);
  });

  it("asks for no key and loads no remote code", () => {
    expect(`${html}\n${js}`).not.toMatch(/private ?key|mnemonic|seed phrase|new Wallet\(|signTransaction|eth_sendRawTransaction|https?:\/\//i);
    expect(html).toContain(`<script src="/${file}.js"></script>`);
  });
});
}

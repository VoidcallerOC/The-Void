import { readFileSync } from "node:fs";
import { Interface, getAddress } from "ethers";
import { describe, expect, it } from "vitest";

const ARTIST = "0x284C09a7CC187E096cbbdc88d99DEFE6df32180a";
const ISSUER_ROLE = "0x114e74f6ea3bd819998f78687bfcb11b140da08e9b7d222fa9c1f1ba1f2aa122";
const iface = new Interface(["function grantRole(bytes32 role, address account)", "function hasRole(bytes32 role, address account)"]);
const read = (file) => readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8");

// A grant page never asks for, holds or uses a key, and signs nothing itself.
const KEY_MATERIAL = /private ?key|mnemonic|seed phrase|new Wallet\(|signTransaction|eth_sendRawTransaction/i;
// It runs only its own same-origin code: no off-origin script, embedded frame or stylesheet, and no
// dynamic loading, network fetch, worker, socket or string evaluation.
const REMOTE_CODE = /<script\b[^>]*\bsrc\s*=\s*(?!["']?\/[^/])|<(?:link|iframe|object|embed)\b|\bimport\s*\(|\bimport\s[^;]*\bfrom\b|\bfetch\s*\(|XMLHttpRequest|\bnew\s+Worker\b|WebSocket|\beval\s*\(|\bnew\s+Function\s*\(/i;
// The only absolute URL allowed is a Snowtrace explorer link to the submitted transaction, which the
// user opens themselves. It is navigation, not code.
const EXPLORER_LINK = 'href="https://snowtrace.io/tx/${hash}"';
const absoluteUrls = (text) => text.match(/https?:\/\/[^\s"'`<>]+/gi) ?? [];

function expectNoKeyAndNoRemoteCode(text) {
  expect(text).not.toMatch(KEY_MATERIAL);
  expect(text).not.toMatch(REMOTE_CODE);
  expect(absoluteUrls(text)).toHaveLength(text.split(EXPLORER_LINK).length - 1);
}

describe("grant page code rules", () => {
  it("reject key handling, remote code and non-explorer URLs, and accept the explorer link", () => {
    for (const bad of [
      "Paste your private key", "enter your seed phrase", "new Wallet(pk)", "eth_sendRawTransaction",
      '<script src="https://cdn.example/x.js"></script>', '<script src="//cdn.example/x.js"></script>',
      '<link rel="stylesheet" href="/x.css">', '<iframe src="/x"></iframe>', 'import("/x.js")', 'import { a } from "/x.js";',
      'fetch("/api")', "new XMLHttpRequest()", 'new Worker("/w.js")', 'new WebSocket("wss://x")', 'eval("1")', 'new Function("return 1")',
    ]) expect(() => expectNoKeyAndNoRemoteCode(bad)).toThrow();
    expect(() => expectNoKeyAndNoRemoteCode('<a href="https://evil.example/tx/1">x</a>')).toThrow();
    expect(() => expectNoKeyAndNoRemoteCode('<a href="https://snowtrace.io/address/0x1">x</a>')).toThrow();
    expect(() => expectNoKeyAndNoRemoteCode('<script src="/grant-issuer.js"></script><a href="https://snowtrace.io/tx/${hash}">tx</a>')).not.toThrow();
  });
});

// Pages that load their reviewed call from a same-origin script.
const scriptPages = [
  // public/grant-issuer.html no longer loads this script: dda4da1 replaced that page with the mainnet
  // recovery grant below. The script is still served, so its reviewed call is still checked.
  { name: "Fuji", js: "grant-issuer.js", html: null, chainId: 43113, release: "0xe87410E9a2c703B6BB696D4bFB5f268d3C5BCf65", claim: "0x16C7A0f55847F508c9326A4c5AEEa99CcBE488f6" },
  // Mainnet Forgive & Forget release and the verified GenesisHolderClaim (tx 0x0f4d19ce…410f, verify run 40242331652).
  { name: "Mainnet", js: "grant-issuer-mainnet.js", html: "grant-issuer-mainnet.html", chainId: 43114, release: "0xF0C091A159DE16cF0F306b2B61d37685EC5A830e", claim: "0x8512be04a4E54cd8551738165F9c05C3303187a0" },
];

for (const { name, js: jsFile, html: htmlFile, chainId, release: RELEASE, claim: CLAIM } of scriptPages) {
const js = read(jsFile);
const html = htmlFile ? read(htmlFile) : "";
const constant = (key) => new RegExp(`var ${key} = "([^"]+)"`).exec(js)[1];
describe(`${name} ISSUER_ROLE grant page`, () => {
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
    expectNoKeyAndNoRemoteCode(`${html}\n${js}`);
    if (htmlFile) expect(html).toContain(`<script src="/${jsFile}"></script>`);
  });
});
}

// public/grant-issuer.html: the one-shot mainnet grant of ISSUER_ROLE to the Genesis recovery claim,
// with its call inline. It submits nothing until the reviewer checks the box and clicks.
describe("Mainnet recovery ISSUER_ROLE grant page (inline)", () => {
  const html = read("grant-issuer.html");
  const RECOVERY = "0xd70dBA7fF6419481d62D4689bDf271ad441766b8";
  const RELEASE = "0xF0C091A159DE16cF0F306b2B61d37685EC5A830e";
  const constant = (key) => new RegExp(`const ${key} = "?([^";]+)"?;`).exec(html)[1];
  const send = html.indexOf("eth_sendTransaction");

  it("hard-codes exactly the reviewed call", () => {
    expect(constant("CHAIN")).toBe("43114");
    expect(getAddress(constant("FROM"))).toBe(ARTIST);
    expect(getAddress(constant("RELEASE"))).toBe(RELEASE);
    expect(constant("DATA")).toBe(iface.encodeFunctionData("grantRole", [ISSUER_ROLE, RECOVERY]).toLowerCase());
  });

  it("submits only from the reviewed click, once, from the artist wallet on C-Chain, with zero value", () => {
    expect(html.match(/eth_sendTransaction/g)).toHaveLength(1);
    expect(html).toContain('<button id="go" disabled>');
    expect(html).toMatch(/\$\("review"\)\.addEventListener\("change", \(e\) => \{ \$\("go"\)\.disabled = !e\.target\.checked; \}\);/);
    expect(html).toMatch(/\$\("go"\)\.addEventListener\("click"[\s\S]*eth_sendTransaction/);
    expect(html).toMatch(/params: \[\{ from: FROM, to: RELEASE, value: "0x0", data: DATA \}\]/);
    // The chain and account checks throw before the transaction is requested.
    expect(html.indexOf("if (chainId !== CHAIN) throw")).toBeGreaterThan(-1);
    expect(html.indexOf("if (chainId !== CHAIN) throw")).toBeLessThan(send);
    expect(html.indexOf("if (accounts[0].toLowerCase() !== FROM.toLowerCase()) throw")).toBeGreaterThan(-1);
    expect(html.indexOf("if (accounts[0].toLowerCase() !== FROM.toLowerCase()) throw")).toBeLessThan(send);
  });

  it("asks for no key, loads no remote code and links only to the Snowtrace transaction", () => {
    expectNoKeyAndNoRemoteCode(html);
    expect(absoluteUrls(html).length).toBeGreaterThan(0);
    for (const link of html.match(/<a [^>]*href="https:[^>]*>/g)) expect(link).toMatch(/target="_blank" rel="noreferrer"/);
  });
});

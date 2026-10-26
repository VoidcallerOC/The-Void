import { describe, expect, it } from "vitest";
import path from "node:path";
import { FUJI_MANIFESTS, FUJI_MANIFEST_STUB, mainnetNetworkGate } from "../build/mainnet-network-gate.js";
import { reachableChunks, scanChunk } from "../scripts/check-mainnet-bundle.mjs";

const importer = path.join("/repo", "config", "release-network.js");

describe("mainnet network gate (vite plugin)", () => {
  it("replaces the Fuji manifests imported by config/release-network.js in the mainnet build only", () => {
    const gate = mainnetNetworkGate({ network: "mainnet" });
    for (const file of FUJI_MANIFESTS) {
      const id = gate.resolveId(`./${file}`, importer);
      expect(id).toMatch(new RegExp(`${file.replace(/\./g, "\\.")}$`));
      expect(JSON.parse(gate.load(id))).toEqual(FUJI_MANIFEST_STUB);
    }
    expect(gate.resolveId("./mainnet-release.json", importer)).toBeNull();
    expect(gate.resolveId("./fuji-release.json", path.join("/repo", "server", "config.js"))).toBeNull();
    expect(mainnetNetworkGate({ network: "fuji" }).resolveId("./fuji-release.json", importer)).toBeNull();
    expect(mainnetNetworkGate({}).resolveId("./fuji-release.json", importer)).toBeNull();
  });

  it("stub carries no Fuji chain or factory, so no Fuji deployment is derived", () => {
    expect(FUJI_MANIFEST_STUB).toMatchObject({ chainId: null, chainHexId: null, factoryAddress: null, rpcUrl: null, historicalDeployments: [] });
  });
});

describe("mainnet bundle guard", () => {
  it("flags Fuji network configuration but not chain comparisons or labels", () => {
    expect(scanChunk("var a={network:`fuji`,chainId:43113,chainHexId:`0xa869`,rpcUrl:`https://api.avax-test.network/ext/bc/C/rpc`}")).toEqual(["Fuji chainId", "Fuji chainHexId", "Fuji RPC host"]);
    expect(scanChunk('x={chainId:"43113"}')).toEqual(["Fuji chainId"]);
    expect(scanChunk("o===43113?`Avalanche Fuji`:n===`43113`?`Rehearsal`:``")).toEqual([]);
    expect(scanChunk("chainId:43114,chainHexId:`0xa86a`")).toEqual([]);
  });

  it("walks static and lazy chunks from index.html", () => {
    const files = {
      "dist/index.html": '<script type="module" src="/assets/main.js"></script><link rel="modulepreload" href="/assets/vendor.js">',
      "dist/assets/main.js": 'import"./vendor.js";const r=()=>import("./route.js");',
      "dist/assets/vendor.js": "",
      "dist/assets/route.js": "",
      "dist/assets/ownerDeploy.js": "chainId:43113",
    };
    const chunks = reachableChunks("dist", (file) => files[file.split(path.sep).join("/")]);
    expect(chunks.sort()).toEqual(["assets/main.js", "assets/route.js", "assets/vendor.js"]);
  });
});

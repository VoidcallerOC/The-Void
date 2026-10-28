import { useMemo, useState } from "react";
import { Interface } from "ethers";
import { Eyebrow, Tag } from "./Atoms.jsx";
import { useWallet } from "../lib/wallet-context.js";
import { BRIDGE_CONFIG } from "../lib/bridge-config.js";

const ERC1155 = new Interface(["function setApprovalForAll(address operator, bool approved)"]);
const SOURCE_BRIDGE = new Interface(["function bridgeTokens(uint256[] tokenIds, uint256[] amounts, address recipient)"]);
const REMOTE_BRIDGE = new Interface(["function bridgeBack(uint256[] tokenIds, uint256[] amounts, address recipient)"]);

function chainFor(direction) {
  return direction === "cchain-to-grotto" ? BRIDGE_CONFIG.cChain : BRIDGE_CONFIG.grotto;
}

async function ensureBridgeChain(provider, chain) {
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chain.hexId }] });
  } catch (error) {
    if (error?.code !== 4902) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: chain.hexId, chainName: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: [chain.rpc] }],
    });
  }
}

async function sendAndWait(provider, from, to, data) {
  const hash = await provider.request({ method: "eth_sendTransaction", params: [{ from, to, data }] });
  for (;;) {
    const receipt = await provider.request({ method: "eth_getTransactionReceipt", params: [hash] });
    if (receipt) {
      if (receipt.status === "0x0") throw new Error("The transaction reverted on-chain.");
      return hash;
    }
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
}

function AddressRow({ label, value }) {
  return (
    <div style={{ padding: "14px 0", borderTop: "1px solid var(--vc-ash)" }}>
      <Eyebrow>{label}</Eyebrow>
      <code style={{ display: "block", marginTop: 8, color: "var(--vc-bone)", fontSize: 12, lineHeight: 1.5, wordBreak: "break-all" }}>{value}</code>
    </div>
  );
}

export function BridgePage() {
  const wallet = useWallet();
  const [direction, setDirection] = useState("cchain-to-grotto");
  const [tokenIds, setTokenIds] = useState("0, 1, 2, 3");
  const [amounts, setAmounts] = useState("1, 1, 1, 1");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const activeChain = useMemo(() => chainFor(direction), [direction]);

  async function runBridge() {
    const provider = wallet.getProvider();
    if (!provider) {
      setStatus("No wallet detected. Install MetaMask, Rabby, or Core.");
      return;
    }
    const ids = tokenIds.split(",").map((value) => Number(value.trim()));
    const quantities = amounts.split(",").map((value) => Number(value.trim()));
    if (!ids.length || ids.some((value) => !Number.isInteger(value) || value < 0) || quantities.length !== ids.length || quantities.some((value) => !Number.isInteger(value) || value <= 0)) {
      setStatus("Enter matching comma-separated token IDs and positive amounts.");
      return;
    }
    setBusy(true);
    setStatus("Preparing wallet…");
    try {
      let account = wallet.account;
      if (!account) {
        const result = await wallet.connect(wallet.wallets[0]?.provider || provider);
        if (result?.error) throw new Error(result.error);
        const accounts = await provider.request({ method: "eth_accounts" });
        account = accounts?.[0] || wallet.account;
      }
      if (!account) throw new Error("Connect a wallet before bridging.");
      await ensureBridgeChain(provider, activeChain);
      const recipient = account;
      if (direction === "cchain-to-grotto") {
        setStatus("Step 1 of 2 · Approve the C-Chain relic contract…");
        await sendAndWait(provider, account, BRIDGE_CONFIG.relic, ERC1155.encodeFunctionData("setApprovalForAll", [BRIDGE_CONFIG.sourceBridge, true]));
        setStatus("Step 2 of 2 · Confirm the bridge transaction…");
        await sendAndWait(provider, account, BRIDGE_CONFIG.sourceBridge, SOURCE_BRIDGE.encodeFunctionData("bridgeTokens", [ids, quantities, recipient]));
      } else {
        setStatus("Confirm the return bridge transaction…");
        await sendAndWait(provider, account, BRIDGE_CONFIG.remoteBridge, REMOTE_BRIDGE.encodeFunctionData("bridgeBack", [ids, quantities, recipient]));
      }
      setStatus("Bridge transaction confirmed. Cross-chain delivery may take a moment.");
      wallet.refreshOwnership?.(account);
    } catch (error) {
      setStatus(error?.message || "Bridge transaction failed.");
    } finally {
      setBusy(false);
    }
  }

  const buttonLabel = busy ? "PROCESSING…" : wallet.connected ? "CROSS THE VEIL" : "CONNECT WALLET";
  return (
    <section style={{ minHeight: "calc(100vh - 160px)", padding: "clamp(96px, 13vw, 150px) clamp(20px, 6vw, 64px) 100px" }}>
      <div style={{ maxWidth: 1080, margin: "0 auto" }}>
        <Eyebrow red>† THE BRIDGE · LEGACY EDITIONS</Eyebrow>
        <h1 className="vc-h1" style={{ margin: "16px 0 0", maxWidth: 820 }}>Cross the veil</h1>
        <p className="vc-body vc-body-muted" style={{ maxWidth: 650, marginTop: 24 }}>
          Move the original relic editions between Avalanche C-Chain and The Grotto through the deployed Inter-Chain Messaging bridge. The relic locks on one side while its wrapped form is delivered on the other.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.25fr) minmax(280px, .75fr)", gap: 40, marginTop: 52 }} className="vc-grid-2col">
          <div style={{ border: "1px solid var(--vc-ash)", background: "rgba(0,0,0,.35)", padding: "clamp(20px, 4vw, 36px)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <Tag kind={direction === "cchain-to-grotto" ? "crimson" : "ash"}>{chainFor(direction).short}</Tag>
                <button type="button" aria-label="Reverse bridge direction" disabled={busy} onClick={() => setDirection((value) => value === "cchain-to-grotto" ? "grotto-to-cchain" : "cchain-to-grotto")} style={{ border: "1px solid var(--vc-ash)", background: "transparent", color: "var(--vc-bone)", padding: "8px 12px" }}>↔</button>
                <Tag kind={direction === "grotto-to-cchain" ? "crimson" : "ash"}>{chainFor(direction === "cchain-to-grotto" ? "grotto-to-cchain" : "cchain-to-grotto").short}</Tag>
              </div>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--vc-bone-dim)" }}>CHAIN {activeChain.id}</span>
            </div>
            <div style={{ marginTop: 36, display: "grid", gap: 20 }}>
              <label><Eyebrow>TOKEN IDS</Eyebrow><input value={tokenIds} onChange={(event) => setTokenIds(event.target.value)} disabled={busy} inputMode="numeric" aria-label="Token IDs" style={inputStyle} /></label>
              <label><Eyebrow>AMOUNTS</Eyebrow><input value={amounts} onChange={(event) => setAmounts(event.target.value)} disabled={busy} inputMode="numeric" aria-label="Amounts" style={inputStyle} /></label>
            </div>
            <p style={{ color: "var(--vc-bone-dim)", fontSize: 13, lineHeight: 1.6, margin: "24px 0" }}>This transaction path is for the old editions only. Confirm the token IDs and amounts before signing.</p>
            <button type="button" onClick={runBridge} disabled={busy} style={primaryButton}>{buttonLabel}</button>
            {status && <p role="status" style={{ color: status.includes("confirmed") ? "var(--vc-bone)" : "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.6, marginTop: 18 }}>{status}</p>}
          </div>
          <aside style={{ borderLeft: "2px solid var(--vc-crimson)", padding: "4px 0 0 24px" }}>
            <Eyebrow red>VERIFIED DEPLOYMENT</Eyebrow>
            <AddressRow label="C-Chain bridge" value={BRIDGE_CONFIG.sourceBridge} />
            <AddressRow label="Grotto bridge" value={BRIDGE_CONFIG.remoteBridge} />
            <AddressRow label="Teleporter" value={BRIDGE_CONFIG.teleporter} />
            <AddressRow label="Relayer" value={BRIDGE_CONFIG.relayer} />
          </aside>
        </div>
      </div>
    </section>
  );
}

const inputStyle = { display: "block", width: "100%", marginTop: 10, padding: "13px 14px", border: "1px solid var(--vc-ash)", background: "var(--vc-abyss)", color: "var(--vc-bone)", fontFamily: "var(--font-mono)", fontSize: 13 };
const primaryButton = { border: "1px solid var(--vc-crimson)", background: "var(--vc-crimson)", color: "#fff", padding: "14px 18px", fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: ".16em", fontWeight: 700 };

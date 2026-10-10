import { useCallback, useEffect, useMemo, useState } from "react";
import { Eyebrow } from "./Atoms.jsx";
import { ghostBtn, primaryBtn } from "../lib/marketplace-chrome.js";
import { FUJI_RELEASE_FACTORY_V2_CONFIG, fujiExplorerUrl } from "../lib/fuji-release.js";
import { createFujiPublicProvider, formatAvax } from "../lib/primary-sale.js";
import { earningsTargets, earningsTotals, explainWithdrawError, readSaleEarnings, readStudioEarnings, withdrawSaleProceeds } from "../lib/sale-earnings.js";
import { shortAddr } from "../lib/web3.js";

const card = { border: "1px solid var(--vc-ash)", background: "var(--vc-abyss)", padding: 24 };
const mono = { fontFamily: "var(--font-mono)", fontSize: 12, wordBreak: "break-all" };
const dim = { color: "var(--vc-bone-dim)" };

/**
 * Studio "Earnings": live balances(payout) on every sale contract the artist's
 * releases are bound to (all factory versions), with a per-contract withdraw.
 */
export function StudioEarnings({ catalog, wallet, readProvider }) {
  const provider = useMemo(() => readProvider || createFujiPublicProvider({ rpcUrl: FUJI_RELEASE_FACTORY_V2_CONFIG.rpcUrl }), [readProvider]);
  const targets = useMemo(() => earningsTargets(catalog || {}), [catalog]);
  const [state, setState] = useState({ status: "idle", results: [] });
  const [withdrawals, setWithdrawals] = useState({});
  const account = wallet?.account || "";

  const load = useCallback(async () => {
    setState((prior) => ({ ...prior, status: "loading", error: "" }));
    try {
      setState({ status: "ready", results: await readStudioEarnings(provider, targets, account) });
    } catch (error) {
      setState({ status: "error", results: [], error: error?.message || "Balances could not be read from Fuji." });
    }
  }, [account, provider, targets]);

  useEffect(() => {
    let cancelled = false;
    if (!targets.length) { setState({ status: "ready", results: [] }); return undefined; }
    setState((prior) => ({ ...prior, status: "loading" }));
    readStudioEarnings(provider, targets, account)
      .then((results) => { if (!cancelled) setState({ status: "ready", results }); })
      .catch((error) => { if (!cancelled) setState({ status: "error", results: [], error: error?.message || "Balances could not be read from Fuji." }); });
    return () => { cancelled = true; };
  }, [account, provider, targets]);

  const withdraw = async (result) => {
    const key = result.primarySaleAddress.toLowerCase();
    setWithdrawals((prior) => ({ ...prior, [key]: { status: "pending" } }));
    try {
      const sent = await withdrawSaleProceeds({ walletProvider: wallet?.getProvider?.(), readProvider: provider, from: account, saleAddress: result.primarySaleAddress, chainId: result.chainId });
      setWithdrawals((prior) => ({ ...prior, [key]: { status: "confirmed", hash: sent.hash, explorerUrl: sent.explorerUrl } }));
      const refreshed = await readSaleEarnings(provider, result, account);
      setState((prior) => ({ ...prior, results: prior.results.map((item) => (item.primarySaleAddress.toLowerCase() === key ? refreshed : item)) }));
    } catch (error) {
      setWithdrawals((prior) => ({ ...prior, [key]: { status: "failed", message: explainWithdrawError(error), hash: error?.transactionHash || "", explorerUrl: error?.explorerUrl || "" } }));
    }
  };

  const totals = earningsTotals(state.results, account);

  return (
    <section style={card} aria-label="Earnings">
      <Eyebrow red>Primary sales</Eyebrow>
      <h2 style={{ fontFamily: "var(--font-display)", textTransform: "uppercase", fontSize: 36, margin: "10px 0 8px" }}>Earnings</h2>
      <p style={{ ...dim, lineHeight: 1.65 }}>
        Each release has its own sale contract. Sales proceeds stay in that contract until the payout wallet withdraws them. Balances are read live from {FUJI_RELEASE_FACTORY_V2_CONFIG.networkName}. Each withdrawal is one transaction to one sale contract.
      </p>

      {state.status === "loading" && <p role="status" style={dim}>Reading balances from Fuji…</p>}
      {state.status === "error" && <p role="alert" style={{ color: "var(--vc-crimson)" }}>{state.error}</p>}
      {state.status === "ready" && !targets.length && <p style={dim}>None of your releases is bound to a sale contract yet.</p>}

      {state.status !== "loading" && state.results.length > 0 && (
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", margin: "18px 0" }}>
          <div><Eyebrow>Total held in sale contracts</Eyebrow><div data-testid="earnings-total" style={{ fontSize: 28, marginTop: 6 }}>{formatAvax(totals.totalWei)}</div></div>
          <div><Eyebrow>Withdrawable by this wallet</Eyebrow><div data-testid="earnings-withdrawable" style={{ fontSize: 28, marginTop: 6 }}>{formatAvax(totals.withdrawableWei)}</div></div>
        </div>
      )}

      {state.results.length > 0 && (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 14 }}>
          {state.results.map((result) => {
            const key = result.primarySaleAddress.toLowerCase();
            const outcome = withdrawals[key];
            return (
              <li key={key} aria-label={`Earnings for ${result.title}`} style={{ border: "1px solid var(--vc-ash)", padding: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <strong>{result.title}</strong>
                  <span style={{ ...dim, fontFamily: "var(--font-mono)", fontSize: 11 }}>{result.factoryLabel}</span>
                </div>
                <div style={{ ...mono, ...dim, marginTop: 6 }}>
                  Sale <a href={fujiExplorerUrl("address", result.primarySaleAddress)} target="_blank" rel="noreferrer" style={{ color: "var(--vc-bone)" }}>{result.primarySaleAddress}</a>
                </div>
                {!result.payouts.length && !result.errors?.length && <p style={dim}>No balance on this sale.</p>}
                {result.payouts.map((row) => (
                  <div key={row.address} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 12 }}>
                    <div>
                      <div data-testid={`balance-${key}-${row.address.toLowerCase()}`} style={{ fontSize: 20 }}>{formatAvax(row.balanceWei)}</div>
                      <div style={{ ...mono, ...dim }}>{row.isPayout ? "Payout" : "Held for"} {row.address}</div>
                      {!row.canWithdraw && <div style={{ ...dim, fontSize: 13, marginTop: 4 }}>Only {shortAddr(row.address)} can withdraw this. Connect that wallet to withdraw.</div>}
                    </div>
                    {row.canWithdraw && (
                      <button type="button" style={row.balanceWei > 0n ? primaryBtn : ghostBtn} disabled={row.balanceWei === 0n || outcome?.status === "pending"} onClick={() => withdraw(result)} aria-label={`Withdraw from ${result.title}`}>
                        {outcome?.status === "pending" ? "Withdrawing…" : "Withdraw"}
                      </button>
                    )}
                  </div>
                ))}
                {result.errors?.map((message) => <p key={message} role="alert" style={{ color: "var(--vc-crimson)", fontSize: 13 }}>{message}</p>)}
                {outcome?.status === "confirmed" && (
                  <p role="status" style={{ ...mono, marginTop: 12 }}>Withdrawal confirmed: <a href={outcome.explorerUrl} target="_blank" rel="noreferrer" style={{ color: "var(--vc-bone)" }}>{outcome.hash}</a></p>
                )}
                {outcome?.status === "failed" && (
                  <p role="alert" style={{ color: "var(--vc-crimson)", marginTop: 12 }}>
                    {outcome.message}
                    {outcome.hash && <> <a href={outcome.explorerUrl} target="_blank" rel="noreferrer" style={{ color: "var(--vc-bone)" }}>{outcome.hash}</a></>}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {targets.length > 0 && (
        <button type="button" style={{ ...ghostBtn, marginTop: 18 }} onClick={load} disabled={state.status === "loading"}>Refresh balances</button>
      )}
    </section>
  );
}

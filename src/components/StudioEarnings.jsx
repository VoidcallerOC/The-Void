import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Eyebrow } from "./Atoms.jsx";
import { ghostBtn, primaryBtn } from "../lib/marketplace-chrome.js";
import { FUJI_RELEASE_FACTORY_V2_CONFIG, fujiExplorerUrl } from "../lib/fuji-release.js";
import { createFujiPublicProvider } from "../lib/primary-sale.js";
import { discoverFactoryBindings, earningsTargets, earningsTotals, explainWithdrawError, formatEarnings, readSaleEarnings, readSecondaryRoyalties, readStudioEarnings, switchWalletChain, walletChainState, withdrawSaleProceeds } from "../lib/sale-earnings.js";
import { shortAddr } from "../lib/web3.js";

const card = { border: "1px solid var(--vc-ash)", background: "var(--vc-abyss)", padding: 24 };
const mono = { fontFamily: "var(--font-mono)", fontSize: 12, wordBreak: "break-all" };
const dim = { color: "var(--vc-bone-dim)" };
const NETWORK = FUJI_RELEASE_FACTORY_V2_CONFIG;

/**
 * Studio "Earnings": live balances(payout) on every sale contract the artist's
 * releases are bound to (all factory versions), with a per-contract withdraw.
 * Only the payout wallet can withdraw; the platform fee is never an artist claim.
 */
export function StudioEarnings({ catalog, wallet, readProvider }) {
  const provider = useMemo(() => readProvider || createFujiPublicProvider({ rpcUrl: NETWORK.rpcUrl }), [readProvider]);
  const account = wallet?.account || "";
  // Bindings from the factories themselves, merged with the API's, so a release
  // the API has not reported still shows its sale contract.
  const [chainBindings, setChainBindings] = useState({ status: "loading", bindings: [] });
  useEffect(() => {
    let cancelled = false;
    setChainBindings({ status: "loading", bindings: [] });
    discoverFactoryBindings(provider, account)
      .then((bindings) => { if (!cancelled) setChainBindings({ status: "ready", bindings }); })
      .catch(() => { if (!cancelled) setChainBindings({ status: "ready", bindings: [] }); });
    return () => { cancelled = true; };
  }, [account, provider]);
  const targets = useMemo(() => earningsTargets({ ...(catalog || {}), releaseBindings: [...(catalog?.releaseBindings || []), ...chainBindings.bindings] }), [catalog, chainBindings]);
  const discovering = chainBindings.status === "loading";
  const [state, setState] = useState({ status: "idle", results: [] });
  const [withdrawals, setWithdrawals] = useState({});
  // Amounts proven by a Withdrawn event in a confirmed receipt during this session. A pending or
  // submitted transaction is never counted here.
  const [sessionWithdrawn, setSessionWithdrawn] = useState({});
  // Synchronous guard: React state updates are batched, so a fast double click would otherwise
  // reach withdraw() twice before `busy` renders.
  const inFlight = useRef(new Set());
  const [royalties, setRoyalties] = useState({ status: "idle", rows: [], totalWei: 0n, skipped: 0 });
  useEffect(() => {
    let cancelled = false;
    const reported = catalog?.secondaryRoyalties || [];
    if (!account || !reported.length) { setRoyalties({ status: "ready", rows: [], totalWei: 0n, skipped: 0 }); return undefined; }
    setRoyalties((prior) => ({ ...prior, status: "loading" }));
    readSecondaryRoyalties(provider, reported, account, { chainId: NETWORK.chainId })
      .then((next) => { if (!cancelled) setRoyalties({ status: "ready", ...next }); })
      .catch(() => { if (!cancelled) setRoyalties({ status: "error", rows: [], totalWei: 0n, skipped: 0 }); });
    return () => { cancelled = true; };
  }, [account, catalog?.secondaryRoyalties, provider]);

  // The wallet's chain, read without prompting and kept current on chainChanged.
  const [walletChain, setWalletChain] = useState({ ok: true, current: null });
  const [switching, setSwitching] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const walletProvider = wallet?.getProvider?.();
    if (!account || !walletProvider?.request) { setWalletChain({ ok: true, current: null, unavailable: true }); return undefined; }
    const refresh = () => walletChainState(walletProvider, NETWORK.chainId)
      .then((next) => { if (!cancelled) setWalletChain(next); })
      .catch(() => { if (!cancelled) setWalletChain({ ok: false, current: null, unavailable: true }); });
    refresh();
    walletProvider.on?.("chainChanged", refresh);
    return () => { cancelled = true; walletProvider.removeListener?.("chainChanged", refresh); };
  }, [account, wallet]);
  const switchNetwork = async () => {
    setSwitching(true);
    try {
      setWalletChain(await switchWalletChain(wallet.getProvider(), NETWORK));
    } catch (error) {
      setWalletChain((prior) => ({ ...prior, ok: false, error: explainWithdrawError(error) }));
    } finally {
      setSwitching(false);
    }
  };

  const load = useCallback(async () => {
    setState((prior) => ({ ...prior, status: "loading", error: "" }));
    try {
      setState({ status: "ready", results: await readStudioEarnings(provider, targets, account) });
    } catch (error) {
      setState({ status: "error", results: [], error: error?.message || `Balances could not be read from ${NETWORK.networkName}.` });
    }
  }, [account, provider, targets]);

  useEffect(() => {
    let cancelled = false;
    if (discovering) { setState({ status: "loading", results: [] }); return undefined; }
    if (!targets.length) { setState({ status: "ready", results: [] }); return undefined; }
    setState((prior) => ({ ...prior, status: "loading" }));
    readStudioEarnings(provider, targets, account)
      .then((results) => { if (!cancelled) setState({ status: "ready", results }); })
      .catch((error) => { if (!cancelled) setState({ status: "error", results: [], error: error?.message || `Balances could not be read from ${NETWORK.networkName}.` }); });
    return () => { cancelled = true; };
  }, [account, discovering, provider, targets]);

  const withdraw = async (result) => {
    const key = result.primarySaleAddress.toLowerCase();
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    setWithdrawals((prior) => ({ ...prior, [key]: { status: "awaiting-wallet" } }));
    try {
      const sent = await withdrawSaleProceeds({
        walletProvider: wallet?.getProvider?.(),
        readProvider: provider,
        from: account,
        saleAddress: result.primarySaleAddress,
        chainId: result.chainId,
        onSubmitted: ({ hash, explorerUrl }) => setWithdrawals((prior) => ({ ...prior, [key]: { status: "submitted", hash, explorerUrl } })),
      });
      setWithdrawals((prior) => ({ ...prior, [key]: { status: "confirmed", hash: sent.hash, explorerUrl: sent.explorerUrl, receivedWei: sent.receivedWei } }));
      setSessionWithdrawn((prior) => ({ ...prior, [key]: (prior[key] || 0n) + BigInt(sent.receivedWei) }));
      const refreshed = await readSaleEarnings(provider, result, account);
      setState((prior) => ({ ...prior, results: prior.results.map((item) => (item.primarySaleAddress.toLowerCase() === key ? refreshed : item)) }));
    } catch (error) {
      setWithdrawals((prior) => ({ ...prior, [key]: { status: "failed", message: explainWithdrawError(error), hash: error?.transactionHash || prior[key]?.hash || "", explorerUrl: error?.explorerUrl || prior[key]?.explorerUrl || "" } }));
    } finally {
      inFlight.current.delete(key);
    }
  };

  const totals = earningsTotals(state.results, account);

  return (
    <section style={card} aria-label="Earnings">
      <Eyebrow red>Primary sales</Eyebrow>
      <h2 style={{ fontFamily: "var(--font-display)", textTransform: "uppercase", fontSize: 36, margin: "10px 0 8px" }}>Earnings</h2>
      <p style={{ ...dim, lineHeight: 1.65 }}>
        Each release has its own sale contract. Your share of every sale is held in that contract until your payout wallet withdraws it. Balances are read live from {NETWORK.networkName} (chain {NETWORK.chainId}) and paid in AVAX. Each withdrawal is one transaction to one sale contract.
      </p>
      <p data-testid="platform-fee-note" style={{ ...dim, lineHeight: 1.65, fontSize: 13 }}>
        The platform fee is taken from each sale before your share is calculated. It is never part of your balance and there is nothing for you to claim for it.
      </p>

      {account && !walletChain.ok && !walletChain.unavailable && (
        <div role="alert" data-testid="wrong-network" style={{ border: "1px solid var(--vc-crimson)", padding: 14, margin: "14px 0", display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
          <span>Your wallet is on chain {walletChain.current ?? "unknown"}. Switch to {NETWORK.networkName} (chain {NETWORK.chainId}) to withdraw.{walletChain.error ? ` ${walletChain.error}` : ""}</span>
          <button type="button" style={primaryBtn} onClick={switchNetwork} disabled={switching}>{switching ? "Switching…" : `Switch to ${NETWORK.networkName}`}</button>
        </div>
      )}

      {state.status === "loading" && <p role="status" style={dim}>Reading balances from {NETWORK.networkName}…</p>}
      {state.status === "error" && <p role="alert" style={{ color: "var(--vc-crimson)" }}>{state.error}</p>}
      {state.status === "ready" && !targets.length && <p style={dim}>None of your releases is bound to a sale contract yet.</p>}

      <section aria-label="Primary sales" style={{ marginTop: 22 }}>
        <Eyebrow>Primary sales (paid at mint)</Eyebrow>
        <p style={{ ...dim, fontSize: 13, lineHeight: 1.6 }}>
          A copy is minted when it is bought, and the price is paid to the sale contract at that moment. There is no separate mint payment, so mint revenue and primary-sale revenue are the same money, counted once here.
        </p>
        {state.status !== "loading" && state.results.length > 0 && (
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", margin: "14px 0" }}>
            <div><Eyebrow>Total held in sale contracts</Eyebrow><div data-testid="earnings-total" style={{ fontSize: 28, marginTop: 6 }}>{formatEarnings(totals.totalWei)}</div></div>
            <div><Eyebrow>Withdrawable by this wallet</Eyebrow><div data-testid="earnings-withdrawable" style={{ fontSize: 28, marginTop: 6 }}>{formatEarnings(totals.withdrawableWei)}</div></div>
          </div>
        )}

        {state.results.length > 0 && (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 14 }}>
            {state.results.map((result) => {
              const key = result.primarySaleAddress.toLowerCase();
              const outcome = withdrawals[key];
              const busy = outcome?.status === "awaiting-wallet" || outcome?.status === "submitted";
              const verified = result.verification?.verified !== false;
              const settled = result.kind === "settled-satellite";
              const session = sessionWithdrawn[key] || 0n;
              // Confirmed withdrawn: the larger of the indexer's figure and receipts confirmed this
              // session (the indexer may lag), else the derived figure, which is labelled as derived.
              const baseWithdrawn = result.withdrawnIndexedWei ?? result.derivedWithdrawnWei;
              const derivedOnly = result.withdrawnIndexedWei == null && result.derivedWithdrawnWei != null && session === 0n;
              const confirmedWithdrawn = baseWithdrawn == null && session === 0n ? null : (baseWithdrawn != null && baseWithdrawn > session ? baseWithdrawn : session);
              return (
                <li key={key} aria-label={`Earnings for ${result.title}`} style={{ border: "1px solid var(--vc-ash)", padding: 16 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <strong>{result.title}</strong>
                    <span style={{ ...dim, fontFamily: "var(--font-mono)", fontSize: 11 }}>{settled ? "Settled sale" : result.factoryLabel}</span>
                  </div>
                  <div style={{ ...mono, ...dim, marginTop: 6 }}>
                    Sale <a href={fujiExplorerUrl("address", result.primarySaleAddress)} target="_blank" rel="noreferrer" style={{ color: "var(--vc-bone)" }}>{result.primarySaleAddress}</a>
                  </div>
                  {!verified && (
                    <div role="alert" data-testid={`unverified-${key}`} style={{ color: "var(--vc-crimson)", fontSize: 13, marginTop: 10 }}>
                      Withdrawal is disabled because this sale could not be verified on-chain: {result.verification.problems.join(" ")}
                    </div>
                  )}
                  {(result.earnedWei != null || confirmedWithdrawn != null) && (
                    <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginTop: 12 }}>
                      {result.earnedWei != null && <div><Eyebrow>Earned to date</Eyebrow><div data-testid={`earned-${key}`} style={{ marginTop: 4 }}>{formatEarnings(result.earnedWei)}</div></div>}
                      {confirmedWithdrawn != null && (
                        <div>
                          <Eyebrow>{derivedOnly ? "Already withdrawn (derived)" : "Already withdrawn"}</Eyebrow>
                          <div data-testid={`withdrawn-${key}`} style={{ marginTop: 4 }}>{formatEarnings(confirmedWithdrawn)}</div>
                          {derivedOnly && <div data-testid={`withdrawn-derived-${key}`} style={{ ...dim, fontSize: 12 }}>Derived as earned minus what is still held; not an indexed withdrawal.</div>}
                        </div>
                      )}
                    </div>
                  )}
                  {result.earnedWei == null && <p style={{ ...dim, fontSize: 12, margin: "10px 0 0" }}>Earned-to-date history is not available for this sale. The balance below is read live from the contract.</p>}
                  <p data-testid={`platform-line-${key}`} style={{ ...dim, fontSize: 12, margin: "10px 0 0" }}>
                    {settled
                      ? "Platform fee is paid to the platform wallet automatically in the same transaction."
                      : "The platform fee credit in this contract belongs to the platform wallet; it is not part of your balance."}
                  </p>
                  {!result.payouts.length && !result.errors?.length && <p style={dim}>No balance on this sale.</p>}
                  {result.payouts.map((row) => (
                    <div key={row.address} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 12 }}>
                      <div>
                        <Eyebrow>Available to withdraw</Eyebrow>
                        <div data-testid={`balance-${key}-${row.address.toLowerCase()}`} style={{ fontSize: 20, marginTop: 4 }}>{formatEarnings(row.balanceWei)}</div>
                        <div style={{ ...mono, ...dim }}>{row.isPayout ? "Payout wallet" : "Held for"} {row.address}</div>
                        {row.canWithdraw && row.balanceWei > 0n && <div data-testid={`receive-${key}`} style={{ ...dim, fontSize: 13, marginTop: 4 }}>You will receive {formatEarnings(row.balanceWei)} (native AVAX) at {shortAddr(row.address)}, minus network gas.</div>}
                        {!row.canWithdraw && verified && <div style={{ ...dim, fontSize: 13, marginTop: 4 }}>Only {shortAddr(row.address)} can withdraw this. Connect that wallet to withdraw.</div>}
                        {row.canWithdraw && row.balanceWei === 0n && <div style={{ ...dim, fontSize: 13, marginTop: 4 }}>Nothing to withdraw.</div>}
                      </div>
                      {row.canWithdraw && (
                        <button type="button" style={row.balanceWei > 0n ? primaryBtn : ghostBtn} disabled={row.balanceWei === 0n || busy || !walletChain.ok} onClick={() => withdraw(result)} aria-label={`Withdraw from ${result.title}`}>
                          {outcome?.status === "awaiting-wallet" ? "Confirm in wallet…" : outcome?.status === "submitted" ? "Confirming…" : "Withdraw earnings"}
                        </button>
                      )}
                    </div>
                  ))}
                  {result.errors?.map((message) => <p key={message} role="alert" style={{ color: "var(--vc-crimson)", fontSize: 13 }}>{message}</p>)}
                  {outcome?.status === "awaiting-wallet" && <p role="status" style={{ ...dim, marginTop: 12 }}>Waiting for you to confirm the withdrawal in your wallet. Nothing has been sent yet.</p>}
                  {outcome?.status === "submitted" && (
                    <p role="status" data-testid={`submitted-${key}`} style={{ ...mono, marginTop: 12 }}>Withdrawal submitted. It is not counted as withdrawn until it is confirmed: <a href={outcome.explorerUrl} target="_blank" rel="noreferrer" style={{ color: "var(--vc-bone)" }}>{outcome.hash}</a></p>
                  )}
                  {outcome?.status === "confirmed" && (
                    <p role="status" data-testid={`confirmed-${key}`} style={{ ...mono, marginTop: 12 }}>Withdrawal confirmed. {formatEarnings(outcome.receivedWei)} was sent to your wallet: <a href={outcome.explorerUrl} target="_blank" rel="noreferrer" style={{ color: "var(--vc-bone)" }}>{outcome.hash}</a></p>
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
      </section>

      <section aria-label="Secondary-sale royalties" style={{ marginTop: 28 }}>
        <Eyebrow>Secondary-sale royalties</Eyebrow>
        <p data-testid="royalty-note" style={{ ...dim, fontSize: 13, lineHeight: 1.6 }}>
          When a copy is resold on the marketplace, the royalty is sent straight to the edition's payout wallet in the same transaction. There is nothing to claim or withdraw, and these amounts are never added to the primary-sale figures above.
        </p>
        {royalties.status === "loading" && <p role="status" style={dim}>Reading royalty payout wallets…</p>}
        {royalties.status === "error" && <p role="alert" style={{ color: "var(--vc-crimson)" }}>Royalty payout wallets could not be read.</p>}
        {royalties.status === "ready" && (
          <>
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap", margin: "14px 0" }}>
              <div><Eyebrow>Royalties earned (paid to this wallet)</Eyebrow><div data-testid="royalties-earned" style={{ fontSize: 24, marginTop: 6 }}>{formatEarnings(royalties.totalWei)}</div></div>
              <div><Eyebrow>Claimable</Eyebrow><div data-testid="royalties-claimable" style={{ fontSize: 24, marginTop: 6 }}>{formatEarnings(0n)}</div></div>
            </div>
            {royalties.rows.length === 0 && <p style={dim}>No resale royalties are recorded for this wallet yet.</p>}
            {royalties.rows.length > 0 && (
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
                {royalties.rows.map((row) => (
                  <li key={`${row.tokenContractAddress}:${row.tokenId}`} data-testid={`royalty-${row.tokenContractAddress.toLowerCase()}-${row.tokenId}`} style={{ ...mono, border: "1px solid var(--vc-ash)", padding: 10 }}>
                    {formatEarnings(row.royaltyWei)} from {row.sales} resale{row.sales === 1 ? "" : "s"} · token {row.tokenId.length > 14 ? `${row.tokenId.slice(0, 6)}…${row.tokenId.slice(-4)}` : row.tokenId} · paid to {shortAddr(row.payout)}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      {targets.length > 0 && (
        <button type="button" style={{ ...ghostBtn, marginTop: 18 }} onClick={load} disabled={state.status === "loading"}>Refresh balances</button>
      )}
    </section>
  );
}

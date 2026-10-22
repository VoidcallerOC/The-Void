// The transaction the artist's wallet just sent (or the one that failed), with a link to inspect it. Evidence saved
// right after the wallet returns a hash has status "submitted": the transaction may still be confirming or may already
// have succeeded, so it is never labelled as failed. Only evidence without that status (kept from a failed call) is.
export function TransactionEvidence({ evidence, style = {} }) {
  if (!evidence) return null;
  const submitted = evidence.status === "submitted";
  return (
    <div role="status" style={{ ...style, margin: "20px 0", borderColor: submitted ? "var(--vc-bone-dim)" : "var(--vc-crimson)", fontFamily: "var(--font-mono)", fontSize: 12, wordBreak: "break-all" }}>
      <div>{submitted ? "Transaction submitted — it may still be confirming. Track it on Snowtrace:" : `Failed transaction ${evidence.code ? `(${evidence.code}) ` : ""}— inspect the exact revert on Snowtrace:`}</div>
      <a href={evidence.explorerUrl} target="_blank" rel="noreferrer" style={{ color: "var(--vc-bone)" }}>{evidence.transactionHash}</a>
      <div style={{ marginTop: 6 }}>Contract {evidence.contractAddress} · chain {evidence.chainId}</div>
    </div>
  );
}

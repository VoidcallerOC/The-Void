/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TransactionEvidence } from "./TransactionEvidence.jsx";

const HASH = "0x3a3d27a94124535c424f3e4f56d9542431f87cd841f2e12ffd50e9aa22bff06b";
const base = { transactionHash: HASH, explorerUrl: `https://snowtrace.io/tx/${HASH}`, contractAddress: "0xE744D58fA8138042f5f00a28d39f89081539C19B", chainId: 43114 };

afterEach(cleanup);

// Production incident (2026-10-22): the artist's createRelease transaction succeeded on-chain (receipt status 1, clone
// created), but Studio showed "Failed transaction — inspect the exact revert" because the submitted-transaction
// evidence was always rendered with the failure label.
describe("transaction evidence", () => {
  it("does not call a just-submitted transaction failed", () => {
    render(<TransactionEvidence evidence={{ ...base, status: "submitted" }} />);
    const box = screen.getByRole("status");
    expect(box.textContent).toMatch(/Transaction submitted/);
    expect(box.textContent).not.toMatch(/failed|revert/i);
    expect(screen.getByRole("link").getAttribute("href")).toBe(base.explorerUrl);
    expect(box.textContent).toContain("chain 43114");
  });

  it("still labels evidence kept from a failed call as failed, with its code", () => {
    render(<TransactionEvidence evidence={{ ...base, code: "ACTION_REJECTED" }} />);
    expect(screen.getByRole("status").textContent).toMatch(/Failed transaction \(ACTION_REJECTED\) — inspect the exact revert/);
  });

  it("renders nothing without evidence", () => {
    const { container } = render(<TransactionEvidence evidence={null} />);
    expect(container.textContent).toBe("");
  });
});

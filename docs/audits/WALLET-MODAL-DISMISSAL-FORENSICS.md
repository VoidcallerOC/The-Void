# The Void — Wallet Popup Dismissal Regression Forensics

**Date:** 2026-10-04 08:09 EDT  
**Repository HEAD:** `1cd67c5c1061651ad7c6e7f458df365abeaeeea5`  
**Deployed frontend tested:** `https://the-void-alpha.vercel.app`  
**Status:** **ROOT CAUSE IDENTIFIED — NO FIX APPLIED**

## STATUS

The reported UI is not a wallet SDK modal. It is the application-owned wallet-provider picker rendered by `src/components/WalletButton.jsx`.

The picker does not have an X/Close button, Cancel button, or Escape-key handler. Its implemented dismissal paths are limited to:

1. clicking outside the wrapper;
2. selecting a provider, which calls `setOpen(false)` immediately;
3. clicking the Connect button again, which toggles `open`.

The deployed picker was reproduced successfully. Outside-click dismissal works. Escape does not dismiss it. This is an **implemented-behavior gap**, not a provider-state reopen loop.

## REPRODUCED

| Mechanism | Result |
|---|---|
| Open via Connect | PASS — picker shows Rabby Wallet, Core, MetaMask, Phantom |
| X / close button | NOT APPLICABLE — no X button exists in this component |
| Cancel button | NOT APPLICABLE — no Cancel control exists |
| Escape | **FAIL** — picker remains visible |
| Click outside | PASS — picker closes |
| Select provider | PASS at app layer — picker closes via `setOpen(false)` before/while provider request runs |
| Wallet rejection/cancel | UNVERIFIED end-to-end because it invokes an external wallet provider; source catches rejection and stores an error |
| Navigation away | PASS — clicking Discover closes the picker through the document-level outside-click listener; the persistent Nav remains mounted |
| Reconnect/disconnect | UNVERIFIED as an external wallet state transition; no picker reopen path is present in source |

The observed Escape behavior is deterministic: after opening the picker, pressing Escape leaves `SELECT A BEARER WALLET` and all four provider buttons visible.

## VISIBLE MODAL TYPE

**Application-owned dropdown/popup**, not:

- Reown / WalletConnect;
- wagmi;
- viem modal;
- browser wallet popup;
- embedded provider UI.

The component is an absolutely positioned `<div>` under the wallet button:

```text
src/components/WalletButton.jsx:60-102
open && !w.connected → picker <div>
```

The application has a separate `useDialog` accessibility hook for `TransferModal` and historical `MintModal`, but that hook is not used by `WalletButton`.

## SOURCE OF TRUTH

### OPEN

```text
Nav.jsx:83-86 / 137-139
→ <WalletButton /> or compact <WalletButton />

WalletButton.jsx:18-24
→ onClick()
→ if multiple wallets are detected:
   setOpen((v) => !v)

WalletButton.jsx:60
→ open && !w.connected
→ render provider picker
```

### CLOSE

```text
WalletButton.jsx:12-16
→ useEffect installs document click listener
→ if click target is outside ref.current:
   setOpen(false)
```

Provider selection has a second close path:

```text
WalletButton.jsx:82-85
→ w.connect(wallet.provider)
→ setOpen(false)
```

The Connect button itself toggles the picker through the same `setOpen((v) => !v)` path when multiple providers exist.

### REOPEN

```text
WalletButton.jsx:18-24
→ another click on the Connect button toggles open
```

There is **no** `useEffect` that calls `setOpen(true)`, no provider listener that reopens it, and no authentication/session recovery path coupled to `open`.

## STATE / LIFECYCLE ANALYSIS

| Candidate cause | Finding |
|---|---|
| A. Close click not firing | No close/X click exists. Outside document click does fire and closes. |
| B. Close handler fires but state immediately reopens | Not observed; no reopen effect exists. |
| C. State changes but UI remains visible | Not observed for outside click or navigation. |
| D. Backdrop remains | No backdrop exists; picker is a local absolute-positioned panel. |
| E. Provider state forces it open | No source path from provider state to `setOpen(true)`. |
| F. Another component immediately reopens it | No source evidence. Nav keeps the same WalletButton mounted but does not reopen it. |
| G. Exception prevents cleanup | No exception observed through the reproduced behavior. |
| H. Focus/portal trap | No focus trap or portal is used. |
| I. Other | **Missing Escape and explicit close controls.** |

## CONSOLE / EXCEPTIONS

No application exception was visible during the open, outside-click, navigation, or Escape reproduction. The browser console inspection capability returned an unsupported-action error in the connected browser route, so a full console transcript is **UNVERIFIED**.

The source contains no keyboard listener in `WalletButton.jsx`; therefore Escape failure is explained directly by the implementation and does not require an exception to reproduce.

## GIT REGRESSION ANALYSIS

### Current implementation history

`git blame` shows the picker’s core state and dismissal logic originated in the initial wallet button implementation:

- **Commit:** `9883212` — `Initial commit: Voidcaller site`
- **Date:** 2026-06-15
- Introduced:
  - `const [open, setOpen] = useState(false)`;
  - wrapper ref;
  - document `click` outside handler;
  - provider picker conditional;
  - provider selection `setOpen(false)`.

The current `WalletButton.jsx` contains no `Escape` reference in its full Git history:

```text
git log --all -S 'Escape' -- src/components/WalletButton.jsx
→ no commits
```

### Last known-good commit

**No commit can be identified where this wallet picker supported Escape/X dismissal.** The current dismissal model has existed since `9883212`.

The last known-good behavior that can be proven from source is:

- outside-click dismissal;
- provider-selection dismissal;
- Connect-button toggle.

### Relevant accessibility commit

`16f98cd` — `Code-split routes, add asset caching, and make modals accessible` added `useDialog.js`, Escape handling, focus trapping, body-scroll locking, and close buttons to the separate modal components. It modified `MintModal` and `TransferModal`, **not `WalletButton.jsx`**.

This is the likely source of the expectation mismatch: the project gained Escape-capable modal infrastructure, but the wallet picker remained a dropdown with its original click-only dismissal behavior.

### Later wallet/auth changes

`7ecbfcd` — `feat: complete platform operations and artist studio` changed the connected-button behavior to distinguish authenticated and unauthenticated wallets. It did not change picker open/close behavior:

```text
if (w.connected && w.authenticated) { w.disconnect(); return; }
if (w.connected) { await w.authenticate(); return; }
...
setOpen((v) => !v);
```

No recent commit introduced a provider-driven reopen loop or changed the document outside-click listener.

## FIRST DIVERGENCE

There are two possible interpretations:

1. **If the requirement is “outside click should close”:** no current regression is reproduced; that behavior passes in production.
2. **If the requirement is “X, Cancel, and Escape should close”:** the first divergence is the initial implementation at `9883212`, which created a picker with only document-click dismissal and no keyboard/explicit-close path.

The accessibility work at `16f98cd` did not extend to this component, so there is no later semantic regression to isolate.

## ROOT CAUSE

**Evidence-supported root cause:** the wallet picker is implemented as a click-away dropdown, not as a dialog, and has no Escape listener or explicit close control.

The exact source of the Escape failure is:

```js
useEffect(() => {
  const onDoc = (e) => {
    if (ref.current && !ref.current.contains(e.target)) setOpen(false);
  };
  document.addEventListener("click", onDoc);
  return () => document.removeEventListener("click", onDoc);
}, []);
```

There is no corresponding `keydown` listener and no `X`/`Cancel` element.

**Not supported by evidence:** a state reopen loop, provider-state force-open, stale effect cleanup, portal bug, overlay bug, or runtime exception.

## CHANGES

**NONE.** No source, configuration, deployment, contract, database, migration, wallet-provider, or indexer changes were made.

## VERIFIED

- Current deployed picker opened successfully.
- Four provider choices rendered.
- Outside-click dismissal works.
- Escape dismissal fails.
- Navigation-away dismissal works through the existing document listener.
- Picker is app-owned, not SDK-owned.
- Open state is `WalletButton` local state: `open`.
- No `Escape` handling exists in the component’s Git history.
- No source reopen effect exists.
- Current repository HEAD is `1cd67c5c1061651ad7c6e7f458df365abeaeeea5`.

## UNVERIFIED

- Full browser console transcript because the connected browser console-view operation was unsupported.
- Exact behavior after an external provider rejects/cancels `eth_requestAccounts`.
- Whether the user’s phrase “wallet modal” refers to a separate provider-owned browser popup rather than this application picker.

## BLOCKERS

None for root-cause identification. A fix is intentionally blocked by the instruction **“NO FIX YET.”**

## DO NOT REDO

- Do not patch by forcing `open` false.
- Do not add arbitrary timeouts.
- Do not hide the picker with CSS.
- Do not alter wallet/provider configuration.
- Do not deploy or change Render/indexer configuration.
- Do not modify contracts, database data, or migrations.
- Do not claim a historical Escape-capable wallet picker commit exists.

## NEXT ACTION

**After approval to fix, add a root-cause-driven keyboard/explicit-close dismissal path to `WalletButton.jsx`—preferably an Escape listener scoped to `open` plus an accessible Close/Cancel control—then add focused component coverage for outside click, Escape, provider selection, and rejection cleanup before deployment.**

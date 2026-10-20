# Navigation integrity audit · 2026-10-19

Pre-mint audit of every navigation control in The Void, run in a real browser (headless Chromium,
desktop 1280×900 and mobile 390×844) against the mainnet production origin
`https://www.thevoidstudio.xyz` at commit `f075b39` (Vercel project `the-void-vercel-mainnet`,
deployment READY, bundle built with `VITE_RELEASE_NETWORK=mainnet`, Avalanche C-Chain 43114).

A second, independent walkthrough in a live Chrome session (PR #228) reproduced two further defects
at a 375px viewport that the first crawl's click paths did not exercise: the mobile menu staying
open over a page reached through the logo, a footer or in-page link, or browser back/forward; and
unresolved record ids being replaced by a list page with no message. Both were re-confirmed on
production before the fixes below were reconciled into one change set (PR #227).

## 1. Navigation inventory and route matrix

Route table: `src/App.jsx` (`AppRoutes`). Header: `src/components/Nav.jsx`. Footer:
`src/components/Footer.jsx`. Shell: `src/components/Layout.jsx` (nav, footer and sticky player stay
mounted; each route renders in `<main>`; `ScrollToTop` on every pathname change).

### Header (desktop ≥1181px: inline links; ≤1180px: burger menu; ≤768px: wallet button moves into the menu)

| Control | Destination | Page identity (H1) | Visible when | Verified |
|---|---|---|---|---|
| Logo (emblem + wordmark) | `/` | Hero, no H1 | always | desktop, mobile |
| DISCOVER | `/discover` | Currently featuring Voidcaller | always | desktop, mobile, keyboard |
| MARKETPLACE | `/marketplace` | Releases | always | desktop, mobile, keyboard |
| CLAIM | `/claim` | Genesis claim (claim unavailable until configured) | always | desktop, mobile |
| ARTISTS | `/artists` | Artists | always | desktop, mobile |
| COLLECTION | `/collection` | The Void (catalog of collections) | always | desktop, mobile |
| VERIFY (secondary group) | `/verify` | Become verified | always | desktop, mobile |
| ARTIST STUDIO (secondary group) | `/studio` | Create the relic (wallet-gated inside the page) | always | desktop, mobile |
| REVIEW APPLICATIONS | `/verify/review` | Applications | authorized reviewer wallet only | unit test |
| COVENANT | `/covenant` | — | `VOID_LIVE` only (off) | route absent, now Not found |
| Wallet button | none (connect / authenticate / disconnect / network notice) | — | always; dropdown only with several injected wallets | desktop, mobile |

Active highlighting: the section containing the current route (`/collection/*` → COLLECTION,
`/verify/*` → VERIFY, `/marketplace?release=…` → MARKETPLACE). Artist, release, edition and experience
pages highlight nothing. Home highlights nothing.

### Footer

| Control | Destination | Kind |
|---|---|---|
| Discover, Marketplace, Artists, Become verified, Collection, Artist studio | `/discover`, `/marketplace`, `/artists`, `/verify`, `/collection`, `/studio` | internal |
| I · Voidcaller (EP) | `/release/voidcaller-self-titled` | internal |
| II · Forthcoming | none | inert label |
| Discord, Twitter/X, Snowtrace | external | new tab, `noopener` |

### In-page controls (live catalog: one artist, one published release, one edition)

| Where | Control | Destination |
|---|---|---|
| Home | Hear the EP | plays audio (no navigation) |
| Home, Discover, My collection, Reliquary callouts | Enter / Open marketplace | `/marketplace` |
| Discover | FEATURED / ARTISTS / LIMITED EDITIONS | in-page tabs, URL unchanged |
| Discover › Featured | THE RECORD · VOIDCALLER | `/release/voidcaller-self-titled` |
| Discover › Artists, Artists | VERIFIED ARTIST · VOIDCALLER | `/artist/voidcaller` |
| Discover › Limited editions, Marketplace, Artist page | THE RELIC · View edition | `/edition/voidcaller-chapter-i` |
| Marketplace | release title on card | `/release/voidcaller-self-titled` |
| Marketplace, Edition | track rows | `/experience/voidcaller-legacy-track-{0..3}`, `/experience/voidcaller-full-ep` |
| Collection | VOIDCALLER collection card | `/collection/voidcaller-collection` |
| Collection detail | Artist · Voidcaller; release card | `/artist/voidcaller`; `/release/voidcaller-self-titled` |
| Release | artist link; View on marketplace | `/artist/voidcaller`; `/marketplace?release=voidcaller-self-titled` |
| Edition | release link; artist link (colophon); Open claim page (bound editions) | `/release/…`; `/artist/…`; `/claim/:edition` |
| Experience | artist, release, Collect / Owned, My collection | `/artist/…`, `/release/…`, `/edition/…`, `/my-collection` |
| My collection | Open reliquary, Artist studio | `/reliquary`, `/studio` |
| Collectors (orphan) | View my collection | `/my-collection` |
| Verify | Apply, View application status, Cancel, Return to The Void, Open review queue | `/verify/apply`, `/verify/dashboard`, `/verify`, `/`, `/verify/review` |
| Studio | Marketplace, Edit artist profile, Back to Studio, View public profile | `/marketplace`, `/studio/profile/:id`, `/studio`, `/artist/:id` |

### Routes with no inbound navigation control

`/collectors`, `/chronicle`, `/the-call`, `/the-bleed` (alias of `/the-call`), `/choir`,
`/admin/roles`, `/my-collection` (linked only from in-page buttons), `/reliquary` (linked only from
My collection and the marketplace callout).

## 2. Duplicate and near-duplicate destinations

Direct-load fingerprints of 32 URLs and click-driven walkthroughs on desktop and mobile: every
header, footer, logo and card control reaches a distinct URL that renders distinct content. No two
controls intended for different pages share a URL. No URL updates without the page updating, and no
page updates without its URL. No click handler is inert. Rapid adjacent clicks, back/forward, nested
refresh, trailing slash and a fresh session all land on the right page.

Near-duplicates that exist (content, not routing):

1. **One document title for every page** (defect, fixed). `index.html` set the only `<title>`; the
   app never changed it. Tab, history list, back/forward menu and bookmarks read identically on
   every page.
2. **Four consecutive pages headed VOIDCALLER**: `/artist/voidcaller` (artist name),
   `/release/voidcaller-self-titled` (release title), `/collection/voidcaller-collection`
   (collection name) and `/edition/voidcaller-chapter-i` (release title as H1, edition title below).
   Distinct eyebrows (`Verified artist`, `† Release`, `† Collection`, `† The relic`) are the only
   large-type difference. Headings left as designed; the document title now names the page kind.
3. **Five list pages that each show one Voidcaller card**: Discover (all three tabs), Artists,
   Collection, the collection detail and the artist page. The Discover › ARTISTS tab renders the
   same card as the ARTISTS page, and Discover › LIMITED EDITIONS the same card as the marketplace.
   This is the catalog's size (one artist, one release, one edition), not a routing fault; it is the
   most likely source of the "same page again" impression. Not changed.
4. **`/my-collection` and `/reliquary`** both present owned editions behind a wallet connect
   (`My collection` and `Your records`, eyebrow `† My collection` on both). Two implementations of
   one purpose. Not changed before launch; consolidation is a product decision.
5. **`/the-call` and `/the-bleed`** render the same component by design (alias). Left as is.
6. **Unknown URLs replaced by the home page, and unknown record ids replaced by a list page**
   (defect, fixed). `*` navigated to `/` with `replace`; an unknown artist, release, edition,
   experience or collection id navigated to `/artists`, `/discover`, `/marketplace`, `/discover` or
   `/collection` with `replace`. Eight addresses in all swapped the URL for a different page with no
   message, so a mistyped, stale or not-yet-published link looked like a working link elsewhere.
7. **Mobile menu order differed from the desktop header** (defect, fixed). Desktop:
   DISCOVER, MARKETPLACE, CLAIM, ARTISTS, COLLECTION | VERIFY, ARTIST STUDIO. Mobile listed VERIFY
   between ARTISTS and COLLECTION.
8. **Artist and collection pages had no catalog-loading guard** (latent defect, fixed). Release,
   edition and experience pages wait for the published catalog before deciding an id is unknown;
   the artist and collection pages decided immediately, so a direct load or refresh of a
   published-only record would have been declared missing before the catalog arrived. Only the
   static Voidcaller records exist today, so it was not reachable in production.
9. **Unlinked pages**: `/chronicle`, `/the-call`, `/the-bleed`, `/choir` and the stub
   `/collectors` are reachable only by URL. `/the-call` and `/the-bleed` carry the Tunnel Vision
   release path (the release after Forgive & Forget) and are preserved as they are. Not changed.
10. **Mobile menu stayed open across navigation** (defect, fixed; reproduced on production at
   375px). The menu closed only when one of its own items was clicked. The logo, a footer or
   in-page link, and browser back/forward changed the route underneath the full-width menu, so
   the new page was hidden and the site looked unchanged. Escape did nothing and the burger
   exposed no expanded state.

## 3. Walkthrough reproduction

Reproduced: on production, clicking ARTISTS, then the single artist card, then the single edition
card, or COLLECTION, its single card, then its single release card, shows pages whose large type
reads VOIDCALLER three or four times in a row with the same tab title, while DISCOVER, ARTISTS and
COLLECTION each show one Voidcaller card centered on an otherwise short page. The URL changed
correctly at every step and each page's content was different.

Also reproduced (375px, production): open the mobile menu on `/discover`, tap the logo → URL `/`,
menu still covering the page; open the menu, browser back → URL `/discover`, menu still covering
the page; Escape leaves the menu open. Not reproduced: any desktop control that failed to navigate,
navigated to the wrong route, or needed a second click.

## 4. Changes

- `src/lib/page-title.js` + `Layout.jsx` `DocumentTitle`: a document title per route, naming the
  artist, record, edition, experience or collection shown; flag-gated routes and not-found pages
  title as `Not found · The Void`.
- `src/components/NotFoundPage.jsx`, `src/App.jsx` `*` route, `PlatformPages.jsx`: an unknown URL
  or an unresolved artist, release, edition, experience or collection id keeps its URL and says
  what is missing, with a link back to the right list. `AppRoutes` is exported so tests mount the
  real route table.
- `src/components/Nav.jsx`: the mobile menu lists the same links in the same order as the header,
  closes on any route change (logo, footer and in-page links, back/forward) and on Escape, and the
  burger carries `aria-expanded` / `aria-controls`.
- `src/components/PlatformPages.jsx` `ArtistPage`, `CollectionDetailPage`: wait for the published
  catalog before deciding an id is unknown.

Regression tests: `src/lib/page-title.test.js`, `src/components/Nav.inventory.test.jsx`,
`src/App.routes.test.jsx` (route table in a memory router with the real header and footer: page
identity per primary destination, no duplicate identities, header clicks incl. rapid adjacent
clicks, back/forward, mobile menu incl. logo and back, in-page card journey, unknown routes and
ids with their not-found kinds and titles, loading guards, trailing slash) and
`src/navigation-integrity.test.jsx` (from PR #228: menu closes on menu item, logo, outside link,
browser back and Escape with ARIA state; each unresolved id keeps its URL with its not-found
kind; artist and collection loading guards; real records still render).

Unchanged: network configuration, contract addresses, claim logic, sale configuration, Genesis
eligibility, wallet authentication and chain validation.

# Optional X account linking

Identity linking only. A signed-in Void wallet session can prove which X account its owner controls and
show a link to it. It is **not** a login method, grants no wallet/creator/marketplace rights, and does not
post, read timelines, or sync followers.

## Flow (OAuth 2.0 Authorization Code + PKCE, S256)
1. `POST /api/x-link/start` (wallet bearer session required, rate limited). Server creates a CSPRNG `state`
   and PKCE verifier, stores `sha256(state)`, the verifier, the wallet and `sha256(session token)` (10 min TTL,
   one pending attempt per wallet), and returns the X authorize URL. The UI opens it in a pop-up so the in-memory
   wallet session survives.
2. User authorizes on `https://x.com/i/oauth2/authorize`. X redirects the pop-up to `/x/callback`, which holds no
   session: it only `postMessage`s `{code,state|error}` to its same-origin opener and clears the URL.
3. The opener calls `POST /api/x-link/callback` with its own bearer session. The server atomically consumes the
   attempt (state + wallet + **initiating session** + unexpired + unused), exchanges the code at
   `POST https://api.x.com/2/oauth2/token` (confidential client, Basic auth), reads `GET /2/users/me`
   (`user.fields=id,username,name,profile_image_url`), revokes the token (best effort) and stores the link.
4. `GET /api/x-link` returns the caller's own status. `POST /api/x-link/disconnect` with `{"confirm":true}` deletes
   the caller's own row.

## Schema (migration `042_x_account_links.sql`)
- `x_account_links`: `wallet_address` PK, `x_user_id` **UNIQUE** (the external key), `x_username`, `x_display_name`,
  `x_profile_image_url`, `status`, `connected_at`, `verified_at`, `updated_at`. RLS enabled (deny all PostgREST).
- `x_link_attempts`: `state_hash` PK, wallet, `session_hash`, `code_verifier`, expiry, `consumed_at`. RLS enabled.
- An X account already linked elsewhere gives `409 X_ACCOUNT_ALREADY_LINKED` (never transferred). A different X
  account on an already-linked wallet gives `409 X_LINK_EXISTS` (disconnect first). Same account = refresh.

## Data retention
Stored: wallet, X user id, username, display name, profile image URL (twimg HTTPS only), timestamps.
**Not stored:** X access/refresh tokens (none requested: no `offline.access`), authorization codes, passwords.
Disconnect deletes the row. Link/unlink are written to `audit_events` (wallet + X user id only).

## Configuration (server only; placeholders)
| Variable | Purpose |
| --- | --- |
| `X_OAUTH_CLIENT_ID` | OAuth 2.0 client id of the X app |
| `X_OAUTH_CLIENT_SECRET` | confidential-client secret (Render secret; never `VITE_`) |
| `X_OAUTH_REDIRECT_URI` | exact registered callback, `https://<app origin>/x/callback` |
| `X_OAUTH_SCOPES` | optional, default `users.read tweet.read` |

X developer app: enable User authentication with OAuth 2.0, type Web App/confidential client, permission Read,
register the callback URL exactly as `X_OAUTH_REDIRECT_URI`. Distinct from the `X_API_*` OAuth 1.0a reviewer-DM
credentials. Without configuration the API answers `503 X_LINK_NOT_CONFIGURED` and the UI says linking is
unavailable; nothing is faked.

## Cost
X documents pay-per-usage pricing, with User Read listed at about **$0.010 per resource returned**. One connection
makes exactly one `users/me` read (plus a token exchange and a revoke, for which no per-call charge is documented), so
roughly **$0.01 per connect or refresh**; no polling or other calls. Verify current rates in the X Developer Console
before launch; prices change.

## Scopes caveat
`GET /2/users/me` is documented under `tweet.read` + `users.read`; `users.read` alone may be rejected. Confirm in
the console and adjust `X_OAUTH_SCOPES` if X permits fewer.

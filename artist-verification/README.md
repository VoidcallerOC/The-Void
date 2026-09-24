# The Void — Artist Verification

Artist verification for The Void: apply, review, decide, and mark verified identities.

This directory is a standalone TanStack Start app. It is **additive** — it does not replace the live Voidcaller site at the repo root.

## Flow

Artist → Application → Review → Decision → Verified Artist Profile

Routes:

- `/verify` — become verified
- `/verify/apply` — application form
- `/verify/received` — submission receipt
- `/dashboard` — applicant status
- `/review` — reviewer queue
- `/artists` — verified identities
- `/login` — account

Verified badges are driven by `application.status === VERIFIED` in Postgres, never by a frontend fixture.

## Type

Display headlines use the official **Voidcaller** face (`public/fonts/Voidcaller-Regular.ttf`) — the same cut as the VOIDCALLER wordmark. Body is Archivo. Terminal/meta is JetBrains Mono.

## Run

```bash
cd artist-verification
npm install
npm run dev
```

Auth and the application database use the project's Better Auth + Postgres/PGLite wiring.

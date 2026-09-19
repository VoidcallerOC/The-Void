# Metadata publishing

Artist Studio generates canonical ERC-1155 metadata on the server. Artists provide release information, artwork references, collector benefits, and experiences; they do not provide a URI, JSON document, contract address, chain ID, or token ID.

## Storage provider

The production adapter is Pinata's server-side JSON pinning API. The browser never receives the Pinata credential. The adapter accepts only a successful provider response containing a CID beginning with `bafy` or `Qm`, then returns an immutable `ipfs://` URI. Storage failures and malformed provider responses fail closed.

Configure the following environment variables in the server environment:

| Variable | Required | Description |
|---|---:|---|
| `METADATA_STORAGE_DRIVER` | Yes for publication | Must be `pinata`; when absent, publication returns a clear not-configured error. |
| `PINATA_JWT` | Yes when the driver is `pinata` | Server-side Pinata JWT. Never expose it to the frontend. |
| `PINATA_PIN_JSON_ENDPOINT` | No | HTTPS Pinata pinning endpoint; defaults to `https://api.pinata.cloud/pinning/pinJSONToIPFS`. |
| `PINATA_GATEWAY_URL` | No | Gateway base URL for downstream display; defaults to `https://gateway.pinata.cloud/ipfs/`. |

No local filesystem fallback is used for metadata. The existing filesystem media driver remains separate and is not used to publish metadata.

## Pinata operation and required API-key scope

The metadata publisher performs exactly one provider call:

| Property | Value |
|---|---|
| Hostname | `api.pinata.cloud` (public network) |
| Endpoint | `POST /pinning/pinJSONToIPFS` (overridable via `PINATA_PIN_JSON_ENDPOINT`) |
| API generation | Legacy JSON pinning API (public IPFS), distinct from the V3 Files API used for protected media |
| Required key scope | **`pinJSONToIPFS`** (the legacy *Pinning* endpoint permission) |

Pinata scoped API keys are endpoint-authorized. A key that authenticates
successfully (`GET https://api.pinata.cloud/data/testAuthentication` → `200`)
but lacks the `pinJSONToIPFS` permission is rejected by the upload with
`HTTP 403` and provider code `NO_SCOPES_FOUND`. This is a **credential scope
configuration** problem, not an application bug: the release is valid, the
route is reached, and publication correctly fails closed with nothing written
on-chain. The publisher surfaces this as `METADATA_STORAGE_UNAVAILABLE` with
the operator-facing guidance *"Metadata storage authorization failed. Check the
configured Pinata API key permissions."* while retaining the provider status
and code internally. The JWT, bearer token, and any signed URL are never
exposed.

### Metadata key vs. protected-media key

`server/config.js` reads the same `PINATA_JWT` for both drivers, but the two
drivers exercise different Pinata scopes:

| Concern | Network | Endpoint | Required scope |
|---|---|---|---|
| Canonical metadata | Public IPFS | `POST /pinning/pinJSONToIPFS` | `pinJSONToIPFS` |
| Protected media download link | Private IPFS (V3 Files) | `POST /v3/files/private/download_link` | V3 Files access |

A single Pinata key can hold **both** scope sets, so metadata and protected
media may share one credential safely — provided that credential is granted
the `pinJSONToIPFS` legacy pinning scope *in addition to* the V3 Files scopes
the protected-media path already relies on. The production media key currently
carries only the V3 Files scopes, which is why metadata publication returns
`NO_SCOPES_FOUND` while protected media works.

### Remediation (least privilege)

1. In the Pinata dashboard, create a key that grants **only** the
   `pinJSONToIPFS` pinning scope plus the existing V3 Files scopes required for
   protected media. Do **not** enable Admin or unrelated broad scopes. Pinata
   scoped keys are immutable, so this is a new key rather than an edit of the
   existing one.
2. Update the `PINATA_JWT` secret in Render (it is `sync: false`; never commit
   it or paste it into logs, chat, or the browser).
3. If protected media and metadata must be isolated for blast-radius reasons,
   split them into two keys later; that requires a second server-only secret
   and a small config change and is optional — one correctly scoped key is
   sufficient.

### Diagnosing the credential

`node scripts/pinata-metadata-diagnostic.mjs` classifies the credential from
the server runtime without exposing it:

- **A** — `testAuthentication` fails → the credential itself is invalid,
  expired, or unusable.
- **B** — `testAuthentication` succeeds but the metadata upload returns
  `403 NO_SCOPES_FOUND` → the credential is valid but lacks `pinJSONToIPFS`.
- **C** — the metadata upload succeeds → the scope is present.

By default the script runs only the credential check. Pass `--probe` (or set
`CERT_PROBE_METADATA=1`) to exercise the exact `pinJSONToIPFS` upload; the probe
pins a tiny throwaway object and best-effort unpins it. All output is
sanitized.

## Metadata schema

The generated document includes only fields populated by the existing domain model: `name`, `description`, `image` when a durable artwork URL is supplied, `artist`, `release` information, `collectorBenefits`, `experiences`, and `attributes` for supply and tier. The canonical JSON is deterministically ordered and hashed before upload. A retry with unchanged release data reuses the persisted URI; changed metadata produces a new immutable object.

Artwork must already be a durable URL. Browser-local files are not accepted as metadata artwork. Production artwork upload remains a separate dependency if the product needs artists to upload files rather than provide durable artwork references.

## Publication flow

`POST /api/studio/releases/:releaseId/metadata` requires the existing authenticated Artist Studio wallet and release ownership. It generates and stores metadata, then persists the URI on the edition token record. The browser prepares `createEdition()` only after receiving that real URI and uses the certified Avalanche Fuji configuration.

After the wallet transaction, `POST /api/studio/releases/:releaseId/publication/confirm` independently verifies the Fuji receipt, `EditionCreated` event, token ID, release ID, edition ID, metadata URI, and `edition(tokenId)` result through the configured Fuji RPC endpoint. Only then are the edition and release transitioned to `PUBLISHED`.

If metadata succeeds but the blockchain transaction or verification fails, metadata remains safely persisted and the release remains unpublished and retryable. No arbitrary contract, chain, token, or URI can be supplied through the Artist Studio publication path.

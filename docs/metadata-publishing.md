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

## Metadata schema

The generated document includes only fields populated by the existing domain model: `name`, `description`, `image` when a durable artwork URL is supplied, `artist`, `release` information, `collectorBenefits`, `experiences`, and `attributes` for supply and tier. The canonical JSON is deterministically ordered and hashed before upload. A retry with unchanged release data reuses the persisted URI; changed metadata produces a new immutable object.

Artwork must already be a durable URL. Browser-local files are not accepted as metadata artwork. Production artwork upload remains a separate dependency if the product needs artists to upload files rather than provide durable artwork references.

## Publication flow

`POST /api/studio/releases/:releaseId/metadata` requires the existing authenticated Artist Studio wallet and release ownership. It generates and stores metadata, then persists the URI on the edition token record. The browser prepares `createEdition()` only after receiving that real URI and uses the certified Avalanche Fuji configuration.

After the wallet transaction, `POST /api/studio/releases/:releaseId/publication/confirm` independently verifies the Fuji receipt, `EditionCreated` event, token ID, release ID, edition ID, metadata URI, and `edition(tokenId)` result through the configured Fuji RPC endpoint. Only then are the edition and release transitioned to `PUBLISHED`.

If metadata succeeds but the blockchain transaction or verification fails, metadata remains safely persisted and the release remains unpublished and retryable. No arbitrary contract, chain, token, or URI can be supplied through the Artist Studio publication path.

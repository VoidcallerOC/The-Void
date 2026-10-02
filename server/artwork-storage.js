import { Buffer } from "node:buffer";

// Artwork is public by design: cards, edition pages and NFT metadata all show
// it. Uploads stay under 3 MB so the base64 JSON body (~4 MB) fits through the
// Vercel /api rewrite.
export const MAX_ARTWORK_BYTES = 3 * 1024 * 1024;

const SIGNATURES = [
  { contentType: "image/png", extension: ".png", matches: (bytes) => bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { contentType: "image/jpeg", extension: ".jpg", matches: (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  { contentType: "image/gif", extension: ".gif", matches: (bytes) => bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("latin1")) },
  { contentType: "image/webp", extension: ".webp", matches: (bytes) => bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP" },
];

/** The image type proven by the file's own bytes, or null. The client's
 * declared content type is never trusted. */
export function sniffArtwork(bytes) {
  const found = SIGNATURES.find((signature) => signature.matches(bytes));
  return found ? { contentType: found.contentType, extension: found.extension } : null;
}

export function createPinataArtworkUploader({ jwt, fetchImpl = fetch, endpoint = "https://uploads.pinata.cloud/v3/files" }) {
  if (!jwt) throw new Error("Pinata artwork uploads need PINATA_JWT.");
  return async ({ body, filename, contentType }) => {
    const form = new FormData();
    form.append("network", "public");
    form.append("file", new Blob([body], { type: contentType }), filename);
    const response = await fetchImpl(endpoint, { method: "POST", headers: { authorization: `Bearer ${jwt}` }, body: form });
    if (!response.ok) {
      const authorization = response.status === 401 || response.status === 403;
      throw Object.assign(new Error(authorization ? "The Pinata key is not allowed to upload files. Give it file-upload permission in Pinata." : `Artwork upload failed (Pinata HTTP ${response.status}).`), { status: 502, code: authorization ? "ARTWORK_UPLOAD_UNAUTHORIZED" : "ARTWORK_UPLOAD_FAILED" });
    }
    const payload = await response.json();
    const cid = payload?.data?.cid || payload?.cid;
    if (typeof cid !== "string" || !/^(?:baf[a-z0-9]+|Qm[1-9A-HJ-NP-Za-km-z]+)$/.test(cid)) throw Object.assign(new Error("Artwork upload did not return an IPFS CID."), { status: 502, code: "ARTWORK_UPLOAD_FAILED" });
    return { uri: `ipfs://${cid}` };
  };
}

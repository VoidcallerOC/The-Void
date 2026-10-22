// An edition already created on-chain cannot be created again or have its metadata changed. When Studio finds
// that out (EDITION_ALREADY_ON_CHAIN), it reconciles through the confirm endpoint instead of sending a second
// creation transaction. A differing on-chain metadata URI is adopted only after the artist explicitly accepts it.
export async function reconcileExistingEdition({ studioFetch, confirmPath, headers, askToAdopt }) {
  try {
    return await studioFetch(confirmPath, { method: "POST", payload: {}, headers });
  } catch (error) {
    if (error?.code !== "METADATA_URI_MISMATCH") throw error;
    const accepted = await askToAdopt({ onChainMetadataUri: error.details?.onChainMetadataUri, draftMetadataUri: error.details?.draftMetadataUri });
    if (!accepted) throw Object.assign(new Error("The edition already exists on-chain with different metadata. Nothing was changed; your draft metadata is untouched."), { code: "ADOPTION_DECLINED" });
    return studioFetch(confirmPath, { method: "POST", payload: { acceptOnChainMetadata: true }, headers });
  }
}

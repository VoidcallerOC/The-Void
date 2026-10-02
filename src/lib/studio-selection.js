export function selectReleaseTemplate(record) {
  const release = record?.release || {};
  return {
    artistId: "",
    releaseId: "",
    editionId: "",
    selectedReleaseId: "",
    form: {
      releaseTitle: release.title || "",
      releaseDescription: release.description || "",
      releaseArtwork: release.artwork || "",
      trackArtwork: "",
    },
  };
}

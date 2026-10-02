export function selectReleaseTemplate(record) {
  const artist = record?.artist || {};
  const release = record?.release || {};
  return {
    artistId: "",
    releaseId: "",
    editionId: "",
    selectedReleaseId: "",
    form: {
      artistName: artist.name || "",
      artistBio: artist.bio || "",
      releaseTitle: release.title || "",
      releaseDescription: release.description || "",
      releaseArtwork: release.artwork || "",
      trackArtwork: "",
    },
  };
}

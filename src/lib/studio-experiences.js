import { experienceCategory, experienceCategoryLabel } from "../domain/models.js";

// A release's private files are separate collector experiences, never competing
// versions of one: the full track ("full-track") and the file the artist adds on
// the Experiences step ("experience-audio", e.g. a 30-second demo). The public
// preview is a third, independent asset that never appears here.
export const FULL_TRACK_ROLE = "full-track";
export const EXPERIENCE_AUDIO_ROLE = "experience-audio";

// One stable id per role on an edition, so saving again updates that experience
// instead of adding another, and replacing one file never touches the other.
export function experienceIdFor(editionId, role) {
  return `experience-${editionId}-${role}`;
}

const protectedEntry = (asset) => ({ assetId: asset.assetId, mediaType: asset.mediaType || "AUDIO", contentType: asset.contentType });

/**
 * The experiences "Save catalog structure" writes, in the order they are saved.
 * Each has its own id, category, title and asset.
 *
 * - Both files uploaded: two experiences. The demo/experience file keeps the
 *   selected category, title and description. The full track becomes a
 *   "Full record" experience and never inherits the demo's description.
 * - Only the full track: one experience, as before (the selected category when
 *   it delivers audio, otherwise "Full record").
 * - Only the experience file: one experience, as before.
 *
 * The full track is designated the edition's primary experience (primary: true) and the
 * demo is explicitly not (primary: false). Collectors' main Play button follows that
 * designation, never save order or update times, so editing, replacing or re-saving either
 * file cannot change which experience is primary.
 */
export function planCatalogExperiences({ editionId, productType, experienceTitle = "", experienceDescription = "", trackTitle = "", releaseTitle = "", fullTrack = null, experienceAudio = null }) {
  if (!editionId) throw new Error("Save the track draft before configuring its experience.");
  const selectedDelivery = experienceCategory(productType)?.deliveryType || "AUDIO";
  const plans = [];

  if (experienceAudio) {
    if ((experienceAudio.mediaType || "AUDIO") !== selectedDelivery) {
      throw new Error(`The experience file was uploaded as ${experienceAudio.mediaType || "AUDIO"}, but the selected experience delivers ${selectedDelivery}. Upload the experience file again.`);
    }
    plans.push({
      role: EXPERIENCE_AUDIO_ROLE,
      asset: experienceAudio,
      id: experienceIdFor(editionId, EXPERIENCE_AUDIO_ROLE),
      payload: {
        id: experienceIdFor(editionId, EXPERIENCE_AUDIO_ROLE),
        title: experienceTitle || experienceCategoryLabel(productType),
        description: experienceDescription,
        experienceType: selectedDelivery,
        productType,
        requirements: [],
        // Explicitly not primary when the full track is saved with it; a demo saved alone stays undesignated.
        mediaConfig: { protected: true, protectedMedia: [protectedEntry(experienceAudio)], ...(fullTrack ? { primary: false } : {}) },
      },
    });
  }

  if (fullTrack) {
    const alone = !experienceAudio;
    const keepsSelection = alone && selectedDelivery === (fullTrack.mediaType || "AUDIO");
    const category = keepsSelection ? productType : "FULL_RECORD";
    plans.push({
      role: FULL_TRACK_ROLE,
      asset: fullTrack,
      id: experienceIdFor(editionId, FULL_TRACK_ROLE),
      payload: {
        id: experienceIdFor(editionId, FULL_TRACK_ROLE),
        title: keepsSelection ? (experienceTitle || experienceCategoryLabel(category)) : (trackTitle || releaseTitle || experienceCategoryLabel(category)),
        description: keepsSelection ? experienceDescription : "",
        experienceType: experienceCategory(category).deliveryType,
        productType: category,
        requirements: [],
        mediaConfig: { protected: true, protectedMedia: [protectedEntry(fullTrack)], primary: true },
      },
    });
  }

  return plans;
}

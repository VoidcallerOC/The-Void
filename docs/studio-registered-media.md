# Re-attaching registered media in Studio

Studio keeps an upload's result (`fullTrack`, `experienceAudio`, `trackPreview`) only in the page. Reopening
a draft therefore shows empty upload controls even though the files are registered. Studio now offers the
artist's own registered files instead of asking for the same upload again.

- `GET /api/studio/artists/:artistId/media/registered` (owner wallet only) returns
  - `protected`: the artist's `PROTECTED` private files that no experience uses yet, as
    `{ assetId, mediaType, byteSize, contentType, registeredAt }`;
  - `previews`: public preview addresses the artist uploaded before, newest first, as
    `{ uri, contentType, byteSize, uploadedAt }`.
  It never returns storage keys, hashes, links or tokens.
- Selecting a file sets the same Studio state an upload would set. "Save catalog structure" then runs
  unchanged: stable experience ids, full track `primary: true`, demo `primary: false`, preview in the
  edition metadata only.
- Server checks on every save (`createExperience` / `updateExperience`): the file belongs to the artist,
  is `PROTECTED` (`PROTECTED_MEDIA_NOT_PROTECTED`), has the declared type
  (`PROTECTED_MEDIA_TYPE_MISMATCH`), and is not already used by a different edition
  (`PROTECTED_MEDIA_IN_USE`). Re-saving the same edition is allowed and creates no duplicate.
  The exclusivity check and the save run in one transaction behind a per-file Postgres advisory lock
  (`saveExperienceExclusively`), so two simultaneous saves of the same file for different editions
  cannot both succeed: the second waits for the first to commit, then is refused.
  Publication goes through the same lock (`publishExperience`): it re-reads each experience `FOR UPDATE`
  after taking the file locks and writes the row's current configuration, never the list it read at the
  start, so a stale snapshot cannot put a file back on an edition after another edition claimed it. An
  experience whose file another edition holds is left unpublished and logged
  (`studio.publication.experience_blocked`); the rest of the release still publishes.
  Locks are always taken file locks first (sorted), then the row, so the paths cannot deadlock.

  Known gap: the one-primary-per-edition check is still check-then-write. Two simultaneous saves in one
  edition can both set `primary: true`; the collector page then shows no gated Play (fail-safe) until it
  is fixed in Studio. A partial unique index or an edition-scoped lock would close it.
- A preview is accepted only if this artist uploaded it before and it is not a private object
  (`PREVIEW_AUDIO_NOT_REGISTERED`, `PREVIEW_AUDIO_IS_PRIVATE`).

Re-uploading a WAV master would not reuse the stored file: each upload is tagged with its own bytes, so
it would register a new, separate copy.

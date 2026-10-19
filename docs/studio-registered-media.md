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

  One primary per edition is enforced the same way. `createExperience` and `updateExperience` run in
  `withEditionExperiences`: one transaction, one connection, with the lock order **edition lock, then
  file locks (sorted), then the row write**. The edition's experiences are read after the locks, so the
  "carry over the stored designation" and the "no other primary" check use committed state; a
  competing save waits for the lock and then gets `PRIMARY_EXPERIENCE_CONFLICT` instead of committing a
  second primary. Saves for different editions do not wait on each other. Publication takes file locks
  and its own row only (it never changes a designation), so it cannot form a lock cycle with these paths.
  Collectors still fail closed on an ambiguous or missing designation (`resolvePrimaryExperience`) for
  legacy or corrupted rows.

Re-uploading a WAV master would not reuse the stored file: each upload is tagged with its own bytes, so
it would register a new, separate copy.

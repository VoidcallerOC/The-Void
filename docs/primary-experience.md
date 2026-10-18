# Primary experience

An edition can have several protected experiences (for example the full track and a separate
30-second demo). Its **primary experience** is the one the edition page's main Play button plays
for entitled holders. Every experience, including the demo, keeps its own id, page, asset and
authorization grant.

## Designation

The designation lives in the experience's existing `media_config` JSON: `primary: true` or
`primary: false`. No schema change or migration is involved.

- Studio's "Save catalog structure" saves the full track with `primary: true` and the demo with
  `primary: false`. A demo saved alone is left undesignated.
- A save that does not mention `primary` keeps the stored value, so replacing or editing either
  file never changes it. Replacing the demo cannot move the primary.
- The server accepts only booleans and refuses a second `primary: true` on the same edition
  (`PRIMARY_EXPERIENCE_CONFLICT`).
- The public experience listing returns it as `primary_experience` (true, false, or null when
  never set). `media_config` itself is never exposed.

## Resolution (`primaryExperience` in `src/domain/models.js`)

| Experiences of the edition | Main Play plays |
| --- | --- |
| exactly one has `primary: true` | that one, wherever it sorts |
| some have a designation, but none or several are `true` | none: the button plays only the public preview and never promotes another experience |
| none has a designation (Genesis, releases saved before this) | the first listed, as before |

The public listing is ordered by `updated_at DESC`, and publishing rewrites every experience's
`updated_at`, so order and timestamps are never used when a designation exists.

## Rollback

Reverting the change returns to "first listed". Stored `primary` flags are ignored by older code
and harmless.

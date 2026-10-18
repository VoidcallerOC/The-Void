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

## Resolution (`resolvePrimaryExperience` in `src/domain/models.js`)

| Experiences of the edition | State | Edition page |
| --- | --- | --- |
| exactly one has `primary: true` and is a gated experience | `designated` | main Play plays it, wherever it sorts |
| none has a designation (Genesis, releases saved before this) | `legacy` | the first listed, as before |
| some have a designation, but none is `true` | `missing` | gated Play withheld |
| more than one is `true` | `ambiguous` | gated Play withheld |
| a non-boolean flag, or the `true` one is not a gated experience | `invalid` | gated Play withheld |

When the gated Play is withheld the page shows "Full-track playback is unavailable for this
edition right now." and, as a separate control labelled **Play public preview**, the public preview
clip. That control never carries a protected experience, so it can never request a grant for the demo
or the full track. The other experiences stay reachable on their own pages.

The public listing is ordered by `updated_at DESC`, and publishing rewrites every experience's
`updated_at`, so order and timestamps are never used when a designation exists.

## Rollback

Reverting the change returns to "first listed". Stored `primary` flags are ignored by older code
and harmless.

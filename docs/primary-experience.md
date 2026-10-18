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

The same rules apply to every Play control that stands for an edition's full track: the edition
page, the release tile and the owned-collection tile (`primaryPlayback` in `src/domain/models.js`,
rendered by `PrimaryPlayButton`). A release track that names its own `experienceId` keeps it.

When the primary is `missing`, `invalid` or `ambiguous` the control is a button labelled **Play public
preview** next to the notice "Full track unavailable". Its track is built without any protected
experience (a protected media reference attached to a built-in track is removed), so it can never
request a grant for the demo or the full track. Wallet ownership and authorization are unchanged. The
other experiences stay reachable on their own pages.

The public listing is ordered by `updated_at DESC`, and publishing rewrites every experience's
`updated_at`, so order and timestamps are never used when a designation exists.

## Rollback

Reverting the change returns to "first listed". Stored `primary` flags are ignored by older code
and harmless.

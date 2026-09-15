---
"@pithy-sh/organization": patch
---

A short name is derived from the name, not demanded from the caller.

`POST {base}` required a `slug`, so every client had to invent one and the server took whatever it was given. It is optional now. Omitted, the server derives it from the display name and the unique constraint settles it: a collision retries with a suffix rather than asking first, because a check-then-write has a window and the migration says so at the column. A supplied `slug` behaves exactly as it always has — held to the column's rule, and a collision refuses rather than renaming.

Derivation folds what folds. `Café Ñandú` is `cafe-nandu`, and `Ærø` is `aero` through a short table of the Latin letters Unicode does not decompose. A name with no Latin letters in it — Chinese, Russian, Greek, Arabic, Hebrew, Thai — gets a stable token derived from that name, distinct per name. The version this replaces reduced every one of those to one base, and a shared base can be exhausted.

New setting, `slugs: "chosen" | "derived"`, default `"chosen"` — today's behavior, so nothing changes for a project that does not set it. `"derived"` refuses a supplied `slug` on the route line, naming the field, for a product where no URL contains one. The audit fact for a founding carries `derived` beside the slug, so the trail says whether a caller picked it.

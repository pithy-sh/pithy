---
"@pithy-sh/core": minor
"@pithy-sh/secrets": patch
"@pithy-sh/payments": patch
---

State what a projection may publish, instead of listing what it may not.

Four surfaces that cross a trust boundary were guarded by lists of strings that must not appear in the response — a ciphertext, a snapshot marker, `payload`, `s3cret`, a handful of credential shapes. A negative list is complete only against the values somebody thought of, and a projection widens by gaining a *field*, which is the one event no value list can observe.

`unpublishedIn` from `@pithy-sh/core/src/projection/published` is the invariant in its positive form: every leaf in the document must be a fact the surface publishes, and every key must be one written out by hand in the test. Both halves, because either alone lets the mistake through — `true`, `false` and `null` are in every JSON document's vocabulary, so only the key half can police a new boolean, and only the leaf half can catch a forbidden value arriving under a name nobody predicted. A value JSON cannot express is refused rather than skipped: a fallthrough returning "nothing to see" for a whole type is the defect this replaces.

Applied to the secrets status read and rotation history, the payments client projection, and the two management row projections. The payments catalog read, which had the first version of this sweep inline, now calls the primitive rather than keeping a fifth copy of a walker whose first draft was blind to booleans and nulls.

The permitted key set is a literal at every call site, never `Object.keys(Schema.shape)`. A gate that reads its own subject cannot fail when the subject changes.

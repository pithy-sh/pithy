---
"@pithy-sh/cli": patch
---

The last reader that cast now checks, and a write that writes nothing stops refusing (#222).

**`readManifestDocument` validates instead of asserting.** `ui/workerUi.ts` was #204's original instance and the one reader in this family that could take the merge-base read and did not. It refused on a parse failure and then *cast* to `ManifestDocument` — a type claiming `dev` and `ui` are objects — so a `pithy.worker.jsonc` whose `ui` is the string `"react"` reached the merge as if valid and `stringify` renamed the result over the adopter's file. A cast is the assertion no test can fail. It takes the read now, and the cast is a schema.

Two things came with that. `readMergeBase` grew one seam — **which parser turns the bytes into a value** — because `JSON.parse` cannot read a manifest with a comment in it, and that is a property of the file rather than a decision about what a failure means. The four refusals and the dropped parser error are unchanged by it. And the manifest's schema validates *without rebuilding*: comment-json hangs the file's notes off the object as symbol-keyed properties, and every Zod object schema constructs a new object from the keys it validated, so parsing rather than checking would have traded the cast for a quieter version of the same loss — every comment in the manifest gone at the next write.

**No refusal quotes a line of any of these files.** `detail` may name a path, an errno, a shape or the key path that failed; neither `message` nor `detail` carries a byte of what was in the file. This reader used to put comment-json's own message straight into `detail`, and comment-json quotes the line it choked on exactly as `JSON.parse` does.

**A write that writes nothing now reads like the report it is.** `writeBootstrapVars(dir, {})` and `removeBootstrapVars(dir, [])` read a merge base and could refuse although they wrote nothing — reached by `writeDevVars({ values: {} })` in the turnstile teardown, where it turns a regeneration into a failure over a file the run was never going to touch. The split in that module is by *power*, not by file, so the early return moves ahead of the read and the set it answers is `readBootstrapVars`'s. `removeBootstrapVars` keeps its strict read for every non-empty `names`, and that is the same rule rather than an exception to it: the early return belongs before the read exactly when the caller's own arguments settle whether anything is written, and "that name is not in the file" is a claim about contents that a file nothing could read does not support.

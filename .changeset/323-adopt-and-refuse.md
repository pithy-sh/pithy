---
"@pithy-sh/cli": patch
---

`pithy adopt` reads both shapes of a master key, and refuses an entry it cannot read.

The reader shipped ahead of the writer, so an unmigrated `secrets.jsonc` is the normal state of every project that has not run `pithy seed` since. `adopt` did not know that. It read a `bootstrap` entry verbatim and compared the old wrapped envelope against the bare `EncryptionConfig` in `.dev.vars` — identical values, and the verdict was `conflict`. That verdict is what an adopter deletes a line on the strength of.

It reads through `devSecretPayload` now, which is the seeder's own reading and the kit's only one. A wrapped master key compares as the value it is, and answers `present`.

**An entry that is neither a valid payload nor a valid envelope is refused by name.** It was planned as *nothing is there*, which plans a `copy` — and the copy overwrote a hand-written entry in the file that holds the master key, a value with no other copy and no undo. The refusal is the reader's own sentence: it names the secret, the file and the shape expected, and never a value.

The comparison is structural in fact as well as in its comment. One side comes back through the registry's schema now, in the schema's key order; the `.dev.vars` line is in whatever order it was written. Compared literally, a second `pithy adopt` conflicted with what the first one wrote.

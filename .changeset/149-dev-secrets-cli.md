---
"@pithy-sh/cli": minor
---

`.dev.secrets.jsonc` is a first-class citizen of the CLI. `.dev.vars` is env bindings again.

`pithy init` writes `.dev.secrets.example.jsonc` and gitignores the real file. `pithy add <capability>` mints that capability's generatable secrets into `.dev.secrets.jsonc` as version-1 envelopes instead of `.dev.vars` — the declaration and the minting are unchanged, only the destination. `pithy seed` seeds the file into the local `SECRETS` D1, deriving each secret's destination from the registry's `backend` and never from the file. `pithy dev` seeds before any Worker starts, for the same reason it wires the shared `.dev.vars` link before starting: a store filled after startup missed the session's first sign-in. All three call one seeder, so there is one seeding path rather than three that drift.

The file is written `0600` on creation **and on every rewrite**. An atomic write is a rename, so the mode that survives is the temp file's — `writeFileAtomic` now takes the mode and applies it before the rename, or the second write would silently widen a file holding OAuth client secrets back to the umask default.

Writes merge and never replace. The file is hand-edited, so a write re-parses the adopter's own JSONC and edits that tree: comments survive, trailing commas survive, and a value already there is never overwritten.

Migration is told, not enforced. Nothing rewrites an existing project's `.dev.vars`. A secret still sitting there is left exactly as it is — not moved, and not minted a second time beside it — and `pithy doctor` names it, says where it belongs, and repeats itself every run until it moves. It does not fail the exit: every project that predates this file has misplaced secrets by definition, and an upgrade that turns a green `pithy doctor` red in CI over a file that still works is a surprise, not a diagnosis.

`pithy doctor` also reports the standing states no run should repeat: declared secrets with no value that nothing can honestly mint, names in the file no capability declares, and a secrets file readable by anyone but its owner.

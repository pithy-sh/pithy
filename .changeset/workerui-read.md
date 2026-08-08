---
"@pithy-sh/cli": patch
---

`pithy ui` never rebuilds a `pithy.worker.jsonc` it could not read (#196).

`readManifestDocument` answered `{}` for every read failure. `pithy ui add` then merged its `dev` and
`ui` blocks into that empty base and renamed the result over the file — so a manifest that was **there**
and did not open (`EACCES` after a mode change, `EISDIR`, `EIO` on a failing disk) came back holding two
blocks and nothing else, with the run reporting Done. Every binding, route and comment the adopter had
written was gone.

This is #142 with a different file name. `pithy.worker.jsonc` is committed rather than gitignored, so
the loss was recoverable from git — but only by someone who noticed before committing over it.

The read goes through `readOptionalFile` now: only `ENOENT` starts from an empty document, and anything
else refuses by path and errno before a byte is written. An absent manifest still reads as empty, which
is what `pithy ui add` needs on a worker that has never had a front end.

The rebuild's other half was checked and is sound: the document is round-tripped whole, so every block
this writer does not own survives a `pithy ui add`. That is now pinned by a test rather than by reading
the code.

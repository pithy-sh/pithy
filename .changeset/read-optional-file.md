---
"@pithy-sh/cli": patch
---

Only `ENOENT` means the file is not there, and now it means it in one place.

Three readers had each learned that separately, and each one had cost something first: a `.dev.vars` rewritten from an empty base over a file full of values the process never saw, a `dev.json` that would have been replaced along with a developer's dev-login preferences, and a capability that vanished from `pithy add --list` because its manifest was present and unreadable. The rule is one sentence, and it had been written three times in three files.

`readOptionalFile` in `project/` is that sentence, once. It answers with the file's bytes, `null` for `ENOENT` and nothing else, and a `PithyError` naming the path and the errno for every other failure — with node's own error carried as `cause` and not a byte of the file in the message. `readFileOutcome` beside it gives the same three answers as a value, for the caller that was asked about sixteen packages and must still answer for the other fifteen. What stays at each call site is the sentence an adopter reads, which is `.dev.vars`-shaped or `dev.json`-shaped and belongs there; what moved is the decision about which errno means absence.

A build-failing gate states the invariant rather than naming the three: **a module that puts bytes on disk must not read a file and discard the failure.** It reads every package's source through the one walk in `ci/sourceFiles.ts`, sees the `.catch` form and the `try` form alike, and takes an alias or a namespace import with it. Scoping it to modules that write is what keeps it free of false positives — `doctor` discards on purpose, because a diagnostic has to work in the environment it exists to diagnose and can destroy nothing it failed to read. Eight discards that cost nothing are written down with the reason they cost nothing; five that could cost something are written down with what they would cost, as a list that may only shrink.

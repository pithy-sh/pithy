---
"@pithy-sh/cli": patch
---

The script that decides which gates run is reviewable, and so is every other file in the tree.

`.github/scripts/crossPackageReads.ts` held a literal NUL byte at its dedup separator, from the day it
was written. A NUL is what makes git call a file binary, so `git diff` printed `Bin 10043 -> 10128
bytes`, `--numstat` printed `-`, and **not one line of that file has ever been reviewable as a diff.**
It is the script that derives the cross-package read map #173 built so a gate runs on the pull requests
it gates — the file whose job is to make gates run was the one file whose changes nobody could read. It
is also the likeliest reason two comments in it spent three commits asserting something false: the
reviewer who would have caught the contradiction was never shown it (#211).

The separator is the two-character escape `\0` now. The runtime key is the same byte, so the derivation
is unchanged — `--json` is byte-identical against a payload saved before the edit, thirty reads across
eight targets — and `git diff` renders it as `1 1`.

**It was not the only one, and it was not special to `.github/`.** The gate found two more on its first
run, both written the same way — a control character typed as a raw byte where its neighbors on the
same line are escapes:

- `packages/support/src/mime/sanitize.workers.test.ts` feeds `"java\0script:alert(1)"` to `isSafeHref`
  beside `\n`, `\t` and `\r` spelled as escapes.
- `packages/testers/src/nudge/copy.test.ts` feeds a NUL to the control-character stripper. That file was
  **binary to git**, so the suite that proves hostile control characters never reach a nudge body was
  itself unreadable in review.

**The gate reads the bytes rather than asking git, and that is the point.** git decides binary from the
first 8000 bytes only. The byte in `crossPackageReads.ts` sat inside that window for three commits and
sits at offset 8251 today, so git had quietly started rendering the file as text — the defect had not
gone away, the file had grown past the window. A gate that asks git turns itself off as a file gets
longer and back on when somebody deletes a paragraph.

The file set is git's index, not the source walk: `.changeset/`, `.husky/` and `.vscode/` all hold
committed text that the walk skips by design. `git ls-files` does the listing, so the rule that this
repository writes one walk is untouched. The exception list is empty, and this repository has never
committed a binary file — no image, no font, no fixture. Adding a line to it costs an argument.

Proven by planting one: a NUL in `planShards.ts` makes `--numstat` report `-` and fails the gate with
the path and the offset. The byte is built with `String.fromCharCode(0)` throughout the test, because
writing a test about a NUL is the easiest way to put one in the test file.

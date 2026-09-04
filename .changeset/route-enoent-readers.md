---
"@pithy-sh/cli": patch
---

One module decides what a failed file read means (#197).

The last six readers that spelled the `ENOENT` branch out by hand now go through `readOptionalFile`:
`devSecrets/file.ts`, `project/devVars.ts`, `platform/rc.ts`, `feature/manifest.ts`, `feature/ports.ts`
and `seed/media.ts`. All six were correct. They were six copies of one sentence, and a copy is what the
seventh author reads instead of the original — which is how this repository got three data losses from
the same line.

Nothing an adopter sees changed. Each call site kept its own message, action and error class through
`options.unreadable`; the two that rethrow node's own error untouched kept doing that through
`readFileOutcome`. Every existing test at the six passed unmodified.

What it buys is the gate. It was *a module that writes must not read a file and discard the failure* —
scoped that way because the rule everyone wants has 32 producers in this tree, and its stated cost was
that a reader which writes nothing is invisible to it, which is the axis the third defect came in on.
The new rule alongside it is **only `readOptionalFile.ts` may name `ENOENT` where a file's contents were
read**: no allowlist, no judgment about which modules write, and no evading it by aliasing an import. A
probe's errno and a write's errno are untouched — `scaffold.ts` and `atomic.ts` are the rule applied,
not exempted from it.

The discard rule stays beside it, because the shortest wrong thing — `.catch(() => null)` — names no
errno at all and the new rule cannot see a silence. Its two lists are re-earned against that split
rather than carried over.

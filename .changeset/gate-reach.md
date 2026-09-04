---
"@pithy-sh/cli": patch
---

The ENOENT gate's two known gaps are closed, and its remaining limit is a number rather than a sentence (#204).

**A read the scan could not see.** `project/envInventory.ts` spelled out an `ENOENT` branch for a read it
performs through `readWranglerConfig`. The branch was correct — it rethrew — and invisible to the gate,
which recognizes the leaf calls that hand bytes back and knows nothing about who wraps them.
`readWranglerConfig` reads through `readOptionalFile` now, which puts the wrapper inside the rule instead
of outside it, and `envInventory` asks for the answer rather than deriving it from an errno. Nineteen
modules read a `wrangler.jsonc` through that wrapper; all nineteen get a `PithyError` naming the file
where they used to get node's raw error, and `readOptionalWranglerConfig` is the one that answers `null`
for an absent file so `pithy env` can carry on with the other Workers.

**The general question, answered.** Seventy-four exported functions across sixty modules perform a content
read and forty modules call one, so a read behind a wrapper is the ordinary case here. But the population
that takes either rule's shape is nine call sites, eight of them `wrangler.jsonc` reads, seven of those on
read-only `doctor` and `deploy` surfaces the discard rule is scoped away from on purpose. Two remain —
both in `capabilities/reconcile.ts`, already declared for its own `readFile`. Teaching the gate to resolve
wrappers means a whole-tree symbol pass living inside a test to find one site that was already correct and
one module already on the list. It is not worth it, that is written down in the gate rather than left to
be rediscovered, and the count is what will say when the answer changes.

**The last path from "the read succeeded" to "empty base".** `readManifestDocument` returned `{}` when
`pithy.worker.jsonc` parsed to something that was not an object, and the next write rebuilt the file from
it. `null` walked straight through the `typeof value === "object"` check written to stop it, an array
passed and then lost every key `stringify` drops off one, and comment-json boxes a top-level scalar so a
file holding `"react"` was an `"object"` too. Absent is `{}`; present-but-not-a-document is a refusal
naming the file and the shape found in it, never a byte of what it holds.

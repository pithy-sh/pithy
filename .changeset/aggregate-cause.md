---
"@pithy-sh/core": minor
"@pithy-sh/cli": patch
"@pithy-sh/vite": patch
---

A `pithy.config.ts` with two syntax errors stops classifying worse than one (#223).

#207 taught a config that will not load to name its own cause: a missing dependency says `bun install`, a
stray brace says where the file is broken. It worked for a file with **one** diagnostic. Bun hands one
diagnostic over bare and **two or more inside an `AggregateError`**, and a stray brace cascades — a single
missing `}` produced four — so the shape #207 fixed is the rarer one. The wrapper's `Object.keys` is empty
and its message is `4 errors building "<path>"`, which matched nothing the classifier looks for, so the
commonest syntax error in the world fell through to *the config threw while loading, run the file
directly*. The line and column were in hand and thrown away.

```
Before:  The config threw while loading. Run the file directly to see what it throws.
After:   The config does not parse: Expected identifier but found ";". Line 4, column 1.
         Fix the file — installing dependencies will not help.
```

**The second import of the same broken file is a different error again**, and that one is what
`pithy doctor` renders. Bun caches a failed module and re-throws the wrapper with its `errors` gone —
count and path, nothing else — so unwrapping cannot help, and `doctor` loads the root config twice by
design, because resolving the project's Cloudflare account (#206) reads it before the report does. The
wrapper's own message is enough to know a build ran and produced diagnostics, so it is named a parse error
with no reason and no position rather than mis-blamed on the config's runtime. Nothing else degrades this
way: a `ResolveMessage`, a bare `BuildMessage` and a config's own `Error` are identical on every import.

`@pithy-sh/core` gains `src/error/cause.ts` — `rootCause`, `isBuildFailureWrapper`, and the duck-typed
`prop` both are built on. Three classifiers read this failure (`cli`'s `classifyConfigLoadFailure` and
`classifyCapabilityLoadFailure`, and `vite`'s `classifyWorkerConfigFailure`, which restates the first
because the plugin must not depend on the CLI), and all three had got the same runtime wrong. What they
share now is **what Bun does to an error on its way out** — a fact none of them can derive locally, and
the only part they cannot be allowed to disagree about. The refusals stay their own; they are not the same
sentence and never were. `@pithy-sh/vite` still depends on `@pithy-sh/core` alone.

Nothing an adopter can read changed shape at the boundary #207 drew: `message` is still exactly
`Could not load <path>.`, and `action` still carries no newline, no ANSI escape, no stack frame and no
absolute path — asserted per cause, wrapper included, because a build diagnostic is a multi-line coloured
box quoting the file.

#207 survived its own Bun testing because the repro used one deliberate typo. The suite now spawns Bun,
imports a config missing one brace, and asserts the wrapper it really gets — twice, so both shapes are
pinned. A Bun that stops wrapping fails that test instead of silently restoring this bug.

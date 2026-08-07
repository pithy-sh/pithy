---
"@pithy-sh/cli": patch
---

`pithy init` wires the worker's `.dev.vars`.

The kit's convention is one `.dev.vars` at the project root, symlinked into each `apps/<worker>/`. `pithy worker add` has always made that link; `pithy init` never did. So a plainly scaffolded project had a root file the runtime never opened, and every secret `pithy add` mints into it reported as *absent* — the value present, unreachable, and the adopter hunting for something they already had.

`pithy init` now seeds the shared `.dev.vars` from the example it already ships and calls `wireFeatureDevVars`, the same implementation `pithy worker add` uses. One convention, one implementation, called from both places that make a worker.

`.dev.vars` is gitignored, so the link cannot be committed: a fresh clone of a scaffolded project still makes its own.

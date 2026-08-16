---
"@pithy-sh/cli": patch
---

The Workflow determinism gate parses with the parser already in the tree, and Babel is gone.

`@babel/parser` was a devDependency of `packages/cli` used by exactly one file: the #331 gate that refuses a clock or a random source in a Workflow driver body. Nothing shipped, nothing ran it, no adopter ever installed it — and there was no reason for it.

**The gate still needs a parser, so the first question was whether it does.** It resolves scopes, distinguishes a binding that holds a value from one that aliases a seam, stops at every function boundary, follows a call into a module-local function, and judges arity. A regex answers none of that, and #326 finding 4 is what a gate that only looks like it walks costs. So the change is which parser, not whether.

**`rolldown/parseAst`** — oxc, ESTree-shaped, TypeScript-aware. `vite@8` already depends on `rolldown@~1.2.1` for this repository's own test runner, so declaring `rolldown@^1.2.4` directly changed `bun.lock` by one line and added no package: same resolution, same binary, same bytes. `oxc-parser` is the same parser under a plainer name and would have resolved its own copy — nineteen platform bindings and about 3.6 MB — which is a swap dressed as a removal. `typescript@7.0.2` is tsgo and exports no classic compiler API, so the TypeScript already here was never an option.

`ParseModule` was already a seam, so the parser is a parameter. What the swap forced is that the analyser now speaks ESTree rather than Babel's dialect: `MethodDefinition` and `Property` for `ClassMethod` and `ObjectMethod`, `Literal` for `StringLiteral`, a `CallExpression` inside a `ChainExpression` for `OptionalCallExpression`, and a byte offset turned into a line rather than a `loc`. The one that bites: a method *wraps* a `FunctionExpression` in ESTree, so the walked scope has to be the function. Walk the method and the first node the walk meets is a deferred one — every driver in the kit reported clean, having parsed everything and read nothing.

Which is why this is held to the swap by comparison rather than by argument. `analyseDrivers` ran over all 1023 sources under `packages/` with each parser, and over a second corpus of the same files planted with 75 violations across 19 of the 21 real driver bodies. Both outputs are byte-identical: same entrypoints, same drivers, same declared class names, same findings, same lines, same expressions. Then a clock planted in `PaymentsReconcileWorkflow.run` was named with its file and line, and a planted Workflow class failed the exact-population assertion. The gate bites exactly as it did.

`@babel/parser` still resolves in `bun.lock`, reached by `@vitest/coverage-v8` through `magicast`. What went is the kit's declaration of it and the kit's use of it.

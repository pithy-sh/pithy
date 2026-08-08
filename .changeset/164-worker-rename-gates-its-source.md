---
"@pithy-sh/cli": patch
---

`pithy worker rename` gates its source, and the rule stops enumerating verbs.

The destination was gated and the source was not. A symlink at `apps/<from>` was moved as a link, so `apps/<to>` arrived still pointing outside the project — and the `wrangler.jsonc` and `package.json` rewrites that follow the move then went through it. Reproduced against a canary directory: the command reported success and left the canary's two files renamed. The source now goes through `ensureScaffoldPath` as well, with a refusal that describes a move rather than a scaffold, because "the files would land outside the project" is the one sentence an adopter acts on and it was about the wrong command.

That was the seventh producer of one class, and its third verb: **write** (#147, #151, #152), **delete** (#158), now **move**. The two tripwires guarding it enumerate verbs — one names five link-following probes, the other names `rm` — so both were green on a `rename`. Adding `rename` to a list buys nothing; the eighth producer is `copyFile`, or `link`, or `truncate`.

So there is a third rule, and it asks about the **path**: a mutating filesystem call on a path composed from a name the adopter typed must go through the gate. `node:fs`'s mutating surface is a closed set and all of it counts. It is a heuristic over source text, and it says in the source exactly what it can see — a module's `const` initializers, to a fixpoint — and what it cannot: parameters, a fresh name appended to an already-gated path, a re-export.

Two holes in the older rules closed with it. The rename rule's static-import regex hardcoded `node:fs`, so `import { rename } from "fs/promises"` — the same module, one prefix short — passed it. And both scaffold rules walked `packages/cli/src` alone; they now walk every package's shipped source, with the repository's own build scripts and test harnesses left out deliberately and on record, since none of them ever runs against an adopter's project.

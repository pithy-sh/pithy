---
"@pithy-sh/cli": patch
"@pithy-sh/core": patch
"@pithy-sh/payments": patch
---

`pithy add` declares the capability on the Worker that composes it, and refuses a choice it cannot write.

**A capability now lands in `apps/<worker>/package.json`.** The import goes into that Worker's `pithy.config.ts`, so that is what depends on it — which is where `pithy init` already puts `@pithy-sh/core` and where `pithy ui add` already writes. Declared only at the root, it resolved by hoisting, and under a package manager that does not hoist it was not linked beside the Worker at all: a fresh sequence of adds failed part-way and then succeeded on a retry, because the failed run left the package on disk. A first-day failure nobody could reproduce afterwards. The install still runs at the root, where the lockfile is; only the declaration moved, at the range the root resolved.

It also makes the Worker's manifest true. The composed config is per-Worker by design — two Workers are meant to compose different sets — and one shared root dependency list cannot say what either is made of.

**`pithy add payments --set billingSubject=organization` is refused rather than written.** That mode needs a `resolveSubject` seam saying which organization a caller is acting for; the capability refuses to assemble without one, deliberately, because a capability that guessed would key a company's plan to whoever signed in first. `pithy add` renders JSON and cannot render a function, so it was writing the one composition the kit is designed to reject — and since every command begins by loading the config, the add bricked the project. It now stops at the flag and names the two steps.

Capabilities can declare this themselves: a manifest's `configOptions[].choicesNeedingCode` maps a choice to the sentence explaining what to do instead.

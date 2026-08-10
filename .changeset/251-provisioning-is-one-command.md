---
"@pithy-sh/core": minor
"@pithy-sh/cli": minor
---

Provisioning is one command: `pithy provision --env <name>` or `pithy provision --feature`.

Both create an environment's Cloudflare resources, write the ids into each Worker's config, and migrate. They differ only in **how the target environment is named** — declared in the root `pithy.config.ts`, or derived from the checked-out branch. That is a flag, not a different verb.

The safety lives in the scope rather than in the spelling. A `ProvisionScope` carries the resource naming **and** the `env.<name>` stanza the ids are written into, as one value — so a feature-named resource landing in a declared environment's stanza of a checked-in config is unexpressible rather than merely refused. Nothing about that depends on which words were typed, which is what leaves one command free to carry both modes.

`pithy feature` is `create`, `sync` and `destroy`. All three derive the feature from the checked-out branch, so provisioning was the only verb there that a flag on `pithy provision` could say better.

**Exactly one of the two flags is required, and neither is ever inferred.** Passing both, or neither, is refused at the flag — before the working directory is read, before a config is loaded, and before any Cloudflare client exists, which is why the refusal reads the same outside a project as inside one. `--feature` is never derived from "the branch looks like a feature branch": an implicit mode switch on branch shape is how someone provisions the wrong thing while reading a command line that says nothing about it.

**The two modes have opposite persistence semantics, so every run says which it did and where.** `--env` writes `env.<name>` into the tracked `wrangler.jsonc` — long-lived ids a human reviews in a pull request. `--feature` writes a generated config under the already-ignored `.wrangler/` — one job's output, rebuilt every run, never committed. A single flag that flips whether output is committed will eventually surprise someone:

```
Wrote 3 ids into apps/board/wrangler.jsonc. Commit them.
Wrote 3 ids into apps/board/.wrangler/pithy/wrangler.feature.jsonc. Ignored, and rebuilt on the next run.
```

`--json` carries the same answer as `configs` and `committed`, so a pipeline reads it rather than infers it. That is what keeps the standing rule checkable rather than remembered — **a CI build process never commits back to the repository**: a pipeline runs `--feature` and has nothing to commit. The gate is the sentence: a run names every file it wrote, every file whose bytes moved is one it named, and `committed` is exactly whether those paths are tracked.

**`feature` is now refused as a declared environment.** It was legal to write `environments: ["feature"]`, which gave one wrangler stanza two owners — a tracked file provisioning wrote and a generated file every other command read. It stays a legal environment *name*, because it is a real stanza key; it is the declaration that is refused, the way `dev` and `global` are. So `--env` cannot reach a branch's environment and `--feature` cannot reach a declared one, in both directions, by construction rather than by check.

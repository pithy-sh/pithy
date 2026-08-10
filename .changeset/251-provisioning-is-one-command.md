---
"@pithy-sh/core": minor
"@pithy-sh/cli": minor
---

Provisioning is one command: `pithy provision --env <name>` or `pithy provision --feature`.

Both create an environment's Cloudflare resources, write the ids into each Worker's config, and migrate. They differ only in **how the target environment is named** — declared in the root `pithy.config.ts`, or derived from the checked-out branch. That is a flag, not a different verb.

They were two commands because the naming and the destination stanza were independent arguments, and the combination was a real hazard: `pithy feature provision --env staging` composed `<project>-f<issue>-<slug>-db` and wrote it in as staging's `DB`, in a checked-in config, then migrated against it. `ProvisionScope` fused the two into one value, so that is now unexpressible rather than refused — and with the safety out of the command surface, two verbs for one job was left with nothing to justify it.

**Exactly one of the two flags is required, and neither is ever inferred.** Passing both, or neither, is refused at the flag — before the working directory is read, before a config is loaded, and before any Cloudflare client exists, which is why the refusal reads the same outside a project as inside one. `--feature` is never derived from "the branch looks like a feature branch": an implicit mode switch on branch shape is how someone provisions the wrong thing while reading a command line that says nothing about it.

**The two modes have opposite persistence semantics, so every run says which it did and where.** `--env` writes `env.<name>` into the tracked `wrangler.jsonc` — long-lived ids a human reviews in a pull request. `--feature` writes a generated config under the already-ignored `.wrangler/` — one job's output, rebuilt every run, never committed. A single flag that flips whether output is committed will eventually surprise someone:

```
Wrote 3 ids into apps/board/wrangler.jsonc. Commit them.
Wrote 3 ids into apps/board/.wrangler/pithy/wrangler.feature.jsonc. Ignored, and rebuilt on the next run.
```

`--json` carries the same answer as `configs` and `committed`, so a pipeline reads it rather than infers it. That is what keeps the standing rule checkable rather than remembered — **a CI build process never commits back to the repository**: a pipeline runs `--feature` and has nothing to commit. The gate is the sentence: a run names every file it wrote, every file whose bytes moved is one it named, and `committed` is exactly whether those paths are tracked.

**`feature` is now refused as a declared environment.** It was legal to write `environments: ["feature"]`, which gave one wrangler stanza two owners — a tracked file provisioning wrote and a generated file every other command read. It stays a legal environment *name*, because it is a real stanza key; it is the declaration that is refused, the way `dev` and `global` are. So `--env` cannot reach a branch's environment and `--feature` cannot reach a declared one, in both directions, by construction rather than by check.

**`pithy feature provision` survives as a deprecated alias.** It prints the new spelling and runs it, because a subcommand that errors is a worse first impression than one that redirects. The notice goes to stderr, so `--json` still writes exactly one line — carrying `"command":"provision"`, which is the command it ran. `pithy feature` keeps `create`, `sync` and `destroy`, all three of which still derive the feature from the branch.

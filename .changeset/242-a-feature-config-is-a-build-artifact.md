---
"@pithy-sh/core": minor
"@pithy-sh/cli": minor
---

A feature's provisioned ids never touch a tracked file.

`pithy provision --feature` wrote feature-scoped ids into `apps/<worker>/wrangler.jsonc` — tracked, committed, and impossible to gitignore, because it is the project's real config. In CI that is correct as designed: the checkout is throwaway, wrangler reads the stanza, the job ends, nothing is committed. Everywhere else it was an expectation rather than a guarantee. A developer in a feature worktree carried a modified tracked file they had not edited, with nothing saying it must not be committed; `git add -A` put ids for since-deleted resources onto `main`. And `pithy feature destroy`, which reverses every other thing provisioning does, did not reverse the edit — the one part that outlived the feature.

**The fix is a shape, not a warning: a provisioning run never writes a file a checkout tracks.**

`ProvisionScope` gained `source` — is this environment's config source, or a build artifact? A declared environment's ids are long-lived facts about the repository and belong in the tracked file, under review, in a pull request a human reads. A feature's are facts about one job. So the same object that answers "what is this called?" and "which stanza does it go in?" answers "which file?", because those three answers have to agree.

A feature's config is generated at `apps/<worker>/.wrangler/pithy/wrangler.feature.jsonc`, regenerated from the tracked file on every run so it cannot drift from it. `.wrangler/` has been in the scaffolded `.gitignore` since the first release and is ignored at any depth, so there is no new ignore rule and nothing for an existing project to adopt — which is the point: a rule existing projects lack would have left them exactly where they were. `main` is rewritten to an absolute path, because wrangler resolves a config's paths relative to the config file.

One resolver decides which bytes describe an environment, and `migrate`, `seed` and `deploy` all use it; `deploy` passes it to wrangler as `--config`. `feature destroy` now has nothing to reverse, and a feature abandoned without teardown strands nothing.

The gate is the sentence: after `pithy provision --feature`, every path whose bytes changed is one the scaffolded `.gitignore` already covers, and the Worker's own `wrangler.jsonc` is byte-identical — with a non-vacuity check, so "wrote nothing tracked" cannot pass by writing nothing at all.

Worth stating: `pithy env` reports what a Worker's tracked config declares, so a feature environment does not appear in it.

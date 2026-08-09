---
"@pithy-sh/core": minor
"@pithy-sh/secrets": minor
"@pithy-sh/cli": minor
"@pithy-sh/email": minor
"@pithy-sh/media": minor
"@pithy-sh/storage": minor
"@pithy-sh/support": minor
---

A project declares which environments it has, and three parts of the CLI stop guessing.

Nothing said. The set existed only as `env.<name>` stanzas in each Worker's `wrangler.jsonc` — per Worker, so two Workers in one project could disagree with nothing reconciling them — while `ManagedEnvironment` held a closed enum of `staging` and `prod` and `seed.productionEnvironments` invited a project to name a third. An adopter adding `env.live` got `pithy migrate --env live` working, `<project>-live-db` created, and `pithy secrets provision` skipping it: no master key, no manager, no store entry, silently, until the first request.

The root `pithy.config.ts` now carries `environments`, defaulting to `["staging", "prod"]`. `pithy init` asks with that default — one keypress for the common case, and no line written into the config, because a declaration that repeats the default says nothing. A non-interactive `init` takes the default and is byte-for-byte what it always was. The list is ordered, least-production first: that is the order provisioning walks, and the last entry is the one a `global` account-level secret is written through, which used to be the literal `prod` even for a project that had none. `dev` cannot be declared — it is local, it is the top-level wrangler stanza, and it always exists. `global` stays reserved.

**Declared and managed are one set, deliberately.** `ManagedEnvironment` is no longer a closed enum; it is the declaration. The cost is named rather than hidden: everything that iterates the set multiplies with it, and the largest item is a manager Worker per environment with its own rotation cron, so a project declaring five environments gets five managers. The alternative — a second, smaller "but only these are managed" list — is the bug restated, because an environment that deploys and is not managed is one whose secrets have no master key, which is exactly the silence `live` was already in. So declaring an environment is what costs a manager, and that is the one decision, in the one place `pithy doctor` can see it.

`--env` refuses an environment the project does not declare, by name, listing the ones it does. `pithy init` and `pithy worker add` generate each Worker's `env.<name>` stanzas from the declaration rather than a hardcoded pair, with their binding arrays empty — a stanza that asserts nothing is the honest shape, and an existing project's scaffolded stanzas keep working untouched.

**A fresh `init` still writes those stanzas**, and that is a decision with a reason in the source. `pithy add <capability>` writes bindings into the stanzas that exist and creates none, so a project scaffolded without them would have its very next `pithy add auth` bind `dev` alone and leave staging and prod silently unbound — a worse silence than the one this closes. Provisioning owning the stanza is right and is the follow-on work.

`pithy doctor` gains an `Environments:` block and an `environments` key in `--json`. It reports a Worker whose stanzas disagree with the declaration, and — separately, because the remedies are opposite — a declaration changed **after** provisioning: an undeclared stanza still carrying resource ids. That one is never applied. `<project>-<env>-<thing>` is recomputed and never stored, so changing an environment name does not rename a database; it orphans it, exactly as renaming `name` does. The report names the ids and stops. A stanza whose bindings carry no ids is read as not provisioned rather than as broken.

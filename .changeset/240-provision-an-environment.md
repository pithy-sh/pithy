---
"@pithy-sh/core": minor
"@pithy-sh/cli": minor
---

`pithy provision --env <name>` — the lifecycle step that was written for feature environments and never for the ones a project ships to.

A project scaffolded, wired and migrated by pithy could not be deployed. `pithy add` runs the Worker's *dev* migrations, `pithy migrate --env prod` queries a database it assumes exists, and `pithy deploy` provisions nothing — so `apps/<worker>/wrangler.jsonc` declared `"database_name": "<project>-staging-db"` with no `database_id`, in every environment, and stayed that way. The first deploy failed inside wrangler, on a field the adopter never knew they were meant to fill in, after four commands had all succeeded.

The provisioner was never the missing part. `pithy provision --feature` already resolves the Worker set, creates one resource per binding name, writes the ids into each Worker's own config and migrates. What was missing was the command, and the naming.

**`ProvisionScope` is the naming, and it is why this is one object rather than two arguments.** A scope carries both the names a run composes and the `env.<name>` stanza it writes them into. `environmentScope(project, env)` gives `<project>-<env>-<thing>`, so a name's environment segment is always the stanza the name lives in; `featureScope(identity)` gives `<project>-f<issue>-<slug>-<thing>`, with the `f<issue>` marker instead of an environment because a feature *is* one. `provisionScope.test.ts` asserts that property over every scope, project, binding and kind, in both directions.

That closes a hazard that was reachable before it: `pithy provision --feature --env staging` composed `<project>-f<issue>-<slug>-db` and wrote it in as staging's `DB`, in a checked-in `wrangler.jsonc`, then ran a remote migrate against it. Nothing refused it. **`pithy provision --feature` no longer takes an `--env`** — the combination cannot be expressed, rather than being on a list of things not to do.

`pithy provision` is idempotent and **adopts**: every resource is matched by name before it is created, so a re-run is a no-op and a database made by hand under the right name is taken up rather than shadowed by a second. It writes a D1's `database_name` beside its `database_id`, because `pithy add` proposes the name offline and provisioning is the step that makes the proposal true. It creates the stanza when it is absent, so an environment declared after scaffolding needs no hand-editing. Seeding is off unless `--seed` is passed.

**`pithy deploy --env <name>` refuses** when a binding has no resource behind it, naming the command that creates one — before anything is built or spawned. A deploy that silently created account resources would be hard to review, and these are the ids that land in a pull request.

Production takes an exact, environment-naming phrase that `--yes` never replaces, and there is no `pithy deprovision`: staging and production are not disposable, and the one-word difference between them and a branch is not a difference a flag should carry.

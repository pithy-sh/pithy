---
"@pithy-sh/cli": minor
---

`pithy doctor` now reports an `env.<name>` stanza that silently goes without something its own top level declares.

Most of a `wrangler.jsonc` flows down into an environment. A minority does not — `vars`, `version_metadata`, and
every binding block among them — and a key in that minority declared at the top and left out of a stanza is simply
**absent** in that environment, with no error and one warning inside a deploy whose output nobody is reading. The
kit's own first adopter shipped staging and prod with no `CF_VERSION_METADATA` binding that way, which left
`pithy deploy`'s post-deploy version check permanently inconclusive on both.

The new `Environment inheritance:` block names the Worker, the key, the environment, and what that environment goes
without — the binding or variable names, read out of your own config rather than from a description of what the key
is for. It **reports and never fails the exit**: every project scaffolded before this landed is in this state for
`version_metadata`, and an upgrade that turns a green `pithy doctor` red in CI is a surprise rather than a
diagnosis. `--json` carries it as `environmentInheritance`.

**The rule is wrangler's, and a test says so.** The kit states the non-inherited keys once, in
`project/wranglerInheritance.ts`, and `wranglerInheritance.test.ts` holds that list to wrangler's own
`notInheritable(…)` call sites and to its `EnvironmentNonInheritable` interface — so a wrangler release that adds a
key, or moves one across the line, fails the build instead of quietly narrowing the check. That gate exists because
the first hand-written version of this rule was wrong about two of its four names within a day: `observability` and
`triggers` read like per-environment settings and are both inherited.

`pithy init` and `pithy worker add` now repeat what they must. Both scaffolders read the list rather than restating
it, so the next key wrangler adds reaches them without anybody remembering to come back.

---
"@pithy-sh/cli": patch
---

`pithy env` reported a working local environment as three-quarters unprovisioned.

```
dev  local
  worker  dash-board
  SECRETS (d1)  not provisioned
  DB (d1)  not provisioned
  EMAIL_SUPPRESSIONS (d1)  not provisioned
```

That environment was running, migrated and seeded. The fact was right — there is no remote `dash-dev-db` — and the presentation was wrong, because a local environment is not supposed to have one. Miniflare serves D1 from the binding declaration, with state under `.wrangler/state/v3/d1`, and `pithy dev` works precisely because no Cloudflare resource is involved. The command printed `dev  local` one line above and then evaluated that environment against a remote standard it had just said did not apply.

The cost is not cosmetic. `pithy env` is the inventory read before provisioning and after; if a third of it is always red for an environment that is fine, the reflex becomes to skim past red, and that is the reflex you least want when reading it against production.

**A check that cannot fail meaningfully for an environment is not run against it.** A binding with no id now reads `local` in a local environment and `not provisioned` only in a deployed one — deliberately different words, because sharing them is what made the real action item weaker. A local environment that *does* name a real id still shows it: pointing dev at a remote database is a thing an adopter may do, and the id is the true and useful thing to print.

**Localness is a property of the report, not a guess about the name.** `environments[].local` is set where it is known for a structural reason — the top-level wrangler stanza *is* the local environment, which is why `DeclaredEnvironments` refuses to let a project declare `dev` — and `--json` carries it. Keying a fix off the string `dev` at the render layer would have re-encoded the same guess one layer down, and every consumer would have had to make it again.

The disagreement with `pithy doctor` was entirely on this side: `doctor` reported the same tree healthy because it never evaluates provisioning at all — its `bindings` check is about whether a Worker *declares* what a capability requires. There was nothing to relax there, and a standard to stop applying here.

---
"@pithy-sh/core": minor
"@pithy-sh/cli": minor
---

`pithy feature destroy` deletes the feature's Worker scripts.

It deleted D1, KV, R2 and Secrets Store entries, and the feature manifest had no field for a script. Every
teardown left its Workers deployed, answering on workers.dev and bound to databases it had just removed — one
set per branch.

**The manifest records every script name provisioning writes**, as `scripts`, before the config carrying it is
written. `destroy` deletes each one the account confirms is deployed, scripts before resources, and reports each
in `deletedResources` with `kind: "worker"`. A recorded name is honored only when it recomputes from the Worker's
own two names, like every other manifest entry.

**A feature provisioned before this is torn down too.** Its manifest names no scripts, so `destroy` recomputes
them from `apps/` in both shapes a feature Worker has deployed under — `<project>-f<issue>-<slug>-<app>`, and the
doubled `<project>-f<issue>-<slug>-<project>-<app>` from before #587. Exact names, never a prefix.
`featureWorkerScriptNames` in `@pithy-sh/core` is that pair.

**A feature with a Secrets Store deployed under a name nobody recorded.** Provisioning wrote its generated
config twice, once for the resources and once for the secrets, and the second write regenerated it from the
tracked `wrangler.jsonc`: the script name, every binding id and every service target were dropped, and wrangler
deployed the Worker as `<script>-feature`. It is one write now.

`deprovisionFeature` and `destroyFeature` take `scripts` beside `provisioners`, and `workers`. The command builds
both account seams from one set of clients, so neither can run without the other.

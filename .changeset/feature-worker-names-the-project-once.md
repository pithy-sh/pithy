---
"@pithy-sh/core": minor
"@pithy-sh/cli": patch
---

A feature Worker carries the project once: `replay-f69-demo-board`, not `replay-f69-demo-replay-board`.

`featureWorkerName` documents `<project>-f<issue>-<slug>-<worker>`, where the last segment is the `apps/<worker>`
directory. Provisioning handed it the deploy name instead, and a scaffolded Worker's deploy name already leads
with the project. The doubled segment was not only untidy: the name is held to the Worker cap of 63, and the
second `<project>-` was paid for by hashing the slug or the directory — the segments a reader needs.

**`ProvisionScope.worker` now takes both of a Worker's names, `{ app, script }`.** The two scopes compose from
different ones. A feature builds on the directory. A declared environment still falls back to wrangler's
`<script>-<env>`, so staging and production names are unchanged — a declared name still wins, and a stanza that
names nothing still deploys where it always did. Code calling `scope.worker("replay-board")` passes
`{ app: "board", script: "replay-board" }`.

Both computations of the address read those names from one function, `provisionWorkerNames`: the service target
a sibling calls, and the stanza `name` the deploy reads. Fixing only one of them would have pointed every
`service` binding at a script nobody deploys.

**A feature live across the upgrade redeploys under the new name.** Its next `pithy provision --feature` and
deploy publish `<project>-f<issue>-<slug>-<app>`, and the old doubled-name script keeps running beside it —
feature teardown does not delete Worker scripts, so remove it in Cloudflare by hand, and know that any Durable
Object state on it stays on it.

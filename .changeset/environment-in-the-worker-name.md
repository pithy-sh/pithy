---
"@pithy-sh/core": patch
"@pithy-sh/cli": minor
---

The Worker you deploy now carries the environment in the middle too — `<project>-<env>-<worker>`.

Every other resource the kit names puts the environment second. The adopter's own Worker put it last, because
wrangler appends `--env` to the top-level `name` and nothing ever wrote one. So `acme-staging-db` and
`acme-board-staging` sat nowhere near each other in an account holding two environments. `pithy init` and
`pithy worker add` now stamp `env.<name>.name` in the kit's shape, and `scaffoldParity.test.ts` holds both
producers to it.

**Nothing existing is renamed.** The fallback stays wrangler's suffix, so a project that never declared a name
deploys exactly where it always did, and `pithy provision` now *reads* a declared name instead of recomputing
one over it — that reversal is argued in `provisionScope.ts`, because recompute would have renamed every
adopter who took the new shape, on their next provision, taking routes and service bindings with it. Service
bindings resolve to the callee's declared name for the same reason. `pithy doctor` reports a project still on
the suffix as an optional convention, never a fault, and says what a rename costs.

**And eight worker names are now reserved.** Under this shape `apps/email` would deploy `acme-staging-email` —
byte-identical to the email capability's own host Worker, which `wrangler deploy` would replace in silence.
`pithy init --worker`, `pithy worker add` and `pithy worker rename` refuse any name a capability's host owns,
and `pithy doctor` reports a project that already declares one. The set is read from the host registry at run
time, so a capability that ships a host later is covered the day it is registered.

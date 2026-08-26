---
"@pithy-sh/cli": patch
---

"Cannot tell" is no longer read as "nothing".

Nine commands built their audit emitter from `resolveWorkers(…).then(projectCapabilities).catch(() => [])`. An empty list means no `audit` capability was found, which is exactly what a project that never composed one looks like. So a single Worker config that would not import — a fresh CI checkout where a capability package did not install — let `pithy deploy --env prod` ship every Worker, print `Done.`, exit 0, and write no row for a project that audits. The module's own standard says why that is the worse outcome: an audit trail you cannot tell is broken is worse than none.

`pithy token` derived credential policy from the same emptied set. `resolveTokenProfiles([])` returns `ci-system` and drops every capability's `ciPermissions`, so `pithy token list` told an operator auditing live credentials that capability-profile tokens do not exist, and `pithy token rotate ci-system prod` minted a replacement carrying only the base permissions before deleting the fully-permissioned one it replaced.

The third state is threaded instead. A project with no Workers is `[]`. A config that will not load is an unknowable set, and it carries the sentence saying which worker and why — so a refusal names the file rather than inventing "a config will not load" for one that is simply absent. `createProjectCliAudit` is the single builder those nine copies collapse into, and an unknowable set produces an emitter that names every event it could not record instead of falling silent.

**The refusal lands only where the answer is load-bearing.** `pithy token mint`, `rotate` and `list` each read the profile registry, and each refuses. `revoke` composes its name from the root config alone, so it still runs — that is the command you reach for during a credential leak, and taking it away because an unrelated Worker's config is broken on this checkout would be the fault `#454` removed, not a new safety.

`pithy add` and `pithy remove` no longer load every Worker's config to write one. `--worker` narrows before the load, so one broken sibling stops disabling the wiring commands for the whole project — including when editing a healthy Worker was the way around the broken one.

And a Worker whose `pithy.config.ts` is absent is reported rather than swallowed. `feature destroy` was handed a set that was incomplete rather than empty: the manifest pass still deleted what it had recorded, the reconcile backstop no longer scanned that Worker's bindings, and those resources leaked while the run exited 0.

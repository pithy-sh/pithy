---
"@pithy-sh/cli": patch
---

`pithy doctor` and `pithy upgrade` see the capabilities a Worker composes, not the ones the root happens to install.

Discovery scanned `<root>/node_modules/@pithy-sh/*`. That held for as long as every project had the root copy, and every project did, because `pithy add` writes each capability to both manifests — so the root declaration was load-bearing and nothing said so. It fails in exactly the shape the kit tells adopters to adopt: capabilities are per-Worker, and a project that declares one only where it is composed installs it under `apps/<name>/node_modules`, where the root scan never looks.

**A manifest that does not resolve is not an error, it is a skip.** Every loop in the plan is keyed on the manifests, so bindings went unchecked, config options unread and generated values uncompared — and `prerequisites` answered `ok` for a composition genuinely missing a required peer. Measured against 0.2.0 on one project with one broken config: the fault is reported when `@pithy-sh/auth` sits in the root `node_modules` and the project reads as healthy when it does not. Not narrowed advice but a wrong answer, on the check an adopter reads before deploying, indistinguishable from health.

The plan now resolves manifests from the Worker and the root together, the Worker's copy winning because it is the one that Worker loads. `pithy upgrade`'s two write paths take the same route, so an upgrade no longer skips the bindings of a capability declared where it is used. `Project capabilities:` counts every Worker too, instead of reporting "all up to date" about packages it never saw.

The composed set stays the authority on what belongs to a report, so a package left behind in `node_modules` after its declaration was removed still contributes nothing.

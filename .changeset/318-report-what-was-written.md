---
"@pithy-sh/core": minor
"@pithy-sh/cli": patch
"@pithy-sh/payments": patch
"@pithy-sh/storage": patch
"@pithy-sh/support": patch
"@pithy-sh/vector": patch
"@pithy-sh/testers": patch
"@pithy-sh/media": patch
---

`pithy upgrade` counted bindings it had not written, and `pithy doctor` was right to disagree.

Run in sequence, seconds apart, against one tree: `upgrade` said `payments: added 3 bindings` and `git diff apps/board/wrangler.jsonc` showed none of them. `doctor` still reported `PAYMENTS_RECONCILE (workflow) missing from wrangler.jsonc`. Two commands of one CLI disagreeing about a file one of them had just edited, with the failing direction the dangerous one: `upgrade` says done, so a reasonable person deploys a Worker whose reconciliation Workflow has no binding, and finds out at runtime.

Two causes, both fixed at the thing rather than the call site.

**Six capabilities derived their Workflow bindings with `Object.values`, and the job is the map key.** `payments`, `storage`, `support`, `vector`, `testers` and `media` each carried the same four lines, and `createBackend` carried them a seventh time. Dropping `job` and `className` is not cosmetic: the CLI composes a `workflows` entry's deployed name from the job and its `class_name` from the class, refuses to write a partial one because wrangler rejects it, and had no way to say so. `workflowBindings` in `@pithy-sh/core/src/workflow/bindings` is now the one derivation, `Object.entries` where it belongs, and every producer routes through it.

**And the report came from the plan.** `applyBindings` recorded what it *intended* the moment it touched a capability. `appendBinding` now returns what happened — written, present, unsupported, or skipped with a reason — and `upgrade` reports off that. A binding it could not write gets a line of its own, named:

```
payments: PAYMENTS_RECONCILE (workflow) not written for dev — PAYMENTS_RECONCILE declares no job.
```

The gate that should have caught this was green and structurally unable to fail: it checked workflow bindings for `job` and `className` over `requiredBindings.filter((b) => !b.optional)`, and every affected binding was optional. `optional` answers whether the app may boot without the binding. It says nothing about whether the entry is derivable offline, which is the question that gate asks. It now asks it of every workflow binding, and a sweep over the shipped manifests holds `upgrade`'s report to the file it wrote and to the plan `doctor` reads afterwards.

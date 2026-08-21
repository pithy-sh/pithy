---
"@pithy-sh/core": patch
"@pithy-sh/cli": patch
"@pithy-sh/support": patch
"@pithy-sh/media": patch
"@pithy-sh/vector": patch
---

Three Workflow hosts did not build, because a worker's module format is inferred from its default export.

`@pithy-sh/support`, `@pithy-sh/media` and `@pithy-sh/vector` each ship a prebuilt Workflow host, and each exported only classes. wrangler decides a worker's **format** from one thing — whether the entry has a default export — so all three were read as service workers, and a service worker may not import `cloudflare:workers`:

```
▲ [WARNING] The entrypoint packages/support/src/workflows/worker.ts has exports like an ES Module,
          but hasn't defined a default export like a module worker normally would. Building the
          worker using "service-worker" format...
✘ [ERROR] Unexpected external import of "cloudflare:workers" and "cloudflare:workflows".
```

`pithy dev` builds each worker separately and the other workers come up, so it scrolls past. The classification Workflow, the four enrichment Workflows and the reprocess Workflow simply were not running.

**The four hosts that worked all have a cron.** Somebody wrote `export default { async scheduled(…) }` for the cron, and the module became an ES module as a side effect nobody named. The three with no cron had no reason to write one. A rule satisfied at the call site by whoever happened to need something else.

So the rule is now stated where it belongs, and the population is derived rather than listed:

> Every module in this kit that extends `WorkflowEntrypoint` has a default export.

`cli/src/ci/workflowModuleFormat.test.ts` re-reads the tree on every run through the same walk the determinism gate uses, so a host added tomorrow is judged tomorrow with nothing to remember — and the walk finds hosts wherever they live, not under a `src/workflows/` glob. It is proved against fixtures in both directions before it is trusted against the tree.

`workflowHostEntry(capability)` in `@pithy-sh/core/src/workflow/hostEntry` is what the three export. It refuses rather than being empty: `export default {}` would build and say nothing, while a Workflow host genuinely has no request surface — an app Worker starts its jobs through a Workflow binding — so an HTTP request arriving at one is a misconfiguration, and `core/not_found` naming the capability is the sentence that ends an operator's search. The `action` names the binding that does work and is stripped before the body goes out, like every other action.

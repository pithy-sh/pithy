---
"@pithy-sh/core": minor
"@pithy-sh/cli": minor
"@pithy-sh/testers": minor
"@pithy-sh/multiplayer": patch
"@pithy-sh/payments": patch
"@pithy-sh/storage": patch
---

Workflow and Durable Object logs are structured records now, not bare console lines — filterable by level and capability in Workers Logs, with errors carrying their full payload. New projects are scaffolded with a lint rule that keeps it that way, and you can turn it off.

`logger.ts` has always said it: resolve the logger from the request context, never reach for `console`. Nothing enforced that, and nine calls had drifted into shipped runtime code — six of them in Workflow entrypoints, where there is no `c.var.log` to reach for and `console.log` is the shortest path to a line of output. Those six were the only observability a Workflow run had, and every one of them was an unstructured string: no level to filter on, no name to scope to a capability, no instance to correlate by, and a caught `PithyError` arriving as prose rather than lifted into the typed `error` field with its payload.

`plugins/no-console.grit` is the gate, and `plugins/no-process-io.grit` is the same rule for `process.stdout` and `process.stderr` — the Node habit that reaches for a stream instead of a logger. Biome's own `suspicious/noConsole` matches the same code and is deliberately not used: its message is fixed and names no replacement, and a rule that only prohibits gets suppressed by the next person who needs a line of output. Both plugins match the member access rather than the call, so `items.forEach(console.log)` and `const sink = console.error` are caught alongside `console.log(x)`. Two files are exempt, and in both `console` *is* the implementation: `logger/local.ts` sinks to `console.error` and `logger/worker.ts` emits through `console.log`, which is how a record reaches Workers Logs at all.

`bindWorkflowContext` is the Workflow peer of `bindRequestContext`. A run has no method or path; it has an instance id, and that is what anyone reading Workflows Logs searches by.

`pithy init` scaffolds both plugins and both `biome.jsonc` entries into a new project, scoped to the Worker's own `.ts` source. Those files are yours — narrow them, widen them, or drop an entry and delete its plugin with it. Pithy ships the practice; the code is yours.

`readCohort` and `resolveActivity` in `@pithy-sh/testers` take an optional `Logger`, so a degraded activity read is correlated to the request or the run that asked for it rather than surfacing as an orphaned line. Both default to the no-op logger, so no existing call changes.

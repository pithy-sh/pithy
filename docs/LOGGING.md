# Logging

_The reader's version of this page is [pithy.sh/docs/core-concepts/logging](https://pithy.sh/docs/core-concepts/logging). This copy stays in the kit because `packages/cli/src/project/versionMetadata.ts` sends an adopter to it by name._

Pithy has one `Logger` seam and two adapters. The interface is the same in the `pithy` CLI, a Worker running locally, and a deployed Worker. Only the adapter behind it changes. Capabilities log through `c.var.log`, never `console`.

A log call is a **record**, not a line: `log.info("served", { status, elapsed })`. The message is one pithy line; the data lives in structured fields. Both adapters serialize the same `LogRecord`.

## The interface

Four levels and a `child`:

```ts
log.debug(msg, fields?)
log.info(msg, fields?)
log.warn(msg, fields?)
log.error(msg, fields?)   // pass { error } — a PithyError — to carry its full payload
log.child(name, fields?)  // a namespaced sub-logger: c.var.log.child("auth")
```

Levels rank `debug` < `info` < `warn` < `error`. A logger drops anything below its threshold.

Log copy follows the brand voice. Short. No emoji, no filler. The message names what happened; every value goes in a field, where it stays queryable.

## The console rule

Reach for `c.var.log` in a request. Everywhere else — a Workflow, a Durable Object, a scheduled handler — build one with `createWorkerLogger()`, and in a Workflow wrap it in `bindWorkflowContext(log, { workflow, instance, env })` so every record carries the run.

`console` is never the answer. A console line reaches Workers Logs as an unstructured string: no level to filter on, no name to scope it to a capability, no `request` or `instance` to correlate by, and a caught `PithyError` arriving as prose rather than lifted into the typed `error` field with its payload. It is a line you can read one at a time and cannot query.

`plugins/no-console.grit` enforces it across `packages/*/src/**`. Two files are exempt, and in both `console` *is* the implementation: `logger/local.ts` sinks to `console.error`, and `logger/worker.ts` emits through `console.log`, which is how a record reaches Workers Logs at all. Banning the call there would ban the logger. Tests are exempt for a different reason — a test printing debris it reaped is output for a human at a terminal, not a log line.

`plugins/no-process-io.grit` is the same gate for `process.stdout` and `process.stderr` — the Node habit that reaches for a stream rather than a logger. It carries the opposite scope, because `packages/cli` is the one place writing to stdout is correct: that is how a CLI emits, and `--json` on stdout is a contract every command owes an agent driving it. Both gates match the member access rather than the call, so `items.forEach(console.log)` and `const sink = console.error` are caught alongside `console.log(x)`.

`pithy init` scaffolds both plugins and both `biome.jsonc` entries into a new project, scoped to `apps/*/src/**/*.ts` — the Worker's own program. Those files are yours. Narrow them, widen them, or drop an entry and delete its plugin with it.

## Mode 1 — local diagnostics

One unified diagnostic layer for the CLI process and a Worker under `pithy dev`. Human-readable and colorized for a person at a terminal, or a `--json` structured line stream for agents and CI.

The CLI logger is quiet by default (`warn`) and verbose under `--debug`. It writes to `stderr`, so a command's machine-readable `stdout` stays clean.

This is diagnostic logging only. Interactive CLI UX — prompts, spinners, `Done.`, error rendering — stays on `style.ts`. Two layers, one boundary.

## Mode 2 — CF-native structured logs

Each log emits as one per-line structured record Cloudflare Workers Logs indexes and can query — not one buried per-request blob.

`pithy init` scaffolds `wrangler.jsonc` with Workers Logs on:

```jsonc
"observability": {
  "enabled": true,
  "head_sampling_rate": 1
}
```

So structured logs are queryable in the dashboard with zero setup. Lower `head_sampling_rate` (0–1) to sample under heavy traffic.

Every Worker-side record auto-carries request-correlation fields, resolved from context with no caller effort: `request` (the CF ray id), `method`, `path`, `env` (the `ENVIRONMENT` var — the same signal Pithy stamps into each deployed Worker), and `version` (the deployed Worker version). `createBackend` also emits one access-log record per request carrying `status` and `elapsed`.

`version` is the Cloudflare version id, from the `version_metadata` binding the scaffold declares as `CF_VERSION_METADATA`. It is what answers the first question anyone asks when a deploy goes wrong: which build produced this line? The binding is top level in `wrangler.jsonc`, so every environment inherits it, and `pithy upgrade` adds it to a project scaffolded before it existed. A Worker that does not declare it still logs — the field is simply absent, which reads as "cannot say" rather than as a build to trust.

The same id reaches four other places: the control-plane manifest, a `pithy-worker-version` header on every control-plane response, the `version` column on every audit event, and the check `pithy deploy` runs to prove the Worker it just shipped is the one answering at your domain.

The scaffolded `wrangler.jsonc` sets `ENVIRONMENT` per environment (`dev` / `staging` / `prod`), so the `env` field is accurate out of the box. Where the var is absent, `createBackend({ env })` supplies a fallback, and failing that the field reads `unknown`.

## The security rule

A log is an **internal** surface. The logger carries the full `ErrorPayload` — `detail` included — because a log lives on the same side of the boundary as audit detail. This is the inverse of the HTTP codec, which strips `action` and `detail` as the single client boundary — a log is read by the operator both were written for.

The logger must never be wired to a client-facing surface. A meta-test pins it: the HTTP and terminal error surfaces do not import the logger.

## Tail / Logpush

The Mode 2 adapter takes a `transport` hook — a function called with every finished record after it is emitted. Attach one to fan the same structured records to a tail-consumer Worker or Logpush (R2 or external). The record shape is unchanged; every call site stays as it is.

```ts
createWorkerLogger({ transport: (record) => forward(record) })
```

Pass the configured logger to `createBackend({ logger })`. To route records off-Worker, add a `tail_consumers` block to `wrangler.jsonc` pointing at your consumer Worker, or enable Logpush. Records are tail/Logpush-ready by construction; v1 ships the hook, the generated `wrangler` support, and this doc — not a turnkey consumer.

## Configuring the base logger

`createBackend` defaults `c.var.log` to the Mode 2 worker logger at `info`. Pass your own to change the level, bind base fields, or attach a transport:

```ts
createBackend({
  capabilities: [...],
  logger: createWorkerLogger({ level: "info", transport }),
})
```

The `env` correlation field resolves from the `ENVIRONMENT` var automatically; `createBackend({ env })` is only a fallback for an unprovisioned run. Local dev defaults `debug`; a deployed Worker defaults `info`.

# Logging

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

Every Worker-side record auto-carries request-correlation fields, resolved from context with no caller effort: `request` (the CF ray id), `method`, `path`, `env`, and `version` (the deployed Worker version, when the `CF_VERSION_METADATA` binding is present). `createBackend` also emits one access-log record per request carrying `status` and `elapsed`.

## The security rule

A log is an **internal** surface. The logger carries the full `ErrorPayload` — `detail` included — because a log lives on the same side of the boundary as audit detail. This is the inverse of the HTTP codec, which strips `detail` as the single client boundary.

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
  env: "production",
  logger: createWorkerLogger({ level: "info", transport }),
})
```

Local dev defaults `debug`; a deployed Worker defaults `info`.

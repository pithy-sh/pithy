import { createLogger, type Logger } from "./logger";
import type { LogFields, LogLevel, LogRecord } from "./record";
import { serializeRecord } from "./record";

/**
 * Mode 2 — CF-native structured logs, for a deployed Worker. Each log emits as **one per-line
 * structured record** Cloudflare Workers Logs indexes and can query — not one buried per-request blob.
 * With `observability.enabled` on in the generated `wrangler.jsonc`, these are queryable in the
 * dashboard with zero adopter setup. The `transport` hook fans the same records to a tail-consumer
 * Worker or Logpush without touching any call site.
 */

/** Options for {@link createWorkerLogger}. */
export interface WorkerLoggerOptions {
  /** The threshold. Defaults to `info` — a deployed Worker is quieter than local dev. */
  level?: LogLevel;
  /**
   * The tail/Logpush plug point: called with every finished record after it is emitted, so records can
   * fan to a tail-consumer or Logpush unchanged. Enabling it changes no log call site.
   */
  transport?: (record: LogRecord) => void;
  /**
   * How a record reaches Workers Logs. Defaults to a single crash-proof JSON line via `console.log`,
   * which Workers Logs indexes as structured JSON. Injectable for tests.
   */
  emit?: (record: LogRecord) => void;
  /** Fields bound onto every record (e.g. `env`, `version`). */
  fields?: LogFields;
  /** A starting namespace. */
  name?: string;
  /** The clock, injectable for tests. */
  now?: () => number;
}

/**
 * Build a Mode 2 CF-native logger. The sink emits one structured line to Workers Logs, then hands the
 * same record to `transport` when one is configured. The record shape is unchanged whether or not a
 * transport is attached — tail/Logpush readiness is by construction.
 */
export function createWorkerLogger(options: WorkerLoggerOptions = {}): Logger {
  const emit = options.emit ?? ((record: LogRecord) => console.log(serializeRecord(record)));
  const { transport } = options;
  return createLogger({
    level: options.level ?? "info",
    name: options.name,
    fields: options.fields,
    now: options.now,
    sink: (record) => {
      emit(record);
      transport?.(record);
    },
  });
}

/** The per-request correlation fields bound onto every Worker-side record. Resolved from the request. */
export interface RequestContext {
  /** A stable id for this request (the CF ray id, or a generated uuid). */
  request: string;
  /** The HTTP method. */
  method: string;
  /** The request path. */
  path: string;
  /** The environment name (`dev` | `staging` | `production`), from config. */
  env: string;
  /** The deployed Worker version id, when the version-metadata binding is present. */
  version?: string;
}

/**
 * Derive a per-request logger by binding {@link RequestContext} onto `base` — so every record the
 * handler emits auto-carries `request`/`method`/`path`/`env`/`version` with no caller effort. Uses the
 * nameless `child` form, leaving the logger's namespace free for a capability to claim.
 */
export function bindRequestContext(base: Logger, context: RequestContext): Logger {
  const fields: LogFields = {
    request: context.request,
    method: context.method,
    path: context.path,
    env: context.env,
  };
  if (context.version !== undefined) fields.version = context.version;
  return base.child(undefined, fields);
}

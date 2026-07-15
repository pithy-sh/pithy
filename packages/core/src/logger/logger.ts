import type { ErrorPayload } from "../error/payload";
import { PithyError } from "../error/pithyError";
import { LOG_LEVEL_ORDER, type LogFields, type LogLevel, type LogRecord } from "./record";

/**
 * The `Logger` seam. Four levels, each taking a message plus **structured fields** (not a formatted
 * string), and `child(name)` to derive a namespaced sub-logger. Shared across runtimes: the same
 * interface backs the `pithy` CLI process, a Worker running locally, and a deployed Worker — only the
 * adapter behind it differs. Resolve it from the request context (`c.var.log`) or the CLI process
 * logger; never reach for `console`.
 *
 * The reserved `error` field on any call may carry a `PithyError` or `ErrorPayload` — the engine lifts
 * it into the record's `error`, `detail` and all. A log is internal; this is the inverse of the HTTP
 * codec, which strips `detail`. The logger must never be wired to a client-facing surface.
 */
export interface Logger {
  /** Dev-time diagnostics. Dropped unless the logger's level is `debug`. */
  debug(msg: string, fields?: LogFields): void;
  /** Normal operational events. */
  info(msg: string, fields?: LogFields): void;
  /** A recoverable problem worth attention. */
  warn(msg: string, fields?: LogFields): void;
  /** A failure that was observed. Pass `{ error }` (a PithyError) to carry its full payload. */
  error(msg: string, fields?: LogFields): void;
  /**
   * A namespaced sub-logger. `name` composes as `parent:child`; bound `fields` merge into every record
   * the child emits. Omit `name` (pass `undefined`) to bind fields only — how request-correlation
   * attaches `request`/`method`/`path` without renaming the logger.
   */
  child(name?: string, fields?: LogFields): Logger;
}

/** A sink receives a finished {@link LogRecord}. Adapters supply one; the engine builds records and calls it. */
export type LogSink = (record: LogRecord) => void;

/** Inputs to {@link createLogger}: the level threshold, the sink, and optional bound name/fields/clock. */
export interface CreateLoggerOptions {
  /** The threshold; records below it are dropped. */
  level: LogLevel;
  /** Where finished records go. */
  sink: LogSink;
  /** A starting namespace for this logger, if any. */
  name?: string;
  /** Fields bound onto every record this logger emits. */
  fields?: LogFields;
  /** The clock, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** Internal, fully-resolved logger state — `now` and `level` always set. */
interface LoggerState {
  level: LogLevel;
  sink: LogSink;
  name?: string;
  fields?: LogFields;
  now: () => number;
}

/**
 * Duck-type an `ErrorPayload`: a **namespaced** `code` (`domain/reason`) plus an HTTP-range `status`.
 * Cheap — no per-call Zod parse. The `/` and status-range checks keep an ordinary field that happens to
 * be named `error` (e.g. `{ code: "retry", status: 3 }`) from being mistaken for a payload and lifted.
 */
function isErrorPayloadLike(value: unknown): value is ErrorPayload {
  if (typeof value !== "object" || value === null) return false;
  const { code, status } = value as { code?: unknown; status?: unknown };
  return (
    typeof code === "string" &&
    code.includes("/") &&
    typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
  );
}

/** Build a logger over `state`: level-filters, merges bound + call fields, lifts a carried error. */
function makeLogger(state: LoggerState): Logger {
  const emit = (level: LogLevel, msg: string, callFields?: LogFields): void => {
    if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[state.level]) return;
    const merged: LogFields = { ...state.fields, ...callFields };

    // Lift a reserved `error` field into the record's typed `error` — a PithyError contributes its full
    // payload (detail included); a raw ErrorPayload passes through. Everything else stays a plain field.
    let error: ErrorPayload | undefined;
    const carried = merged.error;
    if (carried instanceof PithyError) {
      error = carried.payload;
      delete merged.error;
    } else if (isErrorPayloadLike(carried)) {
      error = carried;
      delete merged.error;
    }

    const record: LogRecord = { level, msg, time: state.now() };
    if (state.name) record.name = state.name;
    if (Object.keys(merged).length > 0) record.fields = merged;
    if (error) record.error = error;
    state.sink(record);
  };

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (name, fields) =>
      makeLogger({
        ...state,
        name: name ? (state.name ? `${state.name}:${name}` : name) : state.name,
        fields: { ...state.fields, ...fields },
      }),
  };
}

/**
 * The shared logger engine. Both adapters build on it: they supply a {@link LogSink} and a level, and
 * this handles level filtering, `child` namespacing, field merging, and error lifting — one place, so
 * every adapter behaves identically.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  return makeLogger({
    level: options.level,
    sink: options.sink,
    name: options.name,
    fields: options.fields,
    now: options.now ?? (() => Date.now()),
  });
}

/**
 * The safe default: a logger that drops every record. Shipped so a capability that does nothing still
 * has a `c.var.log` to call, and a KV store built without a logger still logs to *somewhere*. Both
 * adapters replace it; nothing has to null-check `log`.
 */
export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

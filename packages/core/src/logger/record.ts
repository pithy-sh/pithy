// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { ErrorPayload } from "../error/payload";

/**
 * The logger object model. A log call is a **record**, not a formatted line — `{ level, msg, ...fields }`
 * — so both adapters (local diagnostics, CF-native) serialize the same structured shape rather than
 * re-parsing text. The schema IS the documentation: every field carries a `.describe()`, like any other
 * Pithy boundary. Log copy follows the brand voice — the `msg` is one pithy line; data lives in `fields`.
 */

/** The four severities, low to high. `debug` is dev diagnostics; `error` is a failure that was observed. */
export const LogLevel = z
  .enum(["debug", "info", "warn", "error"])
  .describe("Log severity, low to high: `debug` < `info` < `warn` < `error`. The threshold a logger filters on.");
export type LogLevel = z.output<typeof LogLevel>;

/**
 * Numeric rank per level, for threshold filtering — a logger drops any record ranked below its level.
 * Not a schema (it is a lookup table), so the meta-test that polices `.describe()` skips it.
 */
export const LOG_LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Structured fields carried on a record — the data half of a log. Arbitrary JSON-ish values keyed by
 * name (`{ userId, elapsed, request }`); an adapter renders or serializes them. The reserved key
 * `error` may carry a `PithyError` or `ErrorPayload`; the engine lifts it into {@link LogRecord.error}.
 */
export const LogFields = z
  .record(z.string(), z.unknown())
  .describe("Structured, arbitrary fields carried on a log record — the queryable data half of a log call.");
export type LogFields = z.output<typeof LogFields>;

/**
 * One finished log record — what an adapter's sink receives. This is the on-the-wire structured shape
 * CF Workers Logs indexes per line and the local adapter renders. `error` carries the **full**
 * `ErrorPayload` including `detail`: a log is an internal surface (the same side of the boundary as
 * audit `detail`), the inverse of the HTTP codec which strips it. A logger is never wired to a client.
 */
export const LogRecord = z
  .object({
    level: LogLevel.describe("The severity of this record."),
    msg: z.string().describe("The one-line, brand-voice message. No data — data lives in `fields`."),
    time: z.number().int().describe("When the record was made, as a millisecond epoch."),
    name: z.string().nullish().describe("The emitting logger's namespace (from `child(name)`), if any."),
    fields: LogFields.nullish().describe("Structured fields carried on this record, if any were supplied."),
    error: ErrorPayload.nullish().describe(
      "The full error payload — `detail` included — when the call carried a PithyError. Internal only.",
    ),
  })
  .describe("One structured log record: an adapter's sink serializes or renders exactly this shape.");
export type LogRecord = z.output<typeof LogRecord>;

/** How many of an `AggregateError`'s `errors` one log line carries; the rest are counted. */
const MAX_LOGGED_ERRORS = 10;

/** How many causes deep one log line follows a chain; the rest are counted. */
const MAX_LOGGED_CAUSES = 5;

/**
 * An `Error` as the plain object a log line can carry. `JSON.stringify` writes an `Error` as `{}`, because its
 * `name`, `message`, `stack` and `cause` are not own enumerable properties. Own enumerable ones follow them, which
 * is how a `PithyError`'s `payload` (`detail` included — a log is internal) and a Node error's `code` survive.
 *
 * Bounded so one line stays one line: an `AggregateError` writes its first {@link MAX_LOGGED_ERRORS} errors, and a
 * cause chain is followed {@link MAX_LOGGED_CAUSES} causes deep. `seen` is the replacer's, so a cycle through a
 * cause is still `"[Circular]"`.
 */
function errorFields(error: Error, seen: WeakSet<object>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = { name: error.name, message: error.message };
  if (error.stack !== undefined) out.stack = error.stack;
  for (const [key, value] of Object.entries(error)) if (!(key in out)) out[key] = value;
  if (error.cause !== undefined) out.cause = causeField(error.cause, seen, depth + 1);
  if (error instanceof AggregateError) {
    const errors: unknown[] = Array.isArray(error.errors) ? error.errors : [];
    out.errors = errors.slice(0, MAX_LOGGED_ERRORS).map((item) => causeField(item, seen, depth + 1));
    if (errors.length > MAX_LOGGED_ERRORS) out.errorsOmitted = errors.length - MAX_LOGGED_ERRORS;
  }
  return out;
}

/** A cause (or an aggregated error) at `depth`: an `Error` is expanded until the depth runs out, then counted. */
function causeField(cause: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (!(cause instanceof Error)) return cause;
  if (seen.has(cause)) return "[Circular]";
  if (depth > MAX_LOGGED_CAUSES) return `[${chainLength(cause)} more causes]`;
  seen.add(cause);
  return errorFields(cause, seen, depth);
}

/** How many errors a cause chain holds from `error` down, walked without recursion and stopped by a cycle. */
function chainLength(error: Error): number {
  const walked = new Set<unknown>();
  let node: unknown = error;
  while (node instanceof Error && !walked.has(node)) {
    walked.add(node);
    node = node.cause;
  }
  return walked.size;
}

/**
 * A JSON replacer that keeps serialization total and legible: `BigInt` becomes a string, a repeated object
 * reference (a cycle) becomes `"[Circular]"`, and an `Error` becomes its {@link errorFields}. A logger must never
 * throw — an unserializable field in a log call must not crash the caller — so every sink serializes through
 * {@link serializeRecord} or {@link serializeLogValue}.
 */
function safeReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return (_key, value) => {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
      if (value instanceof Error) return errorFields(value, seen);
    }
    return value;
  };
}

/**
 * Serialize a record to one JSON line, tolerating cycles and `BigInt` so a log call is crash-proof. If
 * even the safe pass fails, fall back to the always-serializable core fields — never throw.
 */
export function serializeRecord(record: LogRecord): string {
  try {
    return JSON.stringify(record, safeReplacer());
  } catch {
    return JSON.stringify({ level: record.level, msg: record.msg, time: record.time });
  }
}

/**
 * Serialize one field value to compact JSON by the same rules as {@link serializeRecord}, for a sink that renders
 * fields one at a time. A value JSON has no text for (`undefined`, a function) renders as `String(value)`.
 */
export function serializeLogValue(value: unknown): string {
  try {
    return JSON.stringify(value, safeReplacer()) ?? String(value);
  } catch {
    return String(value);
  }
}

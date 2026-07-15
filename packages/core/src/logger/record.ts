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

/**
 * A JSON replacer that keeps serialization total: `BigInt` becomes a string, and a repeated object
 * reference (a cycle) becomes `"[Circular]"`. A logger must never throw — an unserializable field in a
 * log call must not crash the caller — so both adapters serialize through {@link serializeRecord}.
 */
function safeReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return (_key, value) => {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
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

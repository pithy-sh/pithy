// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * SQLite/D1 codecs: bidirectional JS ↔ SQLite conversion through Zod.
 *
 * SQLite has no booleans, no real dates, and no JSON — it stores 0|1, ms-epoch
 * numbers, and strings. These codecs make that conversion the schema's job.
 * `.parse()` decodes (DB → app); `.encode()` encodes (app → DB). Decode-side
 * input is always a `z.union` (never `z.preprocess`) so the schema stays
 * encode-compatible.
 *
 * **A codec reports; it never throws.** `safeParse` cannot throw — only `parse`
 * throws — and every boundary reader in this kit and in the dashboard is written
 * on that promise: `const parsed = X.safeParse(body); return parsed.success ?
 * parsed.data : null;`, documented as *never throws*. Zod's `safeParse` catches a
 * `ZodError`; it does **not** catch an arbitrary exception raised inside a
 * transform, which propagates straight past it and out of the reader. So a
 * transform that meets a value it cannot convert pushes a `$ZodRawIssue` onto the
 * payload and returns `z.NEVER`. Zod aborts there, the failure arrives as
 * `{ success: false }`, and `parse` still throws — a `ZodError`, which
 * `fromZodError` maps to `validation/invalid_input` like every other failed parse.
 *
 * `JsonDate` and `SQLiteDate` threw an `InternalError` from inside `decode`, so a
 * malformed timestamp from a customer's Worker was a 500 rather than a rejected
 * field, on every pane that read a date (#358). The rule lives here rather than at
 * the readers because a `try`/`catch` at a call site is the same defect one frame
 * further out, and the next codec would not inherit it.
 *
 * The offending value rides along as the issue's `input`, which is where Zod puts
 * it and which {@link fromZodError} drops — it keeps `path`, `message` and `code`
 * only, so the value stays available to a logger at the throw site and never
 * reaches a client. The `message` is written to be read by one: client-safe, and
 * still specific enough to say *what* was wrong.
 */

/**
 * The invariant every transform below is written to, stated once so it can be cited:
 * push, return `z.NEVER`, never `throw`.
 */
type Payload<T> = z.core.ParsePayload<T>;

const TRUTHY: readonly unknown[] = [true, 1, "1", "true", "True", "TRUE"];

function isTruthy(value: unknown): boolean {
  return TRUTHY.includes(value);
}

/** SQLiteBoolean: boolean ↔ 0|1. Decode is lenient (number/boolean/string). */
export const SQLiteBoolean = z.codec(z.union([z.literal(0), z.literal(1), z.boolean(), z.string()]), z.boolean(), {
  decode: (input: 0 | 1 | boolean | string): boolean => (typeof input === "boolean" ? input : isTruthy(input)),
  encode: (value: boolean): 0 | 1 => (value ? 1 : 0),
});

/**
 * The shared decode for both date codecs. A string is parsed, a number is ms-epoch — what `encode`
 * writes, so a caller ingesting seconds-epoch from elsewhere converts explicitly — and a `Date` passes
 * through by identity.
 *
 * **Every branch can produce an unusable `Date`**, not only the string one: `new Date(8.64e15 + 1)` is
 * as invalid as `new Date("not-a-date")`. So the check is on the result, once, rather than on the input
 * shape — which is what stops the next accepted input type from arriving without it.
 */
function toDate(input: number | string | Date, payload: Payload<number | string | Date>): Date {
  const parsed = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    payload.issues.push({ code: "invalid_format", format: "datetime", input: String(input), message: "Not a date." });
    return z.NEVER;
  }
  return parsed;
}

/** SQLiteDate: Date ↔ ms-epoch number. Decode accepts number/string/Date. */
export const SQLiteDate = z.codec(z.union([z.number(), z.string(), z.date()]), z.date(), {
  decode: toDate,
  encode: (value: Date): number => value.getTime(),
});

/** JsonDate: Date ↔ ISO string, for dates nested inside `sqliteJson` payloads. */
export const JsonDate = z.codec(z.union([z.string(), z.number(), z.date()]), z.date(), {
  decode: toDate,
  encode: (value: Date): string => value.toISOString(),
});

/**
 * sqliteJson: T ↔ JSON string, validated by `schema` on both sides. Decode
 * accepts a JSON string or an already-parsed value; the result is validated
 * against `schema` before it reaches the app.
 *
 * **Both `JSON` functions throw**, and both were reachable. `JSON.parse` throws a
 * `SyntaxError` on any string that is not a JSON document — which a column holding
 * text an older writer put there, or a payload a customer's Worker returned, can be.
 * `JSON.stringify` throws a `TypeError` on a `BigInt` and on a cycle, either of
 * which a `schema` can legitimately admit. Both become an issue (#358).
 */
export function sqliteJson<T extends z.ZodType>(schema: T) {
  return z.codec(z.union([z.string(), schema]), schema, {
    decode: (value, payload): z.input<T> => {
      if (typeof value !== "string") return value as z.input<T>;
      try {
        return JSON.parse(value) as z.input<T>;
      } catch {
        payload.issues.push({ code: "invalid_format", format: "json", input: value, message: "Not valid JSON." });
        return z.NEVER;
      }
    },
    encode: (value, payload): string => {
      // The offending value is deliberately not carried onto the issue: it is the thing JSON could not
      // hold, so a reporter that renders an issue would be the second place to trip over it.
      try {
        const json = JSON.stringify(value);
        if (typeof json === "string") return json;
      } catch {
        // Falls through to the one push below. A `BigInt`, a cycle and an `undefined` result are the
        // same answer — this value does not survive the round trip — and they deserve the same issue.
      }
      payload.issues.push({
        code: "invalid_format",
        format: "json",
        input: undefined,
        message: "Not serializable as JSON.",
      });
      return z.NEVER;
    },
  });
}

export const MAX_TIMEZONE_LENGTH = 64;

/**
 * Trim, validate, and canonicalize an IANA timezone; anything invalid becomes
 * `undefined`. Returns Intl's canonical casing (`america/new_york` →
 * `America/New_York`) so a zone is stored and compared as one value.
 */
export function normalizeIanaTimezone(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TIMEZONE_LENGTH) return undefined;
  try {
    return Intl.DateTimeFormat(undefined, { timeZone: trimmed }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/** Whether `value` is a usable IANA timezone (bounded length, recognized by Intl). */
export function isValidIanaTimezone(value: string): boolean {
  return normalizeIanaTimezone(value) !== undefined;
}

/**
 * IanaTimezone: validated/bounded IANA timezone string. Coerces invalid input
 * to `undefined` on both decode and encode rather than throwing.
 */
export const IanaTimezone = z.codec(z.string().nullish(), z.string().optional(), {
  decode: (input: string | null | undefined): string | undefined => normalizeIanaTimezone(input),
  encode: (value: string | undefined): string | undefined => normalizeIanaTimezone(value),
});

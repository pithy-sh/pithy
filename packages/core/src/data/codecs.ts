import { z } from "zod";

/**
 * SQLite/D1 codecs: bidirectional JS ↔ SQLite conversion through Zod.
 *
 * SQLite has no booleans, no real dates, and no JSON — it stores 0|1, ms-epoch
 * numbers, and strings. These codecs make that conversion the schema's job.
 * `.parse()` decodes (DB → app); `.encode()` encodes (app → DB). Decode-side
 * input is always a `z.union` (never `z.preprocess`) so the schema stays
 * encode-compatible.
 */

const TRUTHY: readonly unknown[] = [true, 1, "1", "true", "True", "TRUE"];

function isTruthy(value: unknown): boolean {
  return TRUTHY.includes(value);
}

/** SQLiteBoolean: boolean ↔ 0|1. Decode is lenient (number/boolean/string). */
export const SQLiteBoolean = z.codec(z.union([z.literal(0), z.literal(1), z.boolean(), z.string()]), z.boolean(), {
  decode: (input: 0 | 1 | boolean | string): boolean => (typeof input === "boolean" ? input : isTruthy(input)),
  encode: (value: boolean): 0 | 1 => (value ? 1 : 0),
});

function toDate(input: number | string | Date): Date {
  if (input instanceof Date) return input;
  if (typeof input === "string") {
    const parsed = new Date(input);
    if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid date string: ${input}`);
    return parsed;
  }
  // A number is always ms-epoch — what `encode` writes. Callers ingesting
  // seconds-epoch from elsewhere convert explicitly.
  return new Date(input);
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
 */
export function sqliteJson<T extends z.ZodType>(schema: T) {
  return z.codec(z.union([z.string(), schema]), schema, {
    decode: (value): z.input<T> => (typeof value === "string" ? JSON.parse(value) : value) as z.input<T>,
    encode: (value): string => JSON.stringify(value),
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

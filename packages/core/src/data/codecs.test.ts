// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { fromZodError, PithyError } from "../error/pithyError";
import {
  IanaTimezone,
  isValidIanaTimezone,
  JsonDate,
  normalizeIanaTimezone,
  SQLiteBoolean,
  SQLiteDate,
  sqliteJson,
} from "./codecs";

describe("SQLiteBoolean", () => {
  test("decodes 1 -> true and 0 -> false", () => {
    expect(SQLiteBoolean.parse(1)).toBe(true);
    expect(SQLiteBoolean.parse(0)).toBe(false);
  });

  test("decodes lenient truthy strings/booleans", () => {
    expect(SQLiteBoolean.parse("true")).toBe(true);
    expect(SQLiteBoolean.parse("1")).toBe(true);
    expect(SQLiteBoolean.parse("false")).toBe(false);
    expect(SQLiteBoolean.parse(true)).toBe(true);
  });

  test("maps any unrecognized string to false (lenient by design)", () => {
    expect(SQLiteBoolean.parse("yes")).toBe(false);
    expect(SQLiteBoolean.parse("2")).toBe(false);
    expect(SQLiteBoolean.parse("")).toBe(false);
  });

  test("encodes true -> 1 and false -> 0", () => {
    expect(SQLiteBoolean.encode(true)).toBe(1);
    expect(SQLiteBoolean.encode(false)).toBe(0);
  });

  test("round-trips app -> db -> app", () => {
    expect(SQLiteBoolean.parse(SQLiteBoolean.encode(true))).toBe(true);
    expect(SQLiteBoolean.parse(SQLiteBoolean.encode(false))).toBe(false);
  });
});

describe("SQLiteDate", () => {
  test("decodes ms-epoch number -> Date", () => {
    const ms = 1_700_000_000_000;
    expect(SQLiteDate.parse(ms)).toEqual(new Date(ms));
  });

  test("decodes a Date instance (passthrough)", () => {
    const d = new Date("2026-06-09T00:00:00.000Z");
    expect(SQLiteDate.parse(d)).toBe(d);
  });

  test("round-trips a pre-1973 date (numbers are always ms)", () => {
    const old = new Date("1970-06-15T00:00:00.000Z");
    expect(SQLiteDate.parse(SQLiteDate.encode(old))).toEqual(old);
  });

  test("decodes ISO string -> Date", () => {
    expect(SQLiteDate.parse("2026-06-09T00:00:00.000Z")).toEqual(new Date("2026-06-09T00:00:00.000Z"));
  });

  test("throws on invalid date string", () => {
    expect(() => SQLiteDate.parse("not-a-date")).toThrow();
  });

  test("the invalid-date throw is a ZodError, so `parse` keeps its own contract", () => {
    expect(() => SQLiteDate.parse("not-a-date")).toThrow(z.ZodError);
    expect(() => SQLiteDate.parse("not-a-date")).not.toThrow(PithyError);
  });

  test("encodes Date -> ms-epoch number", () => {
    const d = new Date("2026-06-09T00:00:00.000Z");
    expect(SQLiteDate.encode(d)).toBe(d.getTime());
  });

  test("round-trips app -> db -> app", () => {
    const d = new Date("2026-06-09T12:34:56.000Z");
    expect(SQLiteDate.parse(SQLiteDate.encode(d))).toEqual(d);
  });
});

describe("sqliteJson", () => {
  const Payload = z.object({ a: z.number(), b: z.string() });
  const codec = sqliteJson(Payload);

  test("decodes a JSON string -> validated object", () => {
    expect(codec.parse('{"a":1,"b":"x"}')).toEqual({ a: 1, b: "x" });
  });

  test("decodes an already-parsed object (passthrough)", () => {
    expect(codec.parse({ a: 2, b: "y" })).toEqual({ a: 2, b: "y" });
  });

  test("encodes an object -> JSON string", () => {
    expect(codec.encode({ a: 3, b: "z" })).toBe('{"a":3,"b":"z"}');
  });

  test("rejects a payload that violates the inner schema", () => {
    expect(() => codec.parse('{"a":"not-a-number","b":"x"}')).toThrow();
  });

  test("round-trips app -> db -> app", () => {
    const value = { a: 9, b: "round" };
    expect(codec.parse(codec.encode(value))).toEqual(value);
  });
});

describe("JsonDate", () => {
  test("decodes ISO string -> Date and encodes Date -> ISO string", () => {
    const iso = "2026-06-09T00:00:00.000Z";
    expect(JsonDate.parse(iso)).toEqual(new Date(iso));
    expect(JsonDate.encode(new Date(iso))).toBe(iso);
  });

  test("round-trips through sqliteJson", () => {
    const Wrapper = z.object({ when: JsonDate });
    const codec = sqliteJson(Wrapper);
    const value = { when: new Date("2026-06-09T01:02:03.000Z") };
    expect(codec.parse(codec.encode(value))).toEqual(value);
  });
});

describe("IanaTimezone", () => {
  test("accepts a valid zone", () => {
    expect(IanaTimezone.parse("America/New_York")).toBe("America/New_York");
  });

  test("canonicalizes casing on decode and encode", () => {
    expect(IanaTimezone.parse("america/new_york")).toBe("America/New_York");
    expect(IanaTimezone.encode("America/New_York")).toBe("America/New_York");
  });

  test("coerces invalid/garbage to undefined (decode and encode)", () => {
    expect(IanaTimezone.parse("Not/AZone")).toBeUndefined();
    expect(IanaTimezone.parse("")).toBeUndefined();
    expect(IanaTimezone.encode("Not/AZone")).toBeUndefined();
  });
});

describe("isValidIanaTimezone", () => {
  test("accepts real zones", () => {
    expect(isValidIanaTimezone("America/New_York")).toBe(true);
    expect(isValidIanaTimezone("UTC")).toBe(true);
  });

  test("rejects empty and over-length input", () => {
    expect(isValidIanaTimezone("")).toBe(false);
    expect(isValidIanaTimezone("A".repeat(65))).toBe(false);
  });

  test("rejects garbage zones", () => {
    expect(isValidIanaTimezone("Not/AZone")).toBe(false);
  });
});

describe("normalizeIanaTimezone", () => {
  test("trims and canonicalizes a valid zone", () => {
    expect(normalizeIanaTimezone("  America/New_York  ")).toBe("America/New_York");
    expect(normalizeIanaTimezone("america/new_york")).toBe("America/New_York");
  });

  test("returns undefined for non-strings and garbage", () => {
    expect(normalizeIanaTimezone(123)).toBeUndefined();
    expect(normalizeIanaTimezone("garbage")).toBeUndefined();
    expect(normalizeIanaTimezone(undefined)).toBeUndefined();
  });
});

/**
 * **`safeParse` cannot throw. Only `parse` throws.** That is the whole contract, and every boundary
 * reader in this kit and in the dashboard is written on it — `const parsed = X.safeParse(body); return
 * parsed.success ? parsed.data : null;`, documented as *never throws*.
 *
 * Zod's `safeParse` catches a `ZodError`. It does not catch an arbitrary exception thrown from inside a
 * transform, which propagates straight out. So a codec reports an issue; it never throws (#358).
 */
describe("a codec reports, it does not throw", () => {
  const Hostile = z.object({ at: JsonDate, on: SQLiteDate });

  test("a malformed timestamp inside a shape fails safely rather than escaping", () => {
    expect(() => Hostile.safeParse({ at: "not-a-date", on: 0 })).not.toThrow();
    expect(() => Hostile.safeParse({ at: 0, on: "not-a-date" })).not.toThrow();
    expect(Hostile.safeParse({ at: "not-a-date", on: 0 }).success).toBe(false);
    expect(Hostile.safeParse({ at: 0, on: "not-a-date" }).success).toBe(false);
  });

  test("a number no Date can hold is rejected by the codec, not left to `z.date()`", () => {
    // 8.64e15 is the largest instant a Date holds; one past it is as unusable as "not-a-date", and it
    // arrives through the number branch. The old check looked only at strings, so this fell through to
    // the out schema and answered "Invalid input: expected date" — true, and useless to whoever has to
    // find the row. The message is the assertion: it proves which check refused it.
    expect(() => SQLiteDate.safeParse(8.64e15 + 1)).not.toThrow();
    expect(SQLiteDate.safeParse(8.64e15 + 1).error?.issues[0]?.message).toBe("Not a date.");
    expect(() => JsonDate.safeParse(8.64e15 + 1)).not.toThrow();
    expect(JsonDate.safeParse(8.64e15 + 1).error?.issues[0]?.message).toBe("Not a date.");

    // `NaN` never reaches the transform — `z.number()` refuses it on the input side, so the union
    // fails first and the message is Zod's. Still a return rather than a throw, which is the contract.
    expect(() => JsonDate.safeParse(Number.NaN)).not.toThrow();
    expect(JsonDate.safeParse(Number.NaN).success).toBe(false);
  });

  test("the issue still says it was a date, and never carries the offending value", () => {
    const result = SQLiteDate.safeParse("not-a-date");
    expect(result.success).toBe(false);
    const issue = result.error?.issues[0];
    expect(issue?.message).toBe("Not a date.");
    expect(JSON.stringify(issue?.message)).not.toContain("not-a-date");
  });

  test("`fromZodError` still maps it — a labeled validation failure, not an unlabeled one", () => {
    const result = SQLiteDate.safeParse("not-a-date");
    if (result.success) throw new Error("expected a failed parse");
    const mapped = fromZodError(result.error);
    expect(mapped).toBeInstanceOf(PithyError);
    expect(mapped.payload.code).toBe("validation/invalid_input");
    expect(mapped.payload.issues?.[0]?.message).toBe("Not a date.");
    expect(mapped.payload.issues?.[0]?.code).toBeTruthy();
  });

  test("malformed JSON fails safely — `JSON.parse` throws, so `sqliteJson` must not let it", () => {
    const codec = sqliteJson(z.object({ a: z.number() }));
    expect(() => codec.safeParse("{not json")).not.toThrow();
    expect(codec.safeParse("{not json").success).toBe(false);
    expect(codec.safeParse("{not json").error?.issues[0]?.message).toBe("Not valid JSON.");
  });

  test("a value JSON cannot hold fails safely on the way out", () => {
    const codec = sqliteJson(z.object({ a: z.bigint() }));
    expect(() => codec.safeEncode({ a: 1n })).not.toThrow();
    expect(codec.safeEncode({ a: 1n }).success).toBe(false);
  });

  test("`safeEncode` never throws either — a codec runs in both directions", () => {
    expect(() => JsonDate.safeEncode(new Date(Number.NaN))).not.toThrow();
    expect(JsonDate.safeEncode(new Date(Number.NaN)).success).toBe(false);
    expect(() => SQLiteDate.safeEncode(new Date(Number.NaN))).not.toThrow();
    expect(SQLiteDate.safeEncode(new Date(Number.NaN)).success).toBe(false);
  });

  test("and a valid value still round-trips, unchanged, in both directions", () => {
    const iso = "2026-06-09T01:02:03.000Z";
    const date = new Date(iso);

    const jsonOut: z.output<typeof JsonDate> = JsonDate.parse(iso);
    const jsonIn: z.input<typeof JsonDate> = JsonDate.encode(date);
    expect(jsonOut).toEqual(date);
    expect(jsonIn).toBe(iso);
    expect(JsonDate.parse(JsonDate.encode(date))).toEqual(date);
    expect(JsonDate.encode(JsonDate.parse(iso))).toBe(iso);

    const sqlOut: z.output<typeof SQLiteDate> = SQLiteDate.parse(date.getTime());
    const sqlIn: z.input<typeof SQLiteDate> = SQLiteDate.encode(date);
    expect(sqlOut).toEqual(date);
    expect(sqlIn).toBe(date.getTime());
    expect(SQLiteDate.parse(SQLiteDate.encode(date))).toEqual(date);
    expect(SQLiteDate.encode(SQLiteDate.parse(date.getTime()))).toBe(date.getTime());

    const codec = sqliteJson(z.object({ a: z.number() }));
    expect(codec.parse(codec.encode({ a: 7 }))).toEqual({ a: 7 });
    expect(codec.encode(codec.parse('{"a":7}'))).toBe('{"a":7}');
  });
});

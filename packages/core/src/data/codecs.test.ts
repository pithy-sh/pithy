import { describe, expect, test } from "vitest";
import { z } from "zod";
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

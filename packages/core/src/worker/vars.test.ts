// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { ValidationError } from "../error/pithyError";
import { defineVars, isWorkerVars, parseVar, type VarFallback, varValueFor } from "./vars";

const VARS = defineVars({
  READY_AFTER_MINUTES: {
    description: "Minutes after the cron the next file is ready.",
    schema: z.coerce.number().int().min(0),
    default: 15,
    environments: { prod: 30 },
  },
  MODE: {
    description: "Which feed to read.",
    schema: z.enum(["live", "replay"]),
    default: "live",
  },
});

describe("defineVars", () => {
  it("requires a description on every var at the type level", () => {
    expect(() =>
      defineVars({
        // @ts-expect-error a var without a description is not a declaration
        NO_DESCRIPTION: { schema: z.string(), default: "x" },
      }),
    ).toThrow(/description/);
  });

  it("types the default and each environment's value against the schema's input", () => {
    expect(() =>
      defineVars({
        // @ts-expect-error a default the schema does not take
        WRONG: { description: "A number.", schema: z.number(), default: "fifteen" },
      }),
    ).toThrow(/WRONG/);
  });

  it("refuses an empty description at runtime too", () => {
    expect(() => defineVars({ X: { description: "  ", schema: z.string(), default: "x" } })).toThrow(ValidationError);
  });

  it("refuses a name wrangler cannot bind", () => {
    expect(() => defineVars({ "not-a-name": { description: "Bad.", schema: z.string(), default: "x" } })).toThrow(
      /not-a-name/,
    );
  });

  it.each(["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"])(
    "refuses %s, a name every object already answers to",
    (name) => {
      const vars: Record<string, unknown> = {};
      Object.defineProperty(vars, name, {
        value: { description: "Shadowed.", schema: z.string(), default: "a" },
        enumerable: true,
      });
      expect(() => defineVars(vars as Parameters<typeof defineVars>[0])).toThrow(new RegExp(name));
    },
  );

  it("refuses a default its own schema refuses", () => {
    expect(() => defineVars({ COUNT: { description: "A count.", schema: z.number().min(1), default: 0 } })).toThrow(
      /COUNT/,
    );
  });

  it("refuses an environment value its own schema refuses, naming the environment", () => {
    expect(() =>
      defineVars({
        COUNT: { description: "A count.", schema: z.number().min(1), default: 1, environments: { staging: 0 } },
      }),
    ).toThrow(/staging/);
  });

  it("is recognized as a declaration, and a plain object is not", () => {
    expect(isWorkerVars(VARS)).toBe(true);
    expect(isWorkerVars({ READY_AFTER_MINUTES: 15 })).toBe(false);
  });
});

describe("read", () => {
  it("parses each var through its schema, typed", () => {
    const vars = VARS.read({ READY_AFTER_MINUTES: 20, MODE: "replay" });
    expect(vars).toEqual({ READY_AFTER_MINUTES: 20, MODE: "replay" });
    expectTypeOf(vars.READY_AFTER_MINUTES).toEqualTypeOf<number>();
    expectTypeOf(vars.MODE).toEqualTypeOf<"live" | "replay">();
  });

  it("falls back to the default on a missing var", () => {
    expect(VARS.read({})).toEqual({ READY_AFTER_MINUTES: 15, MODE: "live" });
  });

  it("falls back to the default on an invalid var", () => {
    expect(VARS.read({ READY_AFTER_MINUTES: "soon", MODE: "paused" })).toEqual({
      READY_AFTER_MINUTES: 15,
      MODE: "live",
    });
  });

  it("reads a JSON value that arrived as text, the way a .dev.vars line arrives", () => {
    const flags = defineVars({
      FLAGS: { description: "Feature flags.", schema: z.object({ beta: z.boolean() }), default: { beta: false } },
    });
    expect(flags.read({ FLAGS: '{"beta":true}' })).toEqual({ FLAGS: { beta: true } });
  });

  it("falls back to the default on a number written as exponent text", () => {
    expect(VARS.read({ READY_AFTER_MINUTES: "1e3" }).READY_AFTER_MINUTES).toBe(15);
  });

  it("treats an env that is not an object as one holding nothing", () => {
    expect(VARS.read(undefined)).toEqual({ READY_AFTER_MINUTES: 15, MODE: "live" });
  });

  it("tells onFallback, in the same read, which vars fell back and why", () => {
    const LIMITS = defineVars({
      READY_AFTER_MINUTES: VARS.vars.READY_AFTER_MINUTES,
      MODE: VARS.vars.MODE,
      REGION: { description: "Where to read from.", schema: z.string(), default: "eu" },
    });
    const fallbacks: VarFallback[] = [];
    const vars = LIMITS.read({ MODE: "paused", REGION: "us" }, { onFallback: (fallback) => fallbacks.push(fallback) });
    expect(vars).toEqual({ READY_AFTER_MINUTES: 15, MODE: "live", REGION: "us" });
    expect(fallbacks).toEqual([
      { name: "READY_AFTER_MINUTES", raw: undefined, reason: "missing", problem: "missing", issues: [] },
      {
        name: "MODE",
        raw: "paused",
        reason: "invalid",
        problem: expect.stringMatching(/live/),
        issues: [expect.objectContaining({ code: "invalid_value", path: [] })],
      },
    ]);
  });

  it("gives the plain-decimal rule as the issue for a number written another way", () => {
    const fallbacks: VarFallback[] = [];
    VARS.read({ READY_AFTER_MINUTES: "1e3", MODE: "live" }, { onFallback: (fallback) => fallbacks.push(fallback) });
    expect(fallbacks).toEqual([
      {
        name: "READY_AFTER_MINUTES",
        raw: "1e3",
        reason: "invalid",
        problem: expect.stringMatching(/plain decimal/),
        issues: [{ code: "custom", message: expect.stringMatching(/plain decimal/), path: [], input: "1e3" }],
      },
    ]);
  });

  it.each(["STRICT", "COERCED"] as const)(
    "gives the plain-decimal rule as the issue for every other way of writing a number under a %s number schema",
    (name) => {
      const NUMBER = defineVars({
        STRICT: { description: "A plain number.", schema: z.number(), default: 1 },
        COERCED: { description: "A coerced number.", schema: z.coerce.number(), default: 1 },
      });
      for (const text of [" 15", "15 ", "1e3", "0x10", "1.", ".5", ""]) {
        const fallbacks: VarFallback[] = [];
        NUMBER.read({ [name]: text }, { onFallback: (fallback) => fallbacks.push(fallback) });
        expect(
          fallbacks.find((fallback) => fallback.name === name),
          JSON.stringify(text),
        ).toEqual({
          name,
          raw: text,
          reason: "invalid",
          problem: expect.stringMatching(/plain decimal/),
          issues: [{ code: "custom", message: expect.stringMatching(/plain decimal/), path: [], input: text }],
        });
      }
    },
  );

  it("gives the plain-decimal rule for a number written another way that the schema would also refuse as a number", () => {
    const AT_LEAST = defineVars({ N: { description: "How many.", schema: z.number().min(5), default: 5 } });
    expect(parseVar(AT_LEAST.vars.N, "0x2")).toEqual({ ok: false, problem: expect.stringMatching(/plain decimal/) });
    expect(parseVar(AT_LEAST.vars.N, "1e0")).toEqual({ ok: false, problem: expect.stringMatching(/plain decimal/) });
  });

  it("keeps the schema's own issue for text that is no number at all, or under a schema that takes no number", () => {
    const OTHER = defineVars({
      N: { description: "How many.", schema: z.number(), default: 5 },
      ON: { description: "A switch.", schema: z.boolean(), default: false },
    });
    for (const text of ["soon", "Infinity", "1_000"]) {
      expect(parseVar(OTHER.vars.N, text), text).toEqual({
        ok: false,
        problem: expect.stringMatching(/expected number/),
      });
    }
    expect(parseVar(OTHER.vars.ON, "0x10")).toEqual({ ok: false, problem: expect.stringMatching(/expected boolean/) });
    expect(parseVar(OTHER.vars.ON, "1e3")).toEqual({ ok: false, problem: expect.stringMatching(/expected boolean/) });
  });

  it("gives the schema's issue for text that decodes to a value the schema refuses", () => {
    const COUNTS = defineVars({
      N: { description: "How many.", schema: z.number().int().min(5), default: 5 },
      FLAGS: { description: "Which flags.", schema: z.object({ beta: z.boolean() }), default: { beta: false } },
    });
    const fallbacks: VarFallback[] = [];
    COUNTS.read({ N: "3", FLAGS: '{"beta":1}' }, { onFallback: (fallback) => fallbacks.push(fallback) });
    expect(fallbacks).toEqual([
      expect.objectContaining({
        name: "N",
        reason: "invalid",
        problem: expect.stringMatching(/>=\s*5/),
        issues: [expect.objectContaining({ code: "too_small" })],
      }),
      expect.objectContaining({
        name: "FLAGS",
        reason: "invalid",
        issues: [expect.objectContaining({ code: "invalid_type", path: ["beta"] })],
      }),
    ]);
  });

  it("calls onFallback on every read of the same env, the values still read once", () => {
    const env = { READY_AFTER_MINUTES: "soon", MODE: "live" };
    const names: string[] = [];
    const first = VARS.read(env, { onFallback: ({ name }) => names.push(name) });
    const second = VARS.read(env, { onFallback: ({ name }) => names.push(name) });
    expect(second).toBe(first);
    expect(names).toEqual(["READY_AFTER_MINUTES", "READY_AFTER_MINUTES"]);
  });

  it("calls no onFallback when every var parses", () => {
    const names: string[] = [];
    VARS.read({ READY_AFTER_MINUTES: 20, MODE: "replay" }, { onFallback: ({ name }) => names.push(name) });
    expect(names).toEqual([]);
  });

  it("names each fallback by the declaration's own var names", () => {
    VARS.read(
      {},
      { onFallback: (fallback) => expectTypeOf(fallback.name).toEqualTypeOf<"READY_AFTER_MINUTES" | "MODE">() },
    );
  });
});

describe("parseVar", () => {
  it("names why a value is refused", () => {
    const result = parseVar(VARS.vars.MODE, "paused");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/live/);
  });

  it("says a missing value is missing", () => {
    expect(parseVar(VARS.vars.MODE, undefined)).toEqual({ ok: false, problem: "missing" });
  });

  const NUMBERS = defineVars({
    STRICT: { description: "A plain number.", schema: z.number(), default: 1 },
    COERCED: { description: "A coerced number.", schema: z.coerce.number(), default: 1 },
  });

  it.each(["STRICT", "COERCED"] as const)("parses a plain decimal written as text under a %s number schema", (name) => {
    const entry = NUMBERS.vars[name];
    expect(parseVar(entry, "15")).toEqual({ ok: true, value: 15 });
    expect(parseVar(entry, "-3")).toEqual({ ok: true, value: -3 });
    expect(parseVar(entry, "+3")).toEqual({ ok: true, value: 3 });
    expect(parseVar(entry, "1.5")).toEqual({ ok: true, value: 1.5 });
  });

  it.each(["STRICT", "COERCED"] as const)(
    "refuses padded, exponent, hex and empty text under a %s number schema",
    (name) => {
      for (const text of [" 15", "15 ", "1e1", "1E3", "0x10", "", "1.", ".5", "Infinity", "1_000"]) {
        expect(parseVar(NUMBERS.vars[name], text).ok, JSON.stringify(text)).toBe(false);
      }
      expect(parseVar(NUMBERS.vars[name], "1e1")).toEqual({
        ok: false,
        problem: expect.stringMatching(/plain decimal/),
      });
      expect(parseVar(NUMBERS.vars[name], " 15")).toEqual({
        ok: false,
        problem: expect.stringMatching(/plain decimal/),
      });
    },
  );

  it("parses a number wrangler.jsonc stores as a JSON number, exponent and all", () => {
    expect(parseVar(NUMBERS.vars.STRICT, 15)).toEqual({ ok: true, value: 15 });
    expect(parseVar(NUMBERS.vars.STRICT, 1e3)).toEqual({ ok: true, value: 1000 });
  });

  it("decodes object, array and boolean vars from their JSON text", () => {
    const json = defineVars({
      OBJECT: { description: "An object.", schema: z.object({ beta: z.boolean() }), default: { beta: false } },
      LIST: { description: "A list.", schema: z.array(z.number()), default: [] },
      ON: { description: "A switch.", schema: z.boolean(), default: false },
    });
    expect(parseVar(json.vars.OBJECT, '{"beta":true}')).toEqual({ ok: true, value: { beta: true } });
    expect(parseVar(json.vars.LIST, "[1e1, 2]")).toEqual({ ok: true, value: [10, 2] });
    expect(parseVar(json.vars.ON, "true")).toEqual({ ok: true, value: true });
  });

  it("leaves text a string schema takes as it is", () => {
    const text = defineVars({ LABEL: { description: "A label.", schema: z.string(), default: "x" } });
    expect(parseVar(text.vars.LABEL, "1e1")).toEqual({ ok: true, value: "1e1" });
  });

  it("takes the text a string schema transforms into a number", () => {
    const toMs = (text: string) => Number.parseInt(text, 10) * 60_000;
    const durations = defineVars({
      TIMEOUT: {
        description: "How long a request waits.",
        schema: z
          .string()
          .regex(/^\d+m$/)
          .transform(toMs),
        default: "5m",
        environments: { prod: "10m" },
      },
    });
    expect(parseVar(durations.vars.TIMEOUT, "10m")).toEqual({ ok: true, value: 600_000 });
    expect(durations.read({ TIMEOUT: "2m" }).TIMEOUT).toBe(120_000);
    expect(durations.read({}).TIMEOUT).toBe(300_000);
  });

  it("holds a coerced number to the plain-decimal rule when a transform follows it", () => {
    const scaled = defineVars({
      SCALED: {
        description: "A small number, scaled.",
        schema: z.coerce
          .number()
          .max(10)
          .transform((n) => n * 100),
        default: 1,
      },
    });
    expect(parseVar(scaled.vars.SCALED, "5")).toEqual({ ok: true, value: 500 });
    expect(parseVar(scaled.vars.SCALED, " 5")).toEqual({ ok: false, problem: expect.stringMatching(/plain decimal/) });
  });

  it("decodes a boolean or object var whose schema transforms it into a number", () => {
    const transformed = defineVars({
      FLAG: { description: "A switch, as 0 or 1.", schema: z.boolean().transform((b) => (b ? 1 : 0)), default: false },
      RATE: {
        description: "Requests a minute.",
        schema: z.object({ perMin: z.number() }).transform((o) => o.perMin),
        default: { perMin: 60 },
      },
    });
    expect(parseVar(transformed.vars.FLAG, "true")).toEqual({ ok: true, value: 1 });
    expect(parseVar(transformed.vars.RATE, '{"perMin":120}')).toEqual({ ok: true, value: 120 });
    expect(transformed.read({ RATE: '{"perMin":120}' }).RATE).toBe(120);
  });

  it("holds a number schema to the plain-decimal rule when a transform makes something else of it", () => {
    const transformed = defineVars({
      LABEL: { description: "A number, as text.", schema: z.number().transform((n) => String(n)), default: 1 },
      EXPIRES_AT: { description: "When it expires.", schema: z.number().transform((ms) => new Date(ms)), default: 0 },
    });
    const refused = { ok: false, problem: expect.stringMatching(/plain decimal/) };
    expect(parseVar(transformed.vars.LABEL, "1e3")).toEqual(refused);
    expect(parseVar(transformed.vars.LABEL, " 15")).toEqual(refused);
    expect(parseVar(transformed.vars.LABEL, "15")).toEqual({ ok: true, value: "15" });
    expect(parseVar(transformed.vars.EXPIRES_AT, "1e12")).toEqual(refused);
    expect(transformed.read({ EXPIRES_AT: "1e12" }).EXPIRES_AT).toEqual(new Date(0));
  });

  it("holds a coerced number to the plain-decimal rule whatever a transform makes of it", () => {
    const coerced = defineVars({
      LABEL: { description: "A number, as text.", schema: z.coerce.number().transform((n) => String(n)), default: "1" },
      AT: { description: "When.", schema: z.coerce.number().transform((ms) => new Date(ms)), default: 0 },
    });
    const refused = { ok: false, problem: expect.stringMatching(/plain decimal/) };
    expect(parseVar(coerced.vars.LABEL, "1e3")).toEqual(refused);
    expect(parseVar(coerced.vars.LABEL, " 15")).toEqual(refused);
    expect(parseVar(coerced.vars.LABEL, "")).toEqual(refused);
    expect(parseVar(coerced.vars.LABEL, "15")).toEqual({ ok: true, value: "15" });
    expect(parseVar(coerced.vars.AT, "1e12")).toEqual(refused);
  });

  it("takes exponent text as text under a schema that reads it as a string", () => {
    const either = defineVars({
      CODE: { description: "A number or a code.", schema: z.union([z.number(), z.string()]), default: 0 },
    });
    expect(parseVar(either.vars.CODE, "1e3")).toEqual({ ok: true, value: "1e3" });
  });

  it("names the refinement a number decoded from text fails", () => {
    const bounded = defineVars({ N: { description: "How many.", schema: z.number().min(5), default: 5 } });
    expect(parseVar(bounded.vars.N, "3")).toEqual({ ok: false, problem: expect.stringMatching(/>=\s*5/) });
  });

  it("names a string schema's own refusal of text that would decode to another type", () => {
    const toMs = (text: string) => Number.parseInt(text, 10) * 60_000;
    const text = defineVars({
      DURATION: {
        description: "How long.",
        schema: z
          .string()
          .regex(/^\d+m$/)
          .transform(toMs),
        default: "5m",
      },
      LONG: { description: "At least five characters.", schema: z.string().min(5), default: "hello" },
      API_BASE: { description: "Where the API lives.", schema: z.url(), default: "https://api.example.com" },
    });
    const notTyped = (result: ReturnType<typeof parseVar>) => {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problem).not.toMatch(/expected string, received/);
    };
    notTyped(parseVar(text.vars.DURATION, "15"));
    notTyped(parseVar(text.vars.LONG, "3"));
    notTyped(parseVar(text.vars.LONG, "1e3"));
    notTyped(parseVar(text.vars.LONG, "true"));
    notTyped(parseVar(text.vars.API_BASE, "true"));
    notTyped(parseVar(text.vars.API_BASE, "123"));
    notTyped(parseVar(text.vars.API_BASE, "1e3"));
    expect(parseVar(text.vars.LONG, "3")).toEqual({ ok: false, problem: expect.stringMatching(/>=\s*5/) });
    const fallbacks: VarFallback[] = [];
    text.read(
      { DURATION: "15", LONG: "hello", API_BASE: "true" },
      { onFallback: (fallback) => fallbacks.push(fallback) },
    );
    expect(fallbacks).toEqual([
      expect.objectContaining({ name: "DURATION", issues: [expect.objectContaining({ code: "invalid_format" })] }),
      expect.objectContaining({ name: "API_BASE", issues: [expect.objectContaining({ code: "invalid_format" })] }),
    ]);
  });

  it("refuses a quoted number decoded from JSON text", () => {
    const coerced = defineVars({ N: { description: "A number.", schema: z.coerce.number(), default: 1 } });
    expect(parseVar(coerced.vars.N, '"15"').ok).toBe(false);
  });
});

describe("varValueFor", () => {
  it("is the environment's own value where it declares one, else the default", () => {
    expect(varValueFor(VARS.vars.READY_AFTER_MINUTES, "prod")).toBe(30);
    expect(varValueFor(VARS.vars.READY_AFTER_MINUTES, "staging")).toBe(15);
    expect(varValueFor(VARS.vars.READY_AFTER_MINUTES, "dev")).toBe(15);
  });

  it("takes no value off the prototype for an environment named like one of its keys", () => {
    expect(varValueFor(VARS.vars.READY_AFTER_MINUTES, "constructor")).toBe(15);
  });
});

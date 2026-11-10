// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { ValidationError } from "../error/pithyError";
import { defineVars, isWorkerVars, parseVar, varValueFor } from "./vars";

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

  it("treats an env that is not an object as one holding nothing", () => {
    expect(VARS.read(undefined)).toEqual({ READY_AFTER_MINUTES: 15, MODE: "live" });
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

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { z } from "zod";
import { ValidationError } from "../error/pithyError";

/**
 * A Worker's own vars: what each one is, what it may hold, and the value each environment gets.
 *
 * Declared once, in the Worker's `pithy.config.ts` (or on a capability, for a var it reads). `pithy worker sync`
 * writes each into the top-level `vars` and every `env.<name>.vars` of the Worker's `wrangler.jsonc`, `pithy doctor`
 * names a stanza that drops one, and {@link WorkerVarsDeclaration.read} hands the running Worker each value typed,
 * with the default in place of one that is missing or does not parse, and tells its `onFallback` which those were.
 *
 * No `cloudflare:` import and no Node builtin: the CLI imports a declaration to write and check it.
 */

/** One var: a sentence saying what it is, the schema its value parses under, and its values. */
export interface WorkerVar<S extends z.ZodType = z.ZodType> {
  /** What the var is, in one line. Required: the declaration documents the Worker's config. */
  readonly description: string;
  /** What its value must parse under. `z.output` is what the Worker reads. */
  readonly schema: S;
  /** The value every environment gets that does not declare its own. JSON, as wrangler stores it. */
  readonly default: z.input<S>;
  /** Values per environment, keyed `dev`, `staging`, `prod` or a declared one. `dev` is the top-level stanza. */
  readonly environments?: Readonly<Partial<Record<string, z.input<S>>>>;
}

/** The typed values {@link WorkerVarsDeclaration.read} returns. */
export type WorkerVarValues<V extends Record<string, WorkerVar>> = {
  [K in keyof V]: z.output<V[K]["schema"]>;
};

/**
 * A var {@link WorkerVarsDeclaration.read} gave its default: its name, the raw value `env` held (`undefined` where it
 * held none), and why. `problem` is what {@link parseVar} says; `issues` are the schema's own, or the plain-decimal
 * rule as one `custom` issue for text a number schema would read as a finite number only another way, and none for a
 * missing var.
 */
export interface VarFallback<Name extends string = string> {
  readonly name: Name;
  readonly raw: unknown;
  readonly reason: "missing" | "invalid";
  readonly problem: string;
  readonly issues: readonly z.core.$ZodIssue[];
}

/** How {@link WorkerVarsDeclaration.read} reports. */
export interface VarReadOptions<Name extends string = string> {
  /**
   * Called once per var that fell back, in declaration order, on every read: a read of an `env` already read reports
   * its fallbacks again. The values read are the same with it or without it.
   */
  readonly onFallback?: (fallback: VarFallback<Name>) => void;
}

/** What {@link defineVars} returns: the declaration, and the reader for it. */
export interface WorkerVarsDeclaration<V extends Record<string, WorkerVar> = Record<string, WorkerVar>> {
  /** Marks a value as built by {@link defineVars}, for the CLI that reads it off a loaded config. */
  readonly kind: "pithy.worker-vars";
  /** Each var, by name. */
  readonly vars: Readonly<V>;
  /** Every var parsed out of `env`, the default in place of one missing or invalid, each such var told to `onFallback`. */
  read(env: unknown, options?: VarReadOptions<keyof V & string>): WorkerVarValues<V>;
}

/**
 * What {@link parseVar} found. `problem` is `missing` for an absent value, the plain-decimal rule for text that reads
 * as a finite number only another way under a schema that takes a number, else the schema's own message.
 */
export type ParsedVar = { ok: true; value: unknown } | { ok: false; problem: string };

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The one way to write a number as text: an optional sign, digits, and an optional fraction. */
const PLAIN_DECIMAL = /^[+-]?\d+(\.\d+)?$/;

/** Why text that would read as some other number is refused. */
const NOT_PLAIN_DECIMAL =
  "a number written as text is a plain decimal, like 15, -3 or 1.5, with no padding or exponent";

/**
 * Parse one raw value under its declaration. A `.dev.vars` line carries every value as text while `wrangler.jsonc`
 * carries it typed, so a string the schema refuses is tried once more decoded: a plain decimal as that number, any
 * other text as JSON, which is how an object, array or boolean is written. Text that comes out a number only by
 * another route (` 15`, `1e3`, `0x10`, `.5`, an empty string), under `z.number()` or `z.coerce.number()` alike, is
 * refused with the plain-decimal rule whatever the schema transforms the number into, so a typo falls back to the default instead of reading as a different value. A schema
 * that takes the text itself and transforms it into a number, like `"5m"` into milliseconds, is its own rule, and its
 * result stands.
 */
export function parseVar(entry: WorkerVar, raw: unknown): ParsedVar {
  const parsed = parseVarIssues(entry, raw);
  return parsed.ok ? parsed : { ok: false, problem: parsed.problem };
}

/** {@link parseVar}, with the issues behind a refusal. */
function parseVarIssues(
  entry: WorkerVar,
  raw: unknown,
): { ok: true; value: unknown } | { ok: false; problem: string; issues: readonly z.core.$ZodIssue[] } {
  if (raw === undefined) return { ok: false, problem: "missing", issues: [] };
  const notPlainDecimal = () => ({
    ok: false as const,
    problem: NOT_PLAIN_DECIMAL,
    issues: [{ code: "custom" as const, message: NOT_PLAIN_DECIMAL, path: [], input: raw }],
  });
  const loose = typeof raw === "string" && !PLAIN_DECIMAL.test(raw);
  const direct = entry.schema.safeParse(raw);
  if (direct.success) {
    return loose && readsAsNumber(entry, direct.data, Number(raw))
      ? notPlainDecimal()
      : { ok: true, value: direct.data };
  }
  if (typeof raw === "string") {
    const decoded = loose ? decodeJson(raw) : Number(raw);
    const retried = isTextValue(decoded, loose) ? entry.schema.safeParse(decoded) : undefined;
    if (retried?.success) {
      return loose && typeof decoded === "number" ? notPlainDecimal() : { ok: true, value: retried.data };
    }
    if (loose && refusesTextFor("number", direct.error.issues) && Number.isFinite(Number(raw))) {
      return notPlainDecimal();
    }
    if (retried !== undefined && !(loose && typeof decoded === "number") && refusesText(direct.error.issues)) {
      return { ok: false, problem: retried.error.issues[0]?.message ?? "invalid", issues: retried.error.issues };
    }
  }
  return { ok: false, problem: direct.error.issues[0]?.message ?? "invalid", issues: direct.error.issues };
}

/**
 * Whether a schema refused text for being text: its only issue is a type mismatch on the value itself. Only then does
 * the decoded value's refusal say more; a schema that takes text keeps its own refusal of it.
 */
function refusesText(issues: readonly z.core.$ZodIssue[]): boolean {
  return issues.length === 1 && issues[0]?.code === "invalid_type" && issues[0].path.length === 0;
}

/** Whether a schema refused text for being text where it expects `expected`, as `z.number()` refuses `"0x10"`. */
function refusesTextFor(expected: string, issues: readonly z.core.$ZodIssue[]): boolean {
  return refusesText(issues) && issues[0]?.code === "invalid_type" && issues[0].expected === expected;
}

/**
 * Whether the schema read the text as the number `asNumber`: it gives the same value for that number as it gave for
 * the text. A coercing schema does, whatever it transforms the number into; a schema that also takes strings, like
 * `z.union([z.number(), z.string()])`, keeps the text and does not.
 */
function readsAsNumber(entry: WorkerVar, fromText: unknown, asNumber: number): boolean {
  const fromNumber = entry.schema.safeParse(asNumber);
  return fromNumber.success && sameValue(fromText, fromNumber.data);
}

/** Two parse results compared by value: a `Date` or an object by its JSON form, anything else by identity. */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Whether `decoded` is a value text may stand for: the number a plain decimal is, or decoded JSON that is a number
 * (judged by the plain-decimal rule), an object, an array, a boolean or null. A JSON string is not: text is already one.
 */
function isTextValue(decoded: unknown, loose: boolean): boolean {
  return decoded !== undefined && !(loose && typeof decoded === "string");
}

/** `text` decoded as JSON, or `undefined` where it is not JSON. */
function decodeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The value a stanza for `environment` gets: its own where declared, else the default. */
export function varValueFor(entry: WorkerVar, environment: string): unknown {
  const environments = entry.environments ?? {};
  const own = Object.hasOwn(environments, environment) ? environments[environment] : undefined;
  return own === undefined ? entry.default : own;
}

/** Whether `value` is a declaration {@link defineVars} built. */
export function isWorkerVars(value: unknown): value is WorkerVarsDeclaration {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "pithy.worker-vars";
}

function refuse(name: string, problem: string): never {
  throw new ValidationError({
    message: `The var ${name} is not a valid declaration: ${problem}`,
    action: "Fix it in defineVars. Each var takes a one-line description, a schema, and a default the schema takes.",
  });
}

/** One var's value checked against its own schema and against what wrangler can store. */
function checkValue(name: string, entry: WorkerVar, value: unknown, where: string): void {
  if (JSON.stringify(value) === undefined) refuse(name, `${where} is not a JSON value.`);
  const parsed = parseVar(entry, value);
  if (!parsed.ok) refuse(name, `${where} does not parse: ${parsed.problem}.`);
}

/**
 * Declare a Worker's vars. The type takes each default and environment value against that var's schema and refuses
 * a var with no description; the same checks run here for a config the compiler never saw.
 */
export function defineVars<const V extends Record<string, z.ZodType>>(
  vars: {
    [K in keyof V]: WorkerVar<V[K]>;
  },
): WorkerVarsDeclaration<{ [K in keyof V]: WorkerVar<V[K]> }> {
  const entries = vars as Record<string, WorkerVar>;
  const defaults: Record<string, unknown> = Object.create(null);
  for (const [name, entry] of Object.entries(entries)) {
    if (!VAR_NAME.test(name)) refuse(name, "a var name is letters, digits and underscores.");
    if (name in Object.prototype) refuse(name, "every object already has a key by that name. Choose another.");
    const description = (entry as { description?: unknown }).description;
    if (typeof description !== "string" || description.trim() === "" || /[\r\n]/.test(description)) {
      refuse(name, "it needs a one-line description.");
    }
    checkValue(name, entry, entry.default, "its default");
    for (const [environment, value] of Object.entries(entry.environments ?? {})) {
      checkValue(name, entry, value, `its ${environment} value`);
    }
    defaults[name] = (parseVar(entry, entry.default) as { ok: true; value: unknown }).value;
  }

  type Read = { values: WorkerVarValues<{ [K in keyof V]: WorkerVar<V[K]> }>; fallbacks: VarFallback[] };
  const cache = new WeakMap<object, Read>();
  return {
    kind: "pithy.worker-vars",
    vars: vars as { [K in keyof V]: WorkerVar<V[K]> },
    read(env, options) {
      const subject = typeof env === "object" && env !== null ? (env as Record<string, unknown>) : {};
      let known = cache.get(subject);
      if (known === undefined) {
        const values: Record<string, unknown> = {};
        const fallbacks: VarFallback[] = [];
        for (const [name, entry] of Object.entries(entries)) {
          const raw = Object.hasOwn(subject, name) ? subject[name] : undefined;
          const parsed = parseVarIssues(entry, raw);
          if (parsed.ok) {
            values[name] = parsed.value;
            continue;
          }
          values[name] = defaults[name];
          const reason = raw === undefined ? "missing" : "invalid";
          fallbacks.push({ name, raw, reason, problem: parsed.problem, issues: parsed.issues });
        }
        known = { values: values as Read["values"], fallbacks };
        cache.set(subject, known);
      }
      const onFallback = options?.onFallback as ((fallback: VarFallback) => void) | undefined;
      if (onFallback !== undefined) for (const fallback of known.fallbacks) onFallback(fallback);
      return known.values;
    },
  };
}

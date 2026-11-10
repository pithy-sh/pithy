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
 * with the default in place of one that is missing or does not parse.
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

/** What {@link defineVars} returns: the declaration, and the reader for it. */
export interface WorkerVarsDeclaration<V extends Record<string, WorkerVar> = Record<string, WorkerVar>> {
  /** Marks a value as built by {@link defineVars}, for the CLI that reads it off a loaded config. */
  readonly kind: "pithy.worker-vars";
  /** Each var, by name. */
  readonly vars: Readonly<V>;
  /** Every var parsed out of `env`, the default in place of one missing or invalid. */
  read(env: unknown): WorkerVarValues<V>;
}

/** What {@link parseVar} found. `problem` is `missing` for an absent value, else the schema's own message. */
export type ParsedVar = { ok: true; value: unknown } | { ok: false; problem: string };

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse one raw value under its declaration. A string that does not parse is tried once more as JSON, because a
 * `.dev.vars` line carries every value as text while `wrangler.jsonc` carries it typed.
 */
export function parseVar(entry: WorkerVar, raw: unknown): ParsedVar {
  if (raw === undefined) return { ok: false, problem: "missing" };
  const direct = entry.schema.safeParse(raw);
  if (direct.success) return { ok: true, value: direct.data };
  if (typeof raw === "string") {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      decoded = undefined;
    }
    if (decoded !== undefined) {
      const retried = entry.schema.safeParse(decoded);
      if (retried.success) return { ok: true, value: retried.data };
    }
  }
  return { ok: false, problem: direct.error.issues[0]?.message ?? "invalid" };
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

  const cache = new WeakMap<object, WorkerVarValues<{ [K in keyof V]: WorkerVar<V[K]> }>>();
  return {
    kind: "pithy.worker-vars",
    vars: vars as { [K in keyof V]: WorkerVar<V[K]> },
    read(env) {
      const subject = typeof env === "object" && env !== null ? (env as Record<string, unknown>) : {};
      const known = cache.get(subject);
      if (known !== undefined) return known;
      const values: Record<string, unknown> = {};
      for (const [name, entry] of Object.entries(entries)) {
        const parsed = parseVar(entry, Object.hasOwn(subject, name) ? subject[name] : undefined);
        values[name] = parsed.ok ? parsed.value : defaults[name];
      }
      const typed = values as WorkerVarValues<{ [K in keyof V]: WorkerVar<V[K]> }>;
      cache.set(subject, typed);
      return typed;
    },
  };
}

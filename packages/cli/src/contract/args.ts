// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ArgsDef } from "citty";
import { z } from "zod";
import type { FlagFacts } from "./commandContract";

/**
 * **One command's arguments, as a caller needs them (#697).**
 *
 * The source is citty's `args` — every flag in the CLI is declared there and nowhere else — read with
 * citty's own rules rather than its raw fields, because the raw fields mislead in two places:
 *
 * - **A positional with no `required` is required.** citty refuses a missing positional unless it has a
 *   default or says `required: false`, so publishing the raw field would call `testers create <name>`
 *   optional.
 * - **A boolean with no default has three states.** `ui add --auth` is unset, `true` or `false`, and the
 *   command treats unset as "ask" or "decide". Publishing `default: false` would tell a caller that leaving
 *   it off means no.
 *
 * Every spelling citty answers to beyond the declared name is listed under that name, marked by how it
 * arises — so `dashboard connect --workerUrl` reads as `--worker-url`, not as an eighteenth flag.
 * {@link flagSpellings} is the one order those spellings come in, and `declaredFlags.ts` accepts exactly
 * the flat list it produces, so the flags `bin.ts` accepts, the docs catalog lists and `pithy schema`
 * publishes cannot disagree.
 */

/** How a spelling other than the declared name reaches the same flag. */
export const AliasKind = z
  .enum(["camelCase", "declared", "negation"])
  .describe(
    "How a spelling reaches its flag: `camelCase` is citty's automatic camel spelling of a kebab name, `declared` is an alias the command declares, `negation` is `--no-<name>`, which sets a boolean to false.",
  );
export type AliasKind = z.infer<typeof AliasKind>;

/** One extra spelling of a flag. */
export const FlagAlias = z
  .object({
    flag: z.string().describe("The spelling, as typed: `--workerUrl`, `-n`, `--no-json`."),
    kind: AliasKind,
  })
  .describe("A spelling that reaches the same flag as its canonical name.");
export type FlagAlias = z.infer<typeof FlagAlias>;

/** One flag, as `pithy schema` publishes it. */
export const DeclaredFlag = z
  .object({
    name: z.string().describe("The canonical spelling, as typed: `--worker-url`."),
    type: z.enum(["boolean", "string"]).describe("`boolean` takes no value; `string` takes one."),
    required: z.boolean().describe("Whether the command refuses to run without it."),
    default: z
      .union([z.string(), z.boolean()])
      .optional()
      .describe("The value it has when it is not passed. Absent when unset is its own state."),
    enum: z
      .array(z.string().describe("One value the flag takes."))
      .optional()
      .describe("Every value the flag takes, when the set is fixed."),
    repeatable: z.boolean().describe("Whether it may be passed more than once, every occurrence counting."),
    description: z.string().describe("What it does, as `--help` says it."),
    negativeDescription: z.string().optional().describe("What `--no-<name>` does, when the command says."),
    aliases: z
      .array(FlagAlias)
      .describe(
        "Every other spelling that reaches this flag: camel case first, then declared aliases, then the negation.",
      ),
  })
  .describe("One flag a command declares.");
export type DeclaredFlag = z.infer<typeof DeclaredFlag>;

/** One positional argument, as `pithy schema` publishes it. */
export const DeclaredPositional = z
  .object({
    name: z.string().describe("The argument's name, as `--help` prints it in capitals."),
    required: z.boolean().describe("Whether the command refuses to run without it."),
    variadic: z
      .boolean()
      .describe(
        "Whether it takes every remaining word rather than one: `pithy schema token mint` is one `command` of two words. Only a command's last positional can be.",
      ),
    default: z.string().optional().describe("The value it has when it is not passed."),
    enum: z
      .array(z.string().describe("One value it takes."))
      .optional()
      .describe("Every value it takes, when the set is fixed."),
    description: z.string().describe("What it is, as `--help` says it."),
  })
  .describe("One positional argument, in the order the command reads them.");
export type DeclaredPositional = z.infer<typeof DeclaredPositional>;

/** One citty arg, read loosely: the union citty declares has no common discriminant to narrow on. */
interface LooseArg {
  type?: string;
  description?: string;
  negativeDescription?: string;
  alias?: string | string[];
  default?: string | boolean | number;
  required?: boolean;
}

/** A declared alias list, whichever shape it was declared in. */
export function aliasNames(alias: unknown): string[] {
  if (typeof alias === "string") return [alias];
  if (Array.isArray(alias)) return alias.filter((name): name is string => typeof name === "string");
  return [];
}

/**
 * The camelCase spelling of a kebab-case arg name, or the name unchanged when it has no dash.
 *
 * citty registers `camelCase(name)` and `kebabCase(name)` as aliases of **every** arg it parses, so
 * `--withPrerequisites` reaches the same value as `--with-prerequisites`. This transform is narrow on
 * purpose — it handles lowercase kebab and nothing else — and `docs/catalog.test.ts` holds every arg name
 * in the CLI to that shape, so the narrow version is complete rather than merely convenient. The kebab
 * direction is a no-op over that domain, which is why only this one exists.
 */
export function camelSpelling(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase());
}

/** A declared alias in the spelling a caller types: a single letter takes one dash, a word takes two. */
function aliasFlag(name: string): string {
  return name.length === 1 ? `-${name}` : `--${name}`;
}

/**
 * Every spelling beyond `--<name>` that citty answers for one flag, in one order: camel case, declared
 * aliases, then `--no-<name>` on a boolean.
 *
 * Booleans only for the negation: citty would also answer `--no-env`, but that is a quirk of its parser,
 * not a flag anybody declared, so it is refused (`declaredFlags.ts`).
 */
export function flagAliases(name: string, def: unknown): FlagAlias[] {
  const arg = def as LooseArg;
  const aliases: FlagAlias[] = [];
  const camel = camelSpelling(name);
  if (camel !== name) aliases.push({ flag: `--${camel}`, kind: "camelCase" });
  for (const alias of aliasNames(arg.alias)) aliases.push({ flag: aliasFlag(alias), kind: "declared" });
  if (arg.type === "boolean") aliases.push({ flag: `--no-${name}`, kind: "negation" });
  return aliases;
}

/** Whether one declared arg is a positional rather than a flag. */
export function isPositional(def: unknown): boolean {
  return (def as LooseArg).type === "positional";
}

/** The positionals and flags of one command, read with citty's rules and overlaid with its contract's facts. */
export function describeArgs(
  args: ArgsDef | undefined,
  facts: Readonly<Record<string, FlagFacts>> = {},
): { positionals: DeclaredPositional[]; flags: DeclaredFlag[] } {
  const positionals: DeclaredPositional[] = [];
  const flags: DeclaredFlag[] = [];
  for (const [name, def] of Object.entries(args ?? {})) {
    const arg = def as LooseArg;
    const description = arg.description ?? "";
    const fact = facts[name] ?? {};
    if (arg.type === "positional") {
      positionals.push({
        name,
        // citty's rule (`parseArgs`): missing is refused unless there is a default or `required: false`.
        required: arg.default === undefined && arg.required !== false,
        variadic: fact.variadic === true,
        ...(arg.default === undefined ? {} : { default: String(arg.default) }),
        ...(fact.enum === undefined ? {} : { enum: [...fact.enum] }),
        description,
      });
      continue;
    }
    flags.push({
      name: `--${name}`,
      type: arg.type === "boolean" ? "boolean" : "string",
      required: arg.required === true,
      ...(arg.default === undefined
        ? {}
        : { default: typeof arg.default === "boolean" ? arg.default : String(arg.default) }),
      ...(fact.enum === undefined ? {} : { enum: [...fact.enum] }),
      repeatable: fact.repeatable === true,
      description,
      ...(arg.negativeDescription === undefined ? {} : { negativeDescription: arg.negativeDescription }),
      aliases: flagAliases(name, def),
    });
  }
  return { positionals, flags };
}

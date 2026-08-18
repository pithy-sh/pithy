// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { InternalError } from "../error/pithyError";
import type { Logger } from "../logger/logger";
import { createWorkerLogger } from "../logger/worker";

/**
 * What a capability host worker reads out of its env, and what fills each of it.
 *
 * A host is a Worker nobody authored: `pithy <capability> provision` resolves a committed template
 * (see {@link ./host.ts}) and deploys it. Everything it needs therefore arrives as a binding, a var,
 * a Secrets Store entry or a serialized config blob — and until this module, **none of it was
 * validated anywhere.** `@pithy-sh/email`'s host read fourteen fields raw: a missing `BASE_URL`
 * became a magic link to `undefined/…`, an unparseable `EMAIL_THEME` threw inside a render step
 * three retries deep, and a `SCHEDULER_BATCH_SIZE` somebody typed as `"fifty"` became `NaN`, so the
 * scheduler claimed nothing, quietly, forever. Every one of those is discovered as a mail that did
 * not arrive.
 *
 * So a host declares its env once, as a Zod object with a `.describe()` per field, and pairs each
 * field with the thing that provides it. Two consumers read that one declaration:
 *
 * - the host itself, at boot, through {@link requireHostEnv} — one legible block naming every
 *   unusable value and what fills it, then a refusal. A host that cannot work does not wait to be
 *   asked.
 * - `pithy doctor`, statically, through {@link hostEnvFields} and {@link checkHostEnv} — the same
 *   schema, so the check an operator runs and the check the host runs cannot disagree.
 *
 * ## Kept importable from the CLI
 *
 * No `cloudflare:` import, no Node builtin, no filesystem — the same constraint {@link ./host.ts}
 * carries, and for the same reason: `pithy doctor` runs under node and imports this to read a
 * capability's declaration without executing its Worker.
 */

/** The kinds of thing that can fill a host env field. One of these names is what an operator acts on. */
export const HostEnvProviderKind = z
  .enum(["binding", "var", "secret", "config"])
  .describe(
    "Where a host env field comes from: a Worker `binding`, a wrangler `var`, a `secret` read through @pithy-sh/secrets, or a `config` key in the adopter's pithy.config.ts.",
  );
export type HostEnvProviderKind = z.infer<typeof HostEnvProviderKind>;

/**
 * What provides one field. The whole point of the declaration: a report that says `BASE_URL is
 * missing` sends a developer looking, and a report that says `Var BASE_URL in the host's
 * wrangler.jsonc. Run pithy email provision --env dev.` ends the search.
 */
export const HostEnvProvider = z
  .object({
    kind: HostEnvProviderKind.describe("Which kind of thing fills this field."),
    name: z
      .string()
      .min(1)
      .describe("The binding name, var name, secret name, or config key — spelled exactly as it is authored."),
    command: z
      .string()
      .min(1)
      .optional()
      .describe("The `pithy` command that fills it, where one does. Rendered as the report's action line."),
  })
  .describe("What fills one field of a host worker's env, so a failure names the thing an operator changes.");
export type HostEnvProvider = z.infer<typeof HostEnvProvider>;

/**
 * A host's env declaration: the capability that owns it, the schema, and a provider per field.
 *
 * **This type is the contract `pithy doctor` reads** (pithy-sh/pithy#411). A capability exports one
 * of these as an ordinary value, so the CLI can import it, walk the schema, and validate a resolved
 * configuration against the very object the deployed Worker validates itself against.
 */
export interface HostEnvDeclaration<Env extends z.ZodObject = z.ZodObject> {
  /** The capability that owns the host — the `<capability>` segment of its worker name. */
  readonly capability: string;
  /** The env schema. `z.output` is what the host runs on; coercions and JSON parses belong in here. */
  readonly env: Env;
  /** Field name → what fills it. Every field of {@link env} has an entry; nothing else may. */
  readonly provided: Readonly<Record<string, HostEnvProvider>>;
}

/**
 * Declare a host's env. The mapped `provided` type makes an unaccounted field a compile error; the
 * runtime check below makes it an error for a declaration the CLI reads back off a package it never
 * compiled, which is the case `pithy doctor` is entirely made of.
 */
export function defineHostEnv<Env extends z.ZodObject>(declaration: {
  capability: string;
  env: Env;
  provided: { readonly [Field in keyof Env["shape"] & string]: HostEnvProvider };
}): HostEnvDeclaration<Env> {
  const fields = Object.keys(declaration.env.shape);
  const unaccounted = fields.filter((field) => !(field in declaration.provided));
  if (unaccounted.length > 0) {
    throw new InternalError({
      message: `The ${declaration.capability} host env declares fields nothing provides.`,
      action: "Add a provider for each field: the binding, var, secret, or config key that fills it.",
      detail: `Unaccounted fields: ${unaccounted.join(", ")}.`,
    });
  }
  return declaration;
}

/** One field of a host env that is missing or unparseable, with what would fix it. */
export interface HostEnvProblem {
  /** The field name, as declared. */
  field: string;
  /** Why it is unusable — the Zod issue's own message, unedited. */
  reason: string;
  /** What provides it. */
  provider: HostEnvProvider;
}

/** The outcome of checking one env against one declaration. `value` is present exactly when `ok`. */
export interface HostEnvReport<Value> {
  /** Whether every declared field parsed. */
  ok: boolean;
  /** The parsed env — the shape the host runs on — or `undefined` when anything failed. */
  value: Value | undefined;
  /** Every unusable field, one entry each, in declaration order. */
  problems: HostEnvProblem[];
}

/** The provider reported for a field the declaration never accounted for. Should be unreachable. */
function undeclaredProvider(field: string): HostEnvProvider {
  return { kind: "var", name: field };
}

/**
 * Check an env against a declaration. Pure: it parses, it reports, and it neither logs nor throws —
 * which is what lets `pithy doctor` run the host's own check without a Worker.
 *
 * One problem per field, even where Zod raises several issues for it: an operator fixes a field, not
 * an issue, and three lines about `EMAIL_THEME` push the field they have not read yet off the block.
 */
export function checkHostEnv<Env extends z.ZodObject>(
  declaration: HostEnvDeclaration<Env>,
  env: unknown,
): HostEnvReport<z.output<Env>> {
  // An env that is not an object at all — `undefined` in a runtime that never bound one — still has to
  // report per field rather than as one "expected object": the operator's next move is the same either
  // way, and it is named in the fields.
  const subject = typeof env === "object" && env !== null ? env : {};
  const parsed = declaration.env.safeParse(subject);
  if (parsed.success) return { ok: true, value: parsed.data, problems: [] };

  const reasons = new Map<string, string>();
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (typeof field !== "string" || reasons.has(field)) continue;
    reasons.set(field, issue.message);
  }

  const problems: HostEnvProblem[] = [];
  for (const field of Object.keys(declaration.env.shape)) {
    const reason = reasons.get(field);
    if (reason === undefined) continue;
    problems.push({ field, reason, provider: declaration.provided[field] ?? undeclaredProvider(field) });
  }
  return { ok: false, value: undefined, problems };
}

/** One sentence naming the thing an operator changes, plus the command that writes it where there is one. */
export function hostEnvProviderSentence(provider: HostEnvProvider): string {
  const where =
    provider.kind === "binding"
      ? `Binding ${provider.name} in the host's wrangler.jsonc.`
      : provider.kind === "var"
        ? `Var ${provider.name} in the host's wrangler.jsonc.`
        : provider.kind === "secret"
          ? `Secret ${provider.name}, read through @pithy-sh/secrets.`
          : `Config key ${provider.name}.`;
  return provider.command ? `${where} Run ${provider.command}.` : where;
}

/**
 * The block a host logs before it refuses. One headline, then one line per field: the field, why it
 * is unusable, and what fills it. Brand voice — short sentences, deliberate periods, no decoration
 * that a log aggregator would have to strip.
 */
export function renderHostEnvProblems(capability: string, problems: readonly HostEnvProblem[]): string {
  const lines = problems.map(
    (problem) => `  ${problem.field} — ${problem.reason} ${hostEnvProviderSentence(problem.provider)}`,
  );
  const count = problems.length === 1 ? "1 setting is" : `${problems.length} settings are`;
  return [`The ${capability} host cannot start. ${count} missing or unusable.`, ...lines].join("\n");
}

/**
 * Every env object this process has already reported on, so a boot path that asks twice logs once.
 *
 * A module-scope call in a Worker happens once per isolate and needs no help; a host that validates
 * inside `fetch` — or a `scheduled` handler firing every minute — would otherwise write the same
 * block into Workers Logs forever, which is how a legible block becomes noise nobody reads.
 */
const reported = new WeakSet<object>();

/**
 * Validate a host's env, or say exactly what is wrong and refuse.
 *
 * Called at boot, before the host serves anything. The block goes to the log (the operator's
 * audience, so it carries the provider lines) and the refusal is `core/internal`: a host that cannot
 * parse config *we* generated is our failure, and our logs are where the answer is (CLAUDE.md
 * §Errors). Nothing about the values themselves is logged — a provider name is a location, never a
 * secret.
 */
export function requireHostEnv<Env extends z.ZodObject>(
  declaration: HostEnvDeclaration<Env>,
  env: unknown,
  log: Logger = createWorkerLogger(),
): z.output<Env> {
  const report = checkHostEnv(declaration, env);
  if (report.ok && report.value !== undefined) return report.value;

  const block = renderHostEnvProblems(declaration.capability, report.problems);
  if (typeof env !== "object" || env === null || !reported.has(env)) {
    if (typeof env === "object" && env !== null) reported.add(env);
    log.error(block, {
      capability: declaration.capability,
      fields: report.problems.map((problem) => problem.field),
    });
  }

  throw new InternalError({
    message: `The ${declaration.capability} host is not configured.`,
    action: "Read the startup log: it names every unusable setting and what fills it.",
    detail: block,
  });
}

/** One declared field, flattened for a reader that never runs the host — `pithy doctor`'s row. */
export interface HostEnvField {
  /** The field name, as the env carries it. */
  field: string;
  /** The field's own `.describe()`, or `undefined` where the schema carries none. */
  description: string | undefined;
  /** What provides it. */
  provider: HostEnvProvider;
  /** Whether the host works without it — i.e. whether the field's schema accepts `undefined`. */
  optional: boolean;
}

/**
 * Read a declaration statically: what the host needs, what documents each field, and what fills it.
 *
 * The static half of this module, and the one `pithy doctor` builds its report from (#411). Field
 * order is the schema's, so a report reads in the order the capability chose to explain itself.
 */
export function hostEnvFields(declaration: HostEnvDeclaration): HostEnvField[] {
  return Object.entries(declaration.env.shape).map(([field, schema]) => ({
    field,
    description: (schema as z.ZodType).description,
    provider: declaration.provided[field] ?? undeclaredProvider(field),
    // Asked of the schema rather than read off its wrapper chain: `.optional()`, `.default()` and a
    // union with `undefined` all mean the same thing to an operator, and only the parse knows.
    optional: (schema as z.ZodType).safeParse(undefined).success,
  }));
}

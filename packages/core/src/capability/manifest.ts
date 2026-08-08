// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { ValidationError } from "../error/pithyError";
import { NAMESPACE_PATTERN } from "../migrations/registry";
import { BindingSpec } from "./bindings";
import { DevSecret } from "./devSecret";

/**
 * Whether a string prints as a double-quoted literal Biome leaves exactly as written.
 *
 * Two sequences are out, and only two. A `"` inside the value makes `JSON.stringify` escape it, and
 * Biome's formatter then reprints the whole literal in single quotes to avoid the escape —
 * `"he said \"hi\""` becomes `'he said "hi"'`, a formatting diff on a file the adopter never opened.
 * And `${` trips `lint/suspicious/noTemplateCurlyInString`, which is noise in the same place.
 *
 * An apostrophe stays legal: with no `"` to escape, Biome keeps the double quotes. So do a backslash, a
 * tab, a newline, and any non-ASCII character — every one of these checked by running Biome over the
 * rendered output, because the whole defect class this closes is guessing what Biome would print.
 */
function isPrintableString(value: string): boolean {
  return !value.includes('"') && !value.includes("${");
}

/** A number whose `String()` form is already the literal Biome prints: a plain decimal, no exponent. */
const PLAIN_DECIMAL = /^-?\d+(?:\.\d+)?$/;

/**
 * Whether a number prints as a numeric literal Biome leaves exactly as written.
 *
 * `String(1e21)` is `"1e+21"`, which Biome normalizes to `1e21`. Rather than carry a copy of its numeric
 * normalizer, a default is held to a plain decimal — which is every number a worked example has any
 * business carrying. `NaN` and `Infinity` fall out of the same rule, and JSON cannot state either.
 */
function isPrintableNumber(value: number): boolean {
  return PLAIN_DECIMAL.test(String(value));
}

/** A string a manifest may state, and an object key it may use: one {@link renderConfigValue} can print. */
const PrintableString = z.string().refine(isPrintableString, {
  error: 'A rendered value may not contain a double quote or "${" — Biome reprints the first and lints the second.',
});

/** A number a manifest may state: one whose `String()` form is the literal Biome prints. */
const PrintableNumber = z.number().refine(isPrintableNumber, {
  error: "A rendered number must be a plain decimal — Biome prints 1e21 where JavaScript prints 1e+21.",
});

/**
 * What a manifest states as an option's rendered value: a JSON value other than `null`, nested freely,
 * and printable as source without Biome wanting it back a different way.
 *
 * A scalar is what an option normally is, and every `--set` override still coerces to one — the CLI
 * takes strings from a flag or a prompt, and neither can carry an object.
 *
 * Objects and arrays are here for the options a scalar cannot express: one the capability's config type
 * **requires** and whose contents only the adopter can write. `SecretsConfig` requires a `registry`; a
 * manifest could not state one, so `pithy add secrets` rendered every option but that and left a
 * `pithy.config.ts` failing `tsc` with TS2741 on a project nobody had touched yet (#161).
 *
 * #161 admitted only the **empty** literal, which is right for a registry — an empty registry is a legal
 * registry. It is wrong everywhere the collection is required to be non-empty. `ledger.currencies`,
 * `leaderboard.boards` and `multiplayer.games` each carry `.min(1)` with a message saying why, so an
 * empty seed typechecks and then throws `too_small` on the first config load — and `pithy upgrade`
 * reports that as "Could not load pithy.config.ts", naming the wrong cause (#168). So a default may now
 * be a **complete, minimal, working example**: one currency, one board, one game. The option's
 * `describe`, rendered as the comment directly above it, is what tells the adopter to replace it.
 *
 * `null` stays out. `typeof null === "object"`, and the CLI reads exactly that to decide an option is
 * hand-written and therefore not settable from `--set` or a prompt; a null default would be mistaken for
 * a collection nobody can fill.
 *
 * The recursion is this widening's cost, paid in the open. Every shape admitted here has to come back
 * out as the TypeScript Biome prints — see {@link renderConfigValue}.
 *
 * **The schema is narrower than the type, deliberately.** TypeScript cannot say "a string with no double
 * quote in it", so the two characters {@link renderConfigValue} cannot print as Biome would are refused
 * here instead, at the one door a manifest comes through. The alternative was to teach the renderer
 * Biome's quote-preference heuristic and its numeric-literal normalizer, and then keep both in step with
 * a formatter that is free to change either — for inputs no worked example should carry. A manifest
 * default is an *example*; one that needs a quote inside a string is already too clever (#171).
 */
export type ConfigOptionValue = string | number | boolean | ConfigOptionValue[] | { [key: string]: ConfigOptionValue };

export const ConfigOptionValue: z.ZodType<ConfigOptionValue> = z
  .lazy(() =>
    z.union([
      PrintableString,
      PrintableNumber,
      z.boolean(),
      z.array(ConfigOptionValue),
      z.record(PrintableString, ConfigOptionValue),
    ]),
  )
  .describe("An option's rendered value: a JSON scalar, or a minimal worked example the adopter replaces.");

/** An object key that can be written bare in a TypeScript object literal. */
const BARE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Print one string as source, refusing the two sequences {@link isPrintableString} keeps out. */
function renderString(value: string): string {
  if (!isPrintableString(value)) {
    throw new ValidationError({
      message: 'A config value may not contain a double quote or "${".',
      action: "Pick a value carrying neither, or write the option by hand in pithy.config.ts.",
      detail: `Rendered as ${JSON.stringify(value)}, Biome would reprint or lint the line, so the generated pithy.config.ts would fail the scaffold's own biome check.`,
    });
  }
  return JSON.stringify(value);
}

/** Print one number as source, refusing anything {@link isPrintableNumber} keeps out. */
function renderNumber(value: number): string {
  if (!isPrintableNumber(value)) {
    throw new ValidationError({
      message: "A config number must be a plain decimal.",
      action: "Write it without an exponent.",
      detail: `${String(value)} is not the numeric literal Biome prints for it, so the generated pithy.config.ts would fail the scaffold's own biome check.`,
    });
  }
  return String(value);
}

/**
 * Render a manifest default as TypeScript source, on one line.
 *
 * `pithy add` writes this straight into the adopter's `pithy.config.ts`, which the scaffold's own
 * `biome check` then reads — so *valid* TypeScript is not the bar. It has to be the TypeScript Biome
 * would have printed. `JSON.stringify` is not: it quotes every key, and Biome's `quoteProperties`
 * default rewrites `{"code":"chips"}` to `{ code: "chips" }`, failing the lint gate on a project the
 * adopter has not touched. This prints Biome's shape directly — bare keys wherever they are legal,
 * spaces inside braces, `, ` between entries, `{}` and `[]` for the empty literals #161 relies on.
 *
 * **Total over what {@link ConfigOptionValue} *parses*, which is narrower than what it types.** The two
 * shapes the schema refuses — a string carrying `"` or `${`, a number no plain decimal spells — are
 * refused here too, with a `ValidationError`. A manifest cannot reach that path, since every manifest is
 * parsed before it is rendered; `pithy add --set` can, because a flag's string goes straight through. A
 * refusal at the command beats a config file that fails the adopter's first `bun run lint`.
 *
 * One line, always. Biome breaks any literal past {@link CONFIG_LINE_WIDTH}, and a broken literal is a
 * `biome check` failure on a project the adopter has not touched — #161 and #168 both. That rule used to
 * be this sentence and nothing else, with multiplayer's seed sitting at 98 columns of 120; it is now a
 * test over every shipped manifest default, rendered by {@link renderConfigOptionLine} at the indent the
 * writers really use (#171).
 */
export function renderConfigValue(value: ConfigOptionValue): string {
  if (typeof value === "string") return renderString(value);
  if (typeof value === "number") return renderNumber(value);
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(renderConfigValue).join(", ")}]`;
  const entries = Object.entries(value).map(
    ([key, nested]) => `${BARE_KEY.test(key) ? key : renderString(key)}: ${renderConfigValue(nested)}`,
  );
  return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
}

/**
 * The column Biome wraps at — `formatter.lineWidth` in the `biome.jsonc` that `pithy init` scaffolds.
 *
 * A line of exactly this width survives untouched; one character more and Biome explodes the literal
 * across a dozen lines, so `biome check` fails on a file the adopter never opened. Measured by running
 * Biome over generated lines of 118 through 122 columns, not read off a docs page.
 */
export const CONFIG_LINE_WIDTH = 120;

/**
 * The indent both writers render an option line at in a scaffolded project: the managed-region marker
 * sits four columns in, and an option sits two further.
 *
 * Each writer takes its real indent from the file it is editing, so an adopter who nested `capabilities`
 * deeper gets a longer line than this. This is the scaffold's indent, and the scaffold is what the width
 * rule is measured against — a default that does not fit here fits nowhere.
 */
export const CONFIG_OPTION_INDENT = "      ";

/**
 * The one line both writers put in `pithy.config.ts` for one option.
 *
 * `pithy add` renders a whole registration and `pithy upgrade` splices keys into an existing one, but the
 * line itself is this — so neither command can drift from the other by rendering a default its own way.
 * That drift was real and shipped: `upgrade` called `JSON.stringify` where `add` called
 * {@link renderConfigValue}, so one manifest produced `{"code":"chips"}` from one command and
 * `{ code: "chips" }` from the other, and only the second survived `biome check` (#171).
 *
 * The comment above the line is not measured against {@link CONFIG_LINE_WIDTH}: Biome never reflows a
 * comment, so an option's `describe` may run as long as it needs to.
 */
export function renderConfigOptionLine(key: string, value: ConfigOptionValue, indent: string): string {
  return `${indent}${key}: ${renderConfigValue(value)},`;
}

/**
 * One configurable option a capability exposes. `pithy add` renders each as
 * `cap({ key: default })` in `pithy.config.ts`, with `describe` as the comment
 * above it — the self-documenting config surface (docs/CLI.md §Config). The
 * mount-point model rides on options like this (e.g. `basePath`), so handlers
 * stay in the package and the user owns the wiring.
 *
 * **Every option the capability's config type requires belongs here.** The manifest is the only thing
 * `pithy add` reads, so an option it omits is an option the generated config omits — see
 * {@link ConfigOptionValue} for the one that got away.
 */
export const ConfigOption = z
  .object({
    key: z.string().min(1).describe('Option name passed to the capability factory (e.g. "basePath").'),
    default: ConfigOptionValue.describe("Default value rendered into pithy.config.ts when no override is given."),
    describe: z.string().min(1).describe("Rationale rendered as the comment above this option in pithy.config.ts."),
  })
  .describe("A configurable option a capability exposes (key, default, rationale).");
export type ConfigOption = z.infer<typeof ConfigOption>;

/**
 * Declarative, CLI-facing description of a capability. Lives at `pithy.manifest.json` in
 * each capability package; read by `pithy add`/`upgrade` to wire bindings into
 * `wrangler.jsonc` and scaffold config — without executing the package. Plain data, so
 * it's a validated Zod object. `requiredBindings` reuse the `BindingSpec` contract, so a
 * manifest's bindings are normalized (and rejected) exactly like a capability's own.
 */
export const CapabilityManifest = z
  .object({
    name: z.string().min(1).describe('Capability name, e.g. "auth".'),
    package: z.string().min(1).describe("npm package providing this capability."),
    requiredBindings: z
      .array(BindingSpec)
      .describe("Bindings the CLI must wire into wrangler.jsonc (normalized via BindingSpec)."),
    peerCapabilities: z
      .array(z.string())
      .default([])
      .describe("Capabilities that must also be present (e.g. auth ⇒ email)."),
    optionalCapabilities: z
      .array(z.string())
      .default([])
      .describe("Capabilities that, if present, get wired together (e.g. turnstile onto auth)."),
    migrationNamespace: z
      .string()
      .regex(NAMESPACE_PATTERN)
      .optional()
      .describe(
        "Namespace prefix for this capability's migrations — must match the registry's format (e.g. \"auth\").",
      ),
    devSecrets: z
      .array(DevSecret)
      .default([])
      .describe("Secrets from this capability's registry whose dev value `pithy add` mints into `.dev.vars`."),
    scaffold: z.array(z.string()).default([]).describe("Human-readable scaffold steps the CLI performs or explains."),
    configOptions: z
      .array(ConfigOption)
      .default([])
      .describe("Config options the capability exposes; `pithy add` renders each as `cap({ key: default })`."),
    whenToEnable: z
      .string()
      .optional()
      .describe("Self-documenting rationale the CLI surfaces when offering this capability."),
  })
  .describe("Declarative, CLI-facing description of a capability (pithy.manifest.json).");
export type CapabilityManifest = z.infer<typeof CapabilityManifest>;

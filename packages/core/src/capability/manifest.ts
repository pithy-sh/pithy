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

/**
 * An object key that can be written bare in a TypeScript object literal.
 *
 * ASCII only, which is narrower than JavaScript: `café` is a legal bare identifier and Biome keeps it,
 * checked by running Biome over it. It stays out because this is also the shape a *config option's* key
 * is held to, and an option name an English keyboard cannot type is not one a capability should ship.
 * Reserved words are in — `{ default: 1 }` and `{ class: 1 }` are both legal property names, checked the
 * same way — so nothing here needs a keyword list to keep in step with the language.
 */
const BARE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The characters that end a `//` comment. All four are line terminators to a JavaScript parser, so a
 * `describe` carrying one puts everything after it into `pithy.config.ts` as bare code — Biome's first
 * report on the generated file is a parse error, not a lint (#174). U+2028 and U+2029 are here because
 * they really do terminate the comment; that was measured with Biome, not assumed.
 */
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;

/**
 * Whether a string prints as a `//` comment Biome leaves exactly as written.
 *
 * Two things break it, and only two. A line terminator ends the comment, so the rest of the `describe`
 * lands as code. And trailing whitespace parses fine and then fails `biome format`, which is a diff on a
 * file the adopter never opened — the same failure mode #171 closed for values.
 *
 * Everything else stays legal, each one checked by running Biome over the rendered comment: leading
 * whitespace, an interior tab, a block-comment terminator, `${x}`, non-ASCII, and a line of any length.
 * A `//` comment ends at the line and nowhere else, and Biome never reflows one, so there is no width
 * rule here either.
 */
function isPrintableComment(value: string): boolean {
  return !LINE_TERMINATOR.test(value) && value === value.trimEnd();
}

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
/**
 * What a writer has decided to put on the right of an option line: a value, or one of the scaffold's
 * constants referenced by name.
 *
 * A marker object rather than a string, because a string would be indistinguishable from a value that
 * happens to spell an identifier — and the difference is quotes, which is the difference between an
 * origin that follows the environment and one written down. Constructed by the CLI from
 * `ConfigOption.constant` after it has checked the target config declares it; never parsed from a
 * manifest, which states only the key.
 */
export interface ConfigConstantRef {
  /** The constant to render, by key into {@link CONFIG_CONSTANTS}. */
  readonly constant: ConfigConstant;
}

/** Whether a rendered value is a reference to one of the scaffold's constants rather than a literal. */
function isConstantRef(value: ConfigOptionValue | ConfigConstantRef): value is ConfigConstantRef {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "constant" in value;
}

export function renderConfigOptionLine(
  key: string,
  value: ConfigOptionValue | ConfigConstantRef,
  indent: string,
): string {
  if (!BARE_KEY.test(key)) {
    throw new ValidationError({
      message: `A config option key must be a bare identifier, and "${key}" is not.`,
      action: "Rename the option, or write it by hand in pithy.config.ts.",
      detail: `Rendered as ${JSON.stringify(`${key}: …`)}, the generated pithy.config.ts would not parse as TypeScript — a key is written bare, so it cannot carry a hyphen, a space, a quote, or a leading digit.`,
    });
  }
  // A constant is rendered bare — that is its whole point, and the identifier comes from
  // {@link CONFIG_CONSTANTS} rather than from the manifest, so nothing a package states reaches the
  // adopter's TypeScript unquoted.
  const rendered = isConstantRef(value) ? CONFIG_CONSTANTS[value.constant] : renderConfigValue(value);
  return `${indent}${key}: ${rendered},`;
}

/**
 * The comment line both writers put above an option: its `describe`, verbatim, as a `//` comment.
 *
 * The rationale is the whole reason the generated config documents itself, and it comes out of a manifest
 * read from `node_modules` — third-party text reaching generated source. Both writers used to build this
 * line themselves, which is the arrangement that let `pithy add` and `pithy upgrade` disagree about the
 * line *below* it (#171); they now share this, so a rule stated here holds for both.
 *
 * Total over what {@link ConfigOption} parses, exactly as {@link renderConfigOptionLine} is: a manifest
 * cannot reach the throw, because every manifest is parsed before it is rendered.
 */
export function renderConfigOptionComment(describe: string, indent: string): string {
  if (!isPrintableComment(describe)) {
    throw new ValidationError({
      message: "A config option's rationale must be one line, with no trailing whitespace.",
      action: "Put it on one line, or write the option by hand in pithy.config.ts.",
      detail: `Rendered as ${JSON.stringify(`// ${describe}`)}, the generated pithy.config.ts would either not parse — a line break ends the comment and the rest becomes code — or fail biome format on the trailing whitespace.`,
    });
  }
  return `${indent}// ${describe}`;
}

/**
 * A capability's own name, as generated source carries it.
 *
 * The same shape a config option's key is held to, and for the same reason: it is written **bare**, and
 * twice — as the binding of the import statement (`import { auth } from …`) and as the registration call
 * (`auth(),`). Neither position quotes anything, so a name that is not an identifier is not a syntax
 * error in a string, it is a hole. `audit }) ; evil(` closed the capabilities array and opened a call
 * (#183).
 *
 * It is also the leaf of the fork directory `pithy add --eject` writes (`./capabilities/<name>`), so the
 * same rule keeps a name from carrying a path separator or a `..`.
 */
const CAPABILITY_NAME = BARE_KEY;

/**
 * The npm package name a capability ships under, as the import specifier carries it.
 *
 * Rendered inside a double-quoted specifier — `"@pithy-sh/auth/src/index"` — where the required shape is
 * an npm package name and not a bare identifier. The registry's own grammar is narrower than "no quote
 * in it", so that is what is stated: an optional `@scope/`, then a name starting alphanumeric and made of
 * letters, digits, `.`, `_` and `-`. Uppercase is admitted because npm still serves the legacy names that
 * carry it; everything npm forbids outright — a leading `.` or `_`, a space, a second `/`, a quote — is
 * out, and with it the escape `@pithy-sh/audit"; evil(); //` used to close the specifier and append a
 * statement (#183).
 *
 * 214 is npm's own length cap, checked separately so the refusal can say which rule was broken.
 */
const PACKAGE_NAME = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** npm's own limit on a package name, counted across the scope and the separator. */
const PACKAGE_NAME_MAX = 214;

/**
 * Whether a module specifier prints inside a double-quoted literal Biome leaves exactly as written.
 *
 * The same two sequences {@link isPrintableString} keeps out of a value, plus the line terminators that
 * would end the statement early. A specifier is not a manifest field — it is composed from one
 * ({@link CapabilityManifest.package}) or from the fork path — so it is checked here rather than at the
 * schema, and the check is what makes {@link renderCapabilityImport} total over both callers.
 */
function isPrintableSpecifier(value: string): boolean {
  return value.length > 0 && isPrintableString(value) && !LINE_TERMINATOR.test(value);
}

/** Refuse a capability name generated source cannot carry. Total over what {@link CapabilityManifest} parses. */
function requireCapabilityName(name: string): void {
  if (CAPABILITY_NAME.test(name)) return;
  throw new ValidationError({
    message: `A capability name must be a bare identifier, and ${JSON.stringify(name)} is not.`,
    action: "Rename the capability, or wire it by hand in pithy.config.ts.",
    detail: `It is written bare into the generated pithy.config.ts twice — as the import binding and as the registration call — so ${JSON.stringify(name)} would produce a file that does not parse as TypeScript.`,
  });
}

/**
 * The one import line a capability's wiring is written as.
 *
 * Both halves are interpolated raw, and both used to be `z.string().min(1)`: `pithy add` wrote
 * `import { audit }) ; evil( } from "@pithy-sh/audit/src/index";` from a manifest that parsed, and
 * reported `Done.` (#183). The line has one producer now, for the same reason
 * {@link renderConfigOptionLine} does — a rule stated at one call site is a rule the next call site does
 * not have.
 *
 * Total over what {@link CapabilityManifest} parses. A parsed manifest cannot reach either throw; the
 * fork path `pithy add --eject` composes can, which is why the specifier is checked rather than assumed.
 */
export function renderCapabilityImport(name: string, specifier: string): string {
  requireCapabilityName(name);
  if (!isPrintableSpecifier(specifier)) {
    throw new ValidationError({
      message: `A capability's import specifier may not be empty, span lines, or contain a double quote or "\${".`,
      action: "Correct the capability's package name, or write the import by hand in pithy.config.ts.",
      detail: `Rendered as ${JSON.stringify(`from "${specifier}"`)}, the generated pithy.config.ts would either not parse or fail the scaffold's own biome check.`,
    });
  }
  return `import { ${name} } from "${specifier}";`;
}

/** What {@link renderCapabilityRegistration} writes one registration from. */
export interface CapabilityRegistration {
  /** The capability's name — written bare as the call, so a bare identifier and nothing else. */
  name: string;
  /** The indent the call sits at, taken by each writer from the file it is editing. */
  indent: string;
  /**
   * The option lines already rendered by {@link renderConfigOptionComment} and
   * {@link renderConfigOptionLine}, in order. Empty renders the one-liner form.
   */
  optionLines?: readonly string[];
  /**
   * Whether the registration ends with the array's separating comma. `pithy add` writes a whole entry and
   * needs it; `pithy upgrade` splices a block over an existing `name()` whose comma is already in the file.
   */
  trailingComma?: boolean;
}

/**
 * The registration both writers put in `pithy.config.ts` for one capability — `auth(),` with no options,
 * the block form with them.
 *
 * The name is the only thing here that comes from a manifest, and it is the thing that reached generated
 * source unchecked (#183). One producer, so the rule holds for `pithy add`'s whole-entry write and for
 * `pithy upgrade`'s conversion of a one-liner into a block alike.
 */
export function renderCapabilityRegistration({
  name,
  indent,
  optionLines = [],
  trailingComma = true,
}: CapabilityRegistration): string {
  requireCapabilityName(name);
  const end = trailingComma ? "," : "";
  if (optionLines.length === 0) return `${indent}${name}()${end}`;
  return [`${indent}${name}({`, ...optionLines, `${indent}})${end}`].join("\n");
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
 *
 * **All three fields are narrowed to what the renderer can print, not just the value.** #171 held
 * `default` to shapes Biome prints unchanged and left `key` and `describe` as `z.string().min(1)`, so a
 * manifest could still state `content-type` — rendered `content-type: "x",`, which is not TypeScript at
 * all — or a `describe` with a newline in it, whose second line landed in `pithy.config.ts` as bare code.
 * A manifest is third-party data read from `node_modules`, and an option key is that data interpolated
 * into generated source; `}) ; evil(` is the shape that makes the point. Narrowing here is what lets
 * {@link renderConfigOptionLine} and {@link renderConfigOptionComment} guarantee the whole line rather
 * than its right-hand side (#174).
 */
/**
 * The constants a scaffolded `pithy.config.ts` defines, that a manifest option may name instead of
 * stating a literal — identifier by key, so the manifest carries a **name from a closed set** and never
 * an expression.
 *
 * That is the whole security argument, and it is the same one #183 settled for a capability's name: a
 * manifest is third-party data read out of `node_modules` and written into the adopter's TypeScript, so
 * anything it states unquoted must come from a list this package controls. An `expression` field would
 * put arbitrary code in the adopter's config on the strength of a package they installed.
 *
 * One entry today. `PUBLIC_ORIGIN` is the Worker's address for the environment it composes in, derived
 * by `originFor(compositionEnvironment(), DOMAINS)` in the scaffolded config — the line that exists so no
 * capability ever asks an adopter to write an origin down again.
 */
export const CONFIG_CONSTANTS = { publicOrigin: "PUBLIC_ORIGIN" } as const;

/** Which scaffolded constant an option's value is, by key. */
export const ConfigConstant = z
  .enum(Object.keys(CONFIG_CONSTANTS) as [keyof typeof CONFIG_CONSTANTS])
  .describe("A constant the scaffolded pithy.config.ts defines, named from a closed set rather than spelled out.");
export type ConfigConstant = z.infer<typeof ConfigConstant>;

export const ConfigOption = z
  .object({
    key: z
      .string()
      .regex(BARE_KEY, {
        error: (issue) =>
          `A config option key must be a bare identifier, and ${JSON.stringify(issue.input)} is not — it is written bare into pithy.config.ts.`,
      })
      .describe('Option name passed to the capability factory (e.g. "basePath"); a bare identifier.'),
    default: ConfigOptionValue.describe("Default value rendered into pithy.config.ts when no override is given."),
    constant: ConfigConstant.optional().describe(
      "A constant the scaffolded pithy.config.ts defines, rendered *unquoted* in place of `default` when the target config declares it. The one that exists is `publicOrigin` — `PUBLIC_ORIGIN`, this Worker's address for the environment it composes in. An option whose value is an origin must name it rather than state a URL, because a URL written down is production's URL written into staging: it is what mailed staging's testers magic links into production and unsubscribed them there (#256). `default` is still required and is what a config with no such constant gets, so an older project is never handed an identifier it does not define.",
    ),
    describe: z
      .string()
      .min(1)
      .refine(isPrintableComment, {
        error: (issue) =>
          `A config option's rationale must be one line with no trailing whitespace, and ${JSON.stringify(issue.input)} is not — it is written into pithy.config.ts as a // comment.`,
      })
      .describe("Rationale rendered as the comment above this option in pithy.config.ts; one line."),
  })
  .describe("A configurable option a capability exposes (key, default, rationale).");
export type ConfigOption = z.infer<typeof ConfigOption>;

/**
 * Declarative, CLI-facing description of a capability. Lives at `pithy.manifest.json` in
 * each capability package; read by `pithy add`/`upgrade` to wire bindings into
 * `wrangler.jsonc` and scaffold config — without executing the package. Plain data, so
 * it's a validated Zod object. `requiredBindings` reuse the `BindingSpec` contract, so a
 * manifest's bindings are normalized (and rejected) exactly like a capability's own.
 *
 * **The invariant, stated here rather than at the writers: every string a manifest states that reaches
 * generated source is constrained to what the renderer can print.** Three rounds got there one field at a
 * time — #171 narrowed an option's `default`, #174 its `key` and `describe`, #183 the capability's own
 * `name` and `package` — because each time the rule lived at the call site that had just been fixed. It
 * lives here now, and `manifest.test.ts` walks this schema and fails the build on a string field that is
 * neither constrained nor declared prose the CLI only ever prints.
 */
export const CapabilityManifest = z
  .object({
    name: z
      .string()
      .regex(CAPABILITY_NAME, {
        error: (issue) =>
          `A capability name must be a bare identifier, and ${JSON.stringify(issue.input)} is not — it is written bare into pithy.config.ts as both the import binding and the registration call.`,
      })
      .describe('Capability name, e.g. "auth"; a bare identifier.'),
    package: z
      .string()
      .max(PACKAGE_NAME_MAX)
      .regex(PACKAGE_NAME, {
        error: (issue) =>
          `A capability's package must be an npm package name, and ${JSON.stringify(issue.input)} is not — it is written into pithy.config.ts as the import specifier.`,
      })
      .describe('npm package providing this capability, e.g. "@pithy-sh/auth".'),
    requiredBindings: z
      .array(BindingSpec)
      .describe("Bindings the CLI must wire into wrangler.jsonc (normalized via BindingSpec)."),
    peerCapabilities: z
      .array(
        z.string().regex(CAPABILITY_NAME, {
          error: (issue) =>
            `A peer capability is named by its capability name, and ${JSON.stringify(issue.input)} is not a bare identifier.`,
        }),
      )
      .default([])
      .describe("Capabilities that must also be present (e.g. auth ⇒ email)."),
    optionalCapabilities: z
      .array(
        z.string().regex(CAPABILITY_NAME, {
          error: (issue) =>
            `An optional capability is named by its capability name, and ${JSON.stringify(issue.input)} is not a bare identifier.`,
        }),
      )
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

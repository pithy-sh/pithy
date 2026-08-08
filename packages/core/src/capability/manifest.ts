// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { NAMESPACE_PATTERN } from "../migrations/registry";
import { BindingSpec } from "./bindings";
import { DevSecret } from "./devSecret";

/**
 * What a manifest states as an option's rendered value: any JSON value except `null`, nested freely.
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
 * out as valid TypeScript — see {@link renderConfigValue}, which is total over this type and takes no
 * other input.
 */
export type ConfigOptionValue = string | number | boolean | ConfigOptionValue[] | { [key: string]: ConfigOptionValue };

export const ConfigOptionValue: z.ZodType<ConfigOptionValue> = z
  .lazy(() =>
    z.union([z.string(), z.number(), z.boolean(), z.array(ConfigOptionValue), z.record(z.string(), ConfigOptionValue)]),
  )
  .describe("An option's rendered value: a JSON scalar, or a minimal worked example the adopter replaces.");

/** An object key that can be written bare in a TypeScript object literal. */
const BARE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

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
 * One line, always. Biome only breaks a literal that exceeds its 120-column width, so a default has to
 * stay small enough to fit under the indent `add` renders it at. That is the same constraint the
 * contract already states: the seed is a worked example, not a configuration.
 */
export function renderConfigValue(value: ConfigOptionValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(renderConfigValue).join(", ")}]`;
  const entries = Object.entries(value).map(
    ([key, nested]) => `${BARE_KEY.test(key) ? key : JSON.stringify(key)}: ${renderConfigValue(nested)}`,
  );
  return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
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

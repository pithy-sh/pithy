// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { NAMESPACE_PATTERN } from "../migrations/registry";
import { BindingSpec } from "./bindings";
import { DevSecret } from "./devSecret";

/**
 * What a manifest states as an option's rendered value.
 *
 * A scalar is what an option normally is, and every `--set` override still coerces to one — the CLI
 * takes strings from a flag or a prompt, and neither can carry an object.
 *
 * The empty object and empty array are here for the case that had no expression at all: an option the
 * capability's config type **requires** and whose contents only the adopter can write. `SecretsConfig`
 * requires a `registry`; a manifest could not state one, so `pithy add secrets` rendered every option
 * but that and left a `pithy.config.ts` failing `tsc` with TS2741 on a project nobody had touched yet
 * (#161). The empty literal is what makes that config compile, and the option's `describe` — rendered
 * as the comment directly above it — is what tells the adopter what belongs inside.
 *
 * Contents are `unknown` because nothing here reads them: the value is `JSON.stringify`d straight into
 * the config file. A manifest that states a deeper default gets it rendered verbatim, on one line.
 */
export const ConfigOptionValue = z
  .union([z.string(), z.number(), z.boolean(), z.array(z.unknown()), z.record(z.string(), z.unknown())])
  .describe("An option's rendered value: a JSON scalar, or the empty literal an adopter fills in by hand.");
export type ConfigOptionValue = z.infer<typeof ConfigOptionValue>;

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

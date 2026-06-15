import { z } from "zod";
import { NAMESPACE_PATTERN } from "../migrations/registry";
import { BindingSpec } from "./bindings";

/**
 * One configurable option a capability exposes. `pithy add` renders each as
 * `cap({ key: default })` in `pithy.config.ts`, with `describe` as the comment
 * above it — the self-documenting config surface (docs/CLI.md §Config). The
 * `default` is a JSON scalar; the mount-point model rides on options like this
 * (e.g. `basePath`), so handlers stay in the package and the user owns the wiring.
 */
export const ConfigOption = z
  .object({
    key: z.string().min(1).describe('Option name passed to the capability factory (e.g. "basePath").'),
    default: z
      .union([z.string(), z.number(), z.boolean()])
      .describe("Default value rendered into pithy.config.ts when no override is given."),
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

import type { CapabilityManifest, ConfigOption } from "@pithy-sh/core/src/capability/manifest";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { type DatabaseRun, migrateProject } from "../migrations/run";
import { allCapabilities, loadProject } from "../project/config";
import { installPackage } from "../project/packageManager";
import { addCapability, type ConfigValue } from "./add";
import { loadManifest } from "./manifests";

/** Coerce a raw string (a `--set` value or a prompt answer) to its option's type. */
export function coerceConfigValue(option: ConfigOption, raw: string, capability: string): ConfigValue {
  if (typeof option.default === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new ValidationError({
      message: `${capability} option "${option.key}" is a boolean.`,
      action: "Pass true or false.",
    });
  }
  if (typeof option.default === "number") {
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      throw new ValidationError({
        message: `${capability} option "${option.key}" is a number.`,
        action: `Pass a number, not "${raw}".`,
      });
    }
    return value;
  }
  return raw;
}

/**
 * Parse `--set key=value` flags against a manifest's options, coercing each value
 * to its option's type. An unknown key fails with the valid keys — agents and
 * humans get the same correction.
 */
export function coerceSetFlags(manifest: CapabilityManifest, sets: string[]): Record<string, ConfigValue> {
  const byKey = new Map(manifest.configOptions.map((option) => [option.key, option]));
  const values: Record<string, ConfigValue> = {};
  for (const entry of sets) {
    const eq = entry.indexOf("=");
    if (eq === -1) {
      throw new ValidationError({
        message: `--set expects key=value, got "${entry}".`,
        action: "Pass --set key=value.",
      });
    }
    const key = entry.slice(0, eq);
    const option = byKey.get(key);
    if (!option) {
      const valid = [...byKey.keys()];
      throw new ValidationError({
        message: `${manifest.name} has no config option "${key}".`,
        action: valid.length ? `Valid keys: ${valid.join(", ")}.` : `${manifest.name} takes no options.`,
      });
    }
    values[key] = coerceConfigValue(option, entry.slice(eq + 1), manifest.name);
  }
  return values;
}

/**
 * Collect every `--set key=value` from the raw argv. citty (0.2.2) keeps only the
 * last occurrence of a repeated string flag, so a multi-option non-interactive run
 * would silently drop all but the last `--set` — we read the raw args instead.
 * Handles both `--set k=v` and `--set=k=v`.
 */
export function collectSetFlags(rawArgs: string[]): string[] {
  const sets: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--set") {
      const value = rawArgs[i + 1];
      if (value !== undefined) {
        sets.push(value);
        i++;
      }
    } else if (arg?.startsWith("--set=")) {
      sets.push(arg.slice("--set=".length));
    }
  }
  return sets;
}

/** Fill any option the caller didn't set — interactively, when a human is attached. */
export type ConfigPrompt = (
  manifest: CapabilityManifest,
  provided: Record<string, ConfigValue>,
) => Promise<Record<string, ConfigValue>>;

/** Install the package with the project's package manager. Injectable for tests. */
export type InstallStep = (input: { projectDir: string; pkg: string }) => Promise<{ packageManager: string }>;

/** Run the project's dev migrations. Injectable for tests. */
export type MigrateStep = (projectDir: string) => Promise<DatabaseRun[]>;

const defaultInstall: InstallStep = (input) => installPackage(input);

const defaultMigrate: MigrateStep = async (projectDir) => {
  const config = await loadProject(projectDir);
  return migrateProject({ capabilities: allCapabilities(config), projectDir, env: "dev" });
};

export interface RunAddOptions {
  /** The project root — where pithy.config.ts and wrangler.jsonc live. */
  projectDir: string;
  /** The capability name, e.g. `auth`. */
  capability: string;
  /** Raw `--set key=value` overrides; coerced against the manifest's options. */
  setFlags?: string[];
  /** Interactive fill for un-set options; omitted in non-interactive / `--json` runs. */
  prompt?: ConfigPrompt;
  /** Override the install step (tests inject a stub). */
  install?: InstallStep;
  /** Override the migrate step (tests inject a stub). */
  migrate?: MigrateStep;
}

export interface AddResult {
  capability: string;
  package: string;
  packageManager: string;
  databases: DatabaseRun[];
}

/**
 * The whole of `pithy add <capability>`: install the package, read its real
 * manifest, wire config + bindings, scaffold its config options, and run its dev
 * migrations. Handler logic stays in the package (principle 3) — only the thin
 * registration lands in the user's repo. Idempotent: a second run changes nothing.
 */
export async function runAdd(options: RunAddOptions): Promise<AddResult> {
  const { projectDir, capability } = options;
  const install = options.install ?? defaultInstall;
  const migrate = options.migrate ?? defaultMigrate;

  const { packageManager } = await install({ projectDir, pkg: `@pithy-sh/${capability}` });

  const manifest = await loadManifest(capability, projectDir);
  let configValues = coerceSetFlags(manifest, options.setFlags ?? []);
  if (options.prompt && manifest.configOptions.length > 0) {
    configValues = await options.prompt(manifest, configValues);
  }

  await addCapability({ projectDir, manifest, configValues });
  const databases = await migrate(projectDir);

  return { capability: manifest.name, package: manifest.package, packageManager, databases };
}

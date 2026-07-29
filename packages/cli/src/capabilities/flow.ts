import { basename } from "node:path";
import type { CapabilityManifest, ConfigOption } from "@pithy-sh/core/src/capability/manifest";
import { messageOf, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { CliAuditEmit } from "../audit/cliAudit";
import { type DatabaseRun, migrateProject } from "../migrations/run";
import { allCapabilities, loadWorkerConfig } from "../project/config";
import { installPackage } from "../project/packageManager";
import { addCapability, type ConfigValue } from "./add";
import { type EjectCapabilityOptions, type EjectResult, ejectCapability } from "./eject";
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

/** What the migrate step is told: the persistence root, and the one Worker just wired. */
export interface MigrateTarget {
  /** The project root — the owner of the `.wrangler/state` store every Worker's local D1 lives in. */
  projectDir: string;
  /** The target Worker's directory — its `wrangler.jsonc` supplies the D1 bindings. */
  workerDir: string;
  /** The target Worker's name. */
  worker: string;
}

/** Run the target Worker's dev migrations. Injectable for tests. */
export type MigrateStep = (target: MigrateTarget) => Promise<DatabaseRun[]>;

/** Eject a capability's source into the repo. Injectable for tests. */
export type EjectStep = (options: EjectCapabilityOptions) => Promise<EjectResult>;

const defaultInstall: InstallStep = (input) => installPackage(input);

/**
 * Migrate the Worker just wired, and only it: its own `pithy.config.ts` names the capabilities and its
 * own `wrangler.jsonc` the D1 bindings, while the local Miniflare store stays under the project root —
 * the one `wrangler dev` uses. The config is re-read here, after wiring, so the migration that just
 * arrived is in the registry.
 */
const defaultMigrate: MigrateStep = async ({ projectDir, workerDir, worker }) => {
  const config = await loadWorkerConfig(workerDir);
  const runs = await migrateProject({
    projectDir,
    env: "dev",
    workers: [{ name: worker, dir: workerDir, capabilities: allCapabilities(config) }],
  });
  return runs[0]?.databases ?? [];
};

export interface RunAddOptions {
  /** The project root — where the lockfile and `node_modules` live; the package installs here. */
  projectDir: string;
  /** The target Worker's directory (`apps/<name>`) — its `pithy.config.ts` and `wrangler.jsonc`. */
  workerDir: string;
  /** The target Worker's name, for the result and the audit trail. Defaults to `workerDir`'s basename. */
  worker?: string;
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
  /** Copy the capability's source into the repo and repoint the wiring at it (`--eject`). */
  eject?: boolean;
  /** With `eject`, overwrite an existing local copy (`--force`). */
  force?: boolean;
  /** Override the eject step (tests inject a stub). */
  ejectStep?: EjectStep;
  /** Audit emitter. Defaults to recording nothing, so a caller without audit wiring still works. */
  audit?: CliAuditEmit;
}

export interface AddResult {
  capability: string;
  /** The Worker it was wired into — the one whose config, bindings, and migrations moved. */
  worker: string;
  package: string;
  packageManager: string;
  databases: DatabaseRun[];
  /** Present when `--eject` ran: what was copied and which deps were promoted. */
  eject?: EjectResult;
}

/**
 * The whole of `pithy add <capability> [--worker <name>]`: install the package, read its real
 * manifest, wire **one Worker's** config + bindings, scaffold its config options, and run that
 * Worker's dev migrations. Handler logic stays in the package (principle 3) — only the thin
 * registration lands in the user's repo. Idempotent: a second run changes nothing.
 *
 * The package is a project dependency (one install at the root, shared by every Worker); the wiring is
 * per-Worker. Adding the same capability to a second Worker re-uses the installed package and writes
 * only that Worker's config and bindings.
 *
 * Audited on success and on failure as `capability/added` — routine (`info`) severity, since adding a
 * capability is reversible and never touches production data. The whole run is wrapped rather than
 * pinpointing which step failed: install, manifest load, wiring, eject, and migrate are a single
 * logical action from the audit trail's point of view.
 */
export async function runAdd(options: RunAddOptions): Promise<AddResult> {
  const { projectDir, workerDir, capability } = options;
  const worker = options.worker ?? basename(workerDir);
  const install = options.install ?? defaultInstall;
  const migrate = options.migrate ?? defaultMigrate;
  const audit = options.audit ?? (async () => {});

  try {
    const { packageManager } = await install({ projectDir, pkg: `@pithy-sh/${capability}` });

    const manifest = await loadManifest(capability, projectDir);
    let configValues = coerceSetFlags(manifest, options.setFlags ?? []);
    if (options.prompt && manifest.configOptions.length > 0) {
      configValues = await options.prompt(manifest, configValues);
    }

    await addCapability({ workerDir, manifest, configValues });

    // Eject before migrating: eject repoints the config import to the local copy and promotes the
    // capability's deps, so the migrate step loads the ejected config with everything it imports present.
    let eject: EjectResult | undefined;
    if (options.eject) {
      const runEject = options.ejectStep ?? ejectCapability;
      eject = await runEject({
        projectDir,
        workerDir,
        capability: manifest.name,
        package: manifest.package,
        force: options.force,
      });
    }

    const databases = await migrate({ projectDir, workerDir, worker });

    await audit({
      action: "capability/added",
      outcome: "success",
      severity: "info",
      resourceType: "capability",
      resourceId: manifest.name,
      metadata: { worker, package: manifest.package, packageManager, ejected: Boolean(eject) },
    });

    return { capability: manifest.name, worker, package: manifest.package, packageManager, databases, eject };
  } catch (error) {
    await audit({
      action: "capability/added",
      outcome: "failure",
      severity: "info",
      resourceType: "capability",
      resourceId: capability,
      metadata: { worker, error: messageOf(error) },
    });
    throw error;
  }
}

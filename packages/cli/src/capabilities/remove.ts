import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BindingSpec } from "@pithy-sh/core/src/capability/bindings";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ConflictError, InternalError } from "@pithy-sh/core/src/error/pithyError";
import { type DatabaseRun, dropCapabilityTables } from "../migrations/run";
import { uninstallPackage } from "../project/packageManager";
import { readWranglerConfig, writeWranglerConfig } from "../project/wrangler";
import { EJECT_DIR, ejectImportPath, isEjected } from "./eject";

/** The subset of a manifest/capability the binding helpers read — both shapes carry it. */
type HasBindings = { requiredBindings: readonly BindingSpec[] };

/** Escape a capability name for use inside a `RegExp` (names are simple, but be safe). */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove a capability's import and registration from `pithy.config.ts` — the inverse of `add`'s
 * managed-region wiring. Drops the import line (the package `@pithy-sh/<cap>/src/index` **or** the
 * ejected `./capabilities/<cap>`), then the `<cap>(),` registration — a one-liner, or the whole block
 * form (`<cap>({ … }),`) when the capability carries config options. Idempotent: a config that never
 * had the capability is returned unchanged. Matches only the exact factory call, never a shared-prefix
 * name (`authpro` is left alone when removing `auth`).
 *
 * A block registration whose closing `}),` line can't be found (a hand-edited or reformatted config)
 * **throws** rather than deleting to end-of-file — the function never returns a truncated config, so a
 * malformed input leaves `pithy.config.ts` untouched.
 */
export function unwireConfig(source: string, name: string, pkg: string): string {
  const lines = source.split("\n");

  const registered = new RegExp(`^${escapeRegExp(name)}\\(`);
  const startIndex = lines.findIndex((line) => registered.test(line.trimStart()));
  if (startIndex !== -1) {
    let endIndex = startIndex;
    // A block form opens with `<cap>({` and closes on a `}),` line; a one-liner is `<cap>(),`.
    if (lines[startIndex]?.trimEnd().endsWith("({")) {
      while (endIndex < lines.length && lines[endIndex]?.trim() !== "}),") endIndex += 1;
      if (endIndex >= lines.length) {
        throw new InternalError({
          message: `Couldn't find the end of the ${name}() registration in pithy.config.ts.`,
          action: `Remove the ${name} import and registration by hand.`,
        });
      }
    }
    lines.splice(startIndex, endIndex - startIndex + 1);
  }

  const importNeedles = new Set([
    `import { ${name} } from "${pkg}/src/index";`,
    `import { ${name} } from "${ejectImportPath(name)}";`,
  ]);
  return lines.filter((line) => !importNeedles.has(line.trim())).join("\n");
}

/**
 * The bindings that are safe to remove when this capability goes: the ones no other installed
 * capability still requires. A shared binding (e.g. the app `DB` used by auth, email, and audit) stays
 * — removing it would break the capabilities that remain. The mirror of `add` not duplicating a
 * shared binding.
 */
export function removableBindings(target: HasBindings, others: readonly HasBindings[]): BindingSpec[] {
  const kept = new Set(others.flatMap((other) => other.requiredBindings.map((b) => `${b.type}:${b.name}`)));
  return target.requiredBindings.filter((binding) => !kept.has(`${binding.type}:${binding.name}`));
}

/** A wrangler stanza's binding arrays — the keys `remove` touches (the mirror of `add`). */
interface WranglerBindings {
  d1_databases?: { binding: string }[];
  kv_namespaces?: { binding: string }[];
  durable_objects?: { bindings: { name: string; class_name: string }[] };
  migrations?: { tag: string; new_sqlite_classes?: string[] }[];
  env?: Record<string, WranglerBindings | undefined>;
}

/** Drop a set of bindings from one stanza in place (the per-environment keys). */
function stripBindings(stanza: WranglerBindings, bindings: BindingSpec[]): void {
  const d1 = new Set(bindings.filter((b) => b.type === "d1").map((b) => b.name));
  const kv = new Set(bindings.filter((b) => b.type === "kv").map((b) => b.name));
  const durableObjects = new Set(bindings.filter((b) => b.type === "durable_object").map((b) => b.name));
  if (stanza.d1_databases) stanza.d1_databases = stanza.d1_databases.filter((entry) => !d1.has(entry.binding));
  if (stanza.kv_namespaces) stanza.kv_namespaces = stanza.kv_namespaces.filter((entry) => !kv.has(entry.binding));
  if (stanza.durable_objects) {
    stanza.durable_objects.bindings = stanza.durable_objects.bindings.filter(
      (entry) => !durableObjects.has(entry.name),
    );
  }
}

/**
 * Strip removed Durable Object classes from the **top-level** `migrations` tags — the mirror of
 * `appendDurableObjectMigrations`, including the DO binding and its migration tag (the acceptance
 * criterion that remove is the clean inverse). A tag left with no classes is dropped, and an empty
 * `migrations` array is removed entirely, so a project with no DOs looks exactly as it did before add.
 */
function stripDurableObjectMigrations(config: WranglerBindings, bindings: BindingSpec[]): void {
  const classes = new Set(
    bindings.filter((b) => b.type === "durable_object" && b.className).map((b) => b.className as string),
  );
  if (classes.size === 0 || !config.migrations) return;

  for (const migration of config.migrations) {
    if (migration.new_sqlite_classes) {
      migration.new_sqlite_classes = migration.new_sqlite_classes.filter((className) => !classes.has(className));
    }
  }
  config.migrations = config.migrations.filter((migration) => (migration.new_sqlite_classes?.length ?? 0) > 0);
  if (config.migrations.length === 0) config.migrations = undefined;
}

/** Rewrite `pithy.config.ts` with the capability's import + registration removed. */
export async function removeFromConfig(projectDir: string, name: string, pkg: string): Promise<void> {
  const path = join(projectDir, "pithy.config.ts");
  const source = await readFile(path, "utf8");
  await writeFile(path, unwireConfig(source, name, pkg));
}

/**
 * Remove the capability's bindings from every `wrangler.jsonc` environment, comment-preserving —
 * keeping any binding another installed capability still needs ({@link removableBindings}). Returns
 * the binding names actually removed.
 */
export async function removeFromWrangler(
  projectDir: string,
  target: HasBindings,
  others: readonly HasBindings[],
): Promise<string[]> {
  const bindings = removableBindings(target, others);
  if (bindings.length === 0) return [];

  const config = (await readWranglerConfig(projectDir)) as WranglerBindings;
  stripBindings(config, bindings);
  for (const stanza of Object.values(config.env ?? {})) {
    if (stanza) stripBindings(stanza, bindings);
  }
  // DO class migrations are top-level only — strip them once, not per env.
  stripDurableObjectMigrations(config, bindings);
  await writeWranglerConfig(projectDir, config);
  return bindings.map((binding) => binding.name);
}

/** True if a path exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Whether the capability's tables outlive it — true unless a `--drop` reversed every migration. */
function tablesRemain(target: Capability | undefined, dropped: DatabaseRun[] | undefined): boolean {
  const declaresMigrations = Object.values(target?.databases ?? {}).some(
    (spec) => spec?.migrations && Object.keys(spec.migrations).length > 0,
  );
  if (!declaresMigrations) return false;
  return !dropped || dropped.every((run) => run.results.length === 0) ? declaresMigrations : false;
}

/** Injectable side effects, so the orchestration is testable without a real drop/uninstall/delete. */
export interface RemoveSteps {
  /** Every capability wired into the project (default: load `pithy.config.ts`). */
  loadCapabilities: () => Promise<Capability[]>;
  /** Drop the removed capability's tables for an env (default: {@link dropCapabilityTables}). */
  dropTables: (capability: Capability, env: string) => Promise<DatabaseRun[]>;
  /** Uninstall the package (default: {@link uninstallPackage}). */
  uninstall: (pkg: string) => Promise<{ packageManager: string }>;
  /** Delete an ejected capability's local source tree (default: recursive `fs.rm`). */
  deleteSource: (dir: string) => Promise<void>;
  /** Whether `@pithy-sh/<cap>` is installed (default: a `node_modules` stat). */
  packageInstalled: (pkg: string) => Promise<boolean>;
}

/** Real side effects for a live `pithy remove`. */
export function defaultRemoveSteps(projectDir: string, loadCapabilities: () => Promise<Capability[]>): RemoveSteps {
  return {
    loadCapabilities,
    dropTables: (capability, env) => dropCapabilityTables({ capability, projectDir, env }),
    uninstall: (pkg) => uninstallPackage({ projectDir, pkg }),
    // fs.rm (recursive) unlinks contents then removes the dir — the node API, not shell `rm -rf`.
    deleteSource: (dir) => rm(dir, { recursive: true, force: true }),
    packageInstalled: (pkg) => exists(join(projectDir, "node_modules", pkg)),
  };
}

export interface RemoveCapabilityOptions {
  projectDir: string;
  capability: string;
  /**
   * Drop the capability's tables for this env before unwiring; omit to leave data. `confirm` is asked
   * once the capability is confirmed present and unblocked — a `false` return aborts with zero changes,
   * so the confirmation gates the first (and only) destructive step.
   */
  drop?: { env: string; confirm?: () => Promise<boolean> };
  steps: RemoveSteps;
}

/** What `remove` did — surfaced to the user (this command has no `--json`). */
export interface RemoveResult {
  capability: string;
  /** False when nothing was wired or installed — a no-op. */
  present: boolean;
  ejected: boolean;
  packageManager?: string;
  dropped?: DatabaseRun[];
  removedBindings: string[];
  /** True when the capability's D1 tables were left in place (no `--drop`). */
  tablesRemain: boolean;
  /** True when a `--drop` confirmation was declined — nothing was changed. */
  aborted?: boolean;
}

/**
 * The precise inverse of `add` (and `add --eject`). Detects the capability's form and reverses it: an
 * optional `--drop` of its tables first (while its `down` code is still present), then unwires the
 * config import + registration and removes its bindings from every `wrangler.jsonc` env, then
 * uninstalls the package (package-served) or deletes the local source (ejected). Never destroys data
 * unless `drop` is set. Idempotent: an absent capability is a no-op. Refuses when another wired
 * capability depends on this one.
 */
export async function removeCapability(options: RemoveCapabilityOptions): Promise<RemoveResult> {
  const { projectDir, capability, steps } = options;
  const pkg = `@pithy-sh/${capability}`;

  const capabilities = await steps.loadCapabilities();
  const target = capabilities.find((c) => c.name === capability);
  const ejected = await isEjected(projectDir, capability);
  const installed = await steps.packageInstalled(pkg);

  if (!target && !ejected && !installed) {
    return { capability, present: false, ejected: false, removedBindings: [], tablesRemain: false };
  }

  const dependents = capabilities
    .filter((c) => c.name !== capability && c.dependsOn?.includes(capability))
    .map((c) => c.name);
  if (dependents.length > 0) {
    throw new ConflictError({
      message: `Can't remove ${capability} — ${dependents.join(", ")} depend${dependents.length === 1 ? "s" : ""} on it.`,
      action: `Remove ${dependents.join(", ")} first, then remove ${capability}.`,
    });
  }

  // Drop tables first: the down code lives in the source about to be unwired and uninstalled. The
  // confirmation gates it — a decline aborts here, before any file has changed.
  let dropped: DatabaseRun[] | undefined;
  if (options.drop && target) {
    if (options.drop.confirm && !(await options.drop.confirm())) {
      return { capability, present: true, ejected, removedBindings: [], tablesRemain: true, aborted: true };
    }
    dropped = await steps.dropTables(target, options.drop.env);
  }

  await removeFromConfig(projectDir, capability, pkg);
  const others = capabilities.filter((c) => c.name !== capability);
  const removedBindings = target ? await removeFromWrangler(projectDir, target, others) : [];

  let packageManager: string | undefined;
  if (ejected) {
    await steps.deleteSource(join(projectDir, EJECT_DIR, capability));
  } else if (installed) {
    ({ packageManager } = await steps.uninstall(pkg));
  }

  return {
    capability,
    present: true,
    ejected,
    packageManager,
    dropped,
    removedBindings,
    tablesRemain: tablesRemain(target, dropped),
  };
}

import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BindingSpec } from "@pithy-sh/core/src/capability/bindings";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ConflictError, InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { CliAuditEmit } from "../audit/cliAudit";
import { type DatabaseRun, dropCapabilityTables } from "../migrations/run";
import { uninstallPackage } from "../project/packageManager";
import { discoverWorkers } from "../project/workers";
import { readWranglerConfig, writeWranglerConfig } from "../project/wrangler";
import { EJECT_DIR, ejectImportPath, isEjected } from "./eject";

/** The subset of a manifest/capability the binding helpers read — both shapes carry it. */
type HasBindings = { requiredBindings: readonly BindingSpec[] };

/** Escape a capability name for use inside a `RegExp` (names are simple, but be safe). */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove a capability's import and registration from a Worker's `pithy.config.ts` — the inverse of `add`'s
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

/** Rewrite one Worker's `pithy.config.ts` with the capability's import + registration removed. */
export async function removeFromConfig(workerDir: string, name: string, pkg: string): Promise<void> {
  const path = join(workerDir, "pithy.config.ts");
  const source = await readFile(path, "utf8");
  await writeFile(path, unwireConfig(source, name, pkg));
}

/**
 * Remove the capability's bindings from every environment of one Worker's `wrangler.jsonc`,
 * comment-preserving — keeping any binding another capability wired into **that Worker** still needs
 * ({@link removableBindings}). Returns the binding names actually removed. A sibling Worker that wires
 * the same capability keeps its own bindings; each Worker's wrangler.jsonc is independent.
 */
export async function removeFromWrangler(
  workerDir: string,
  target: HasBindings,
  others: readonly HasBindings[],
): Promise<string[]> {
  const bindings = removableBindings(target, others);
  if (bindings.length === 0) return [];

  const config = (await readWranglerConfig(workerDir)) as WranglerBindings;
  stripBindings(config, bindings);
  for (const stanza of Object.values(config.env ?? {})) {
    if (stanza) stripBindings(stanza, bindings);
  }
  // DO class migrations are top-level only — strip them once, not per env.
  stripDurableObjectMigrations(config, bindings);
  await writeWranglerConfig(workerDir, config);
  return bindings.map((binding) => binding.name);
}

/**
 * Whether a Worker's `pithy.config.ts` still imports the capability's package. Matches the module
 * specifier itself, not only the import line `add` writes, so a hand-added deep import
 * (`@pithy-sh/auth/src/routes`) counts too — uninstalling the package would break that Worker just the
 * same. Ejected wiring (`./capabilities/<cap>`) never matches: that Worker owns its copy and needs no
 * package.
 */
export function importsPackage(source: string, pkg: string): boolean {
  return new RegExp(`["']${escapeRegExp(pkg)}(["']|/)`).test(source);
}

/**
 * The sibling Workers that still import `pkg`. The capability package is installed **once at the project
 * root** and shared by every Worker (`capabilities/flow.ts`), so it may only be uninstalled when no other
 * Worker composes it — otherwise that Worker's `pithy.config.ts` stops loading and every command that
 * reads it fails project-wide. The target Worker is excluded: it is the one being unwired.
 *
 * Configs are read as text, never imported: this runs mid-removal, and executing a config to answer
 * "is the package still needed?" would be both slower and fragile.
 */
async function workersUsingPackage(projectDir: string, workerDir: string, pkg: string): Promise<string[]> {
  const workers = await discoverWorkers(projectDir).catch(() => []);
  const using: string[] = [];
  for (const worker of workers) {
    if (resolve(worker.dir) === resolve(workerDir)) continue;
    const source = await readFile(join(worker.dir, "pithy.config.ts"), "utf8").catch(() => "");
    if (importsPackage(source, pkg)) using.push(worker.name);
  }
  return using;
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
  /** Every capability wired into the target Worker (default: its loaded `pithy.config.ts`). */
  loadCapabilities: () => Promise<Capability[]>;
  /** Drop the removed capability's tables for an env (default: {@link dropCapabilityTables}). */
  dropTables: (capability: Capability, env: string) => Promise<DatabaseRun[]>;
  /** Uninstall the package (default: {@link uninstallPackage}). */
  uninstall: (pkg: string) => Promise<{ packageManager: string }>;
  /** Delete an ejected capability's local source tree (default: recursive `fs.rm`). */
  deleteSource: (dir: string) => Promise<void>;
  /** Whether `@pithy-sh/<cap>` is installed (default: a `node_modules` stat). */
  packageInstalled: (pkg: string) => Promise<boolean>;
  /**
   * The **other** Workers that still import the package, by name — the guard on uninstalling a
   * project-wide dependency (default: a scan of `apps/*`). Empty means the package is free to go.
   */
  workersUsingPackage: (pkg: string) => Promise<string[]>;
}

/** What {@link defaultRemoveSteps} needs: the two directories a removal spans, and the wired set. */
export interface DefaultRemoveStepsOptions {
  /** The project root — where the lockfile and `node_modules` live. Packages are a project dependency. */
  projectDir: string;
  /** The target Worker's directory — its `wrangler.jsonc` names the D1 a `--drop` reverses. */
  workerDir: string;
  /** Every capability wired into the target Worker. */
  loadCapabilities: () => Promise<Capability[]>;
}

/**
 * Real side effects for a live `pithy remove`. The split is deliberate: **wiring is per-Worker**
 * (the tables dropped are the target Worker's D1, resolved from its own `wrangler.jsonc`) while the
 * **package is project-wide** (one workspace dependency, installed and uninstalled at the root) — which
 * is exactly why the uninstall is gated on {@link RemoveSteps.workersUsingPackage}.
 */
export function defaultRemoveSteps(options: DefaultRemoveStepsOptions): RemoveSteps {
  const { projectDir, workerDir } = options;
  return {
    loadCapabilities: options.loadCapabilities,
    dropTables: (capability, env) => dropCapabilityTables({ capability, workerDir, persistRoot: projectDir, env }),
    uninstall: (pkg) => uninstallPackage({ projectDir, pkg }),
    // fs.rm (recursive) unlinks contents then removes the dir — the node API, not shell `rm -rf`.
    deleteSource: (dir) => rm(dir, { recursive: true, force: true }),
    packageInstalled: (pkg) => exists(join(projectDir, "node_modules", pkg)),
    workersUsingPackage: (pkg) => workersUsingPackage(projectDir, workerDir, pkg),
  };
}

export interface RemoveCapabilityOptions {
  /**
   * The target Worker's directory (`apps/<name>`) — its `pithy.config.ts`, its `wrangler.jsonc`, and
   * its `capabilities/` fork directory. Only this Worker is unwired.
   */
  workerDir: string;
  capability: string;
  /**
   * Drop the capability's tables for this env before unwiring; omit to leave data. `confirm` is asked
   * once the capability is confirmed present and unblocked — a `false` return aborts with zero changes,
   * so the confirmation gates the first (and only) destructive step.
   */
  drop?: { env: string; confirm?: () => Promise<boolean> };
  steps: RemoveSteps;
  /** Audit emitter. Defaults to recording nothing, so a caller without audit wiring still works. */
  audit?: CliAuditEmit;
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
  /**
   * The other Workers that still compose the capability, so the shared package was **kept** installed.
   * Empty when nothing else needs it — the case where `packageManager` names the uninstall that ran.
   */
  keptFor: string[];
  /** True when the capability's D1 tables were left in place (no `--drop`). */
  tablesRemain: boolean;
  /** True when a `--drop` confirmation was declined — nothing was changed. */
  aborted?: boolean;
}

/**
 * The precise inverse of `add` (and `add --eject`), for **one Worker**. Detects the capability's form
 * and reverses it: an optional `--drop` of its tables first (while its `down` code is still present),
 * then unwires that Worker's config import + registration and removes its bindings from every
 * `wrangler.jsonc` env, then uninstalls the package (package-served) or deletes the local source
 * (ejected). Never destroys data unless `drop` is set. Idempotent: an absent capability is a no-op.
 * Refuses when another capability wired into the same Worker depends on this one.
 *
 * The package is the one project-wide part of a removal, so it is uninstalled only when **no other
 * Worker still imports it** — those Workers come back in {@link RemoveResult.keptFor}.
 */
export async function removeCapability(options: RemoveCapabilityOptions): Promise<RemoveResult> {
  const { workerDir, capability, steps } = options;
  const audit = options.audit ?? (async () => {});
  const pkg = `@pithy-sh/${capability}`;

  const capabilities = await steps.loadCapabilities();
  const target = capabilities.find((c) => c.name === capability);
  const ejected = await isEjected(workerDir, capability);
  const installed = await steps.packageInstalled(pkg);

  if (!target && !ejected && !installed) {
    return { capability, present: false, ejected: false, removedBindings: [], keptFor: [], tablesRemain: false };
  }

  const dependents = capabilities
    .filter((c) => c.name !== capability && c.dependsOn?.includes(capability))
    .map((c) => c.name);
  if (dependents.length > 0) {
    await audit({
      action: "capability/removed",
      outcome: "failure",
      severity: "warning",
      resourceType: "capability",
      resourceId: capability,
      metadata: { reason: "dependents", dependents },
    });
    throw new ConflictError({
      message: `Can't remove ${capability} — ${dependents.join(", ")} depend${dependents.length === 1 ? "s" : ""} on it.`,
      action: `Remove ${dependents.join(", ")} first, then remove ${capability}.`,
    });
  }

  // Which sibling Workers still wire this package. Resolved once, up front, because it gates BOTH the
  // drop and the uninstall: two Workers that both compose a capability against the same D1 share its
  // tables, so reversing its migrations for one Worker would delete data the other is still serving.
  // An ejected capability is that Worker's own forked copy, so no sibling can be relying on the package.
  const keptFor = ejected ? [] : await steps.workersUsingPackage(pkg);

  if (options.drop && keptFor.length > 0) {
    const plural = keptFor.length === 1 ? "s" : "";
    await audit({
      action: "capability/tables_dropped",
      outcome: "failure",
      severity: "warning",
      resourceType: "capability",
      resourceId: capability,
      metadata: { reason: "shared_with_workers", keptFor, env: options.drop.env },
    });
    throw new ConflictError({
      message: `Can't drop ${capability}'s tables — ${keptFor.join(", ")} still wire${plural} it.`,
      action: `Remove ${capability} from ${keptFor.join(", ")} first, or re-run without --drop to unwire this worker and keep the data.`,
    });
  }

  // Drop tables first: the down code lives in the source about to be unwired and uninstalled. The
  // confirmation gates it — a decline aborts here, before any file has changed.
  let dropped: DatabaseRun[] | undefined;
  if (options.drop && target) {
    if (options.drop.confirm && !(await options.drop.confirm())) {
      // `denied`, not `failure`: a human deliberately blocked a destructive action. First-class in the trail.
      await audit({
        action: "capability/tables_dropped",
        outcome: "denied",
        severity: "warning",
        resourceType: "capability",
        resourceId: capability,
        metadata: { env: options.drop.env },
      });
      return {
        capability,
        present: true,
        ejected,
        removedBindings: [],
        keptFor: [],
        tablesRemain: true,
        aborted: true,
      };
    }
    dropped = await steps.dropTables(target, options.drop.env);
    const migrationsReverted = dropped.reduce((sum, run) => sum + run.results.length, 0);
    await audit({
      action: "capability/tables_dropped",
      outcome: "success",
      severity: "warning",
      resourceType: "capability",
      resourceId: capability,
      metadata: { env: options.drop.env, migrationsReverted },
    });
  }

  await removeFromConfig(workerDir, capability, pkg);
  const others = capabilities.filter((c) => c.name !== capability);
  const removedBindings = target ? await removeFromWrangler(workerDir, target, others) : [];

  let packageManager: string | undefined;
  if (ejected) {
    await steps.deleteSource(join(workerDir, EJECT_DIR, capability));
  } else if (installed && keptFor.length === 0) {
    // One install at the root, shared by every Worker. Uninstalling it while a sibling Worker still
    // imports it would break that Worker's pithy.config.ts — and every command that loads it. So the
    // wiring goes and the package stays, which a later `pithy remove` from the last Worker cleans up.
    ({ packageManager } = await steps.uninstall(pkg));
  }

  await audit({
    action: "capability/removed",
    outcome: "success",
    severity: "info",
    resourceType: "capability",
    resourceId: capability,
    metadata: { ejected, packageManager: packageManager ?? null, removedBindings, keptFor },
  });

  return {
    capability,
    present: true,
    ejected,
    packageManager,
    dropped,
    removedBindings,
    keptFor,
    tablesRemain: tablesRemain(target, dropped),
  };
}

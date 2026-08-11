// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename, join } from "node:path";
import type { CapabilityManifest, ConfigOption } from "@pithy-sh/core/src/capability/manifest";
import { messageOf, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { CliAuditEmit } from "../audit/cliAudit";
import type { CloudflareAccountSelection } from "../cloudflare/config";
import { type DatabaseRun, migrateProject } from "../migrations/run";
import type { ProposedName } from "../project/bindingEntries";
import { allCapabilities, loadWorkerConfig } from "../project/config";
import { installPackage } from "../project/packageManager";
import { readFileOutcome } from "../project/readOptionalFile";
import { type WorkerIdentity, workerIdentity } from "../project/workerIdentity";
import { addCapability, type ConfigValue } from "./add";
import { bootstrapAdd } from "./addBootstrap";
import { capabilityPackageName } from "./catalog";
import { type EjectCapabilityOptions, type EjectResult, ejectCapability } from "./eject";
import { availableManifests, loadManifest } from "./manifests";
import { isRegistered, prerequisiteClosure, prerequisiteRefusal } from "./prerequisites";

/**
 * Whether this option's value is one only the adopter can write — a registry of secrets, a set of
 * boards — rather than a scalar a flag or a prompt can carry.
 *
 * The manifest states it as an empty literal so the generated config compiles (see `ConfigOptionValue`),
 * and that is the whole of what the CLI can do for it. Both input paths ask this before touching such an
 * option: `String({})` is `"[object Object]"`, and a prompt that offered it as a default would take a
 * config that merely failed to typecheck and turn it into one that composed a string as a registry.
 */
export function isHandWritten(option: ConfigOption): boolean {
  return typeof option.default === "object";
}

/** Coerce a raw string (a `--set` value or a prompt answer) to its option's type. */
export function coerceConfigValue(option: ConfigOption, raw: string, capability: string): ConfigValue {
  if (isHandWritten(option)) {
    throw new ValidationError({
      message: `${capability} option "${option.key}" is not settable from the command line.`,
      action: `Edit ${option.key} in the worker's pithy.config.ts — pithy add scaffolds it empty.`,
      detail: `${option.key} takes an object or an array; --set and the prompt both carry strings.`,
    });
  }
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

/** What a prerequisite prompt is asked: the capability wanted, the Worker, and what it lacks — deepest first. */
export interface PrerequisiteQuestion {
  /** The capability the adopter asked for. */
  capability: string;
  /** The Worker it is being wired into. */
  worker: string;
  /** The prerequisites to compose first, in the order they would be composed. */
  missing: string[];
}

/**
 * Ask whether to compose a capability's missing prerequisites too.
 *
 * Supplied **only** when a human is attached, the same rule `targetWorker`'s Worker picker and
 * `askDomains` follow. A run that cannot answer a question is never asked one: it either carries
 * `withPrerequisites` and resolves deterministically, or it is refused naming the exact commands.
 */
export type PrerequisitePrompt = (question: PrerequisiteQuestion) => Promise<boolean>;

/** Install the package with the project's package manager. Injectable for tests. */
export type InstallStep = (input: { projectDir: string; pkg: string }) => Promise<{ packageManager: string }>;

/** What the migrate step is told: the persistence root, the one Worker just wired, and who owns the data. */
export interface MigrateTarget {
  /** The project root — the owner of the `.wrangler/state` store every Worker's local D1 lives in. */
  projectDir: string;
  /** The target Worker's directory — its `wrangler.jsonc` supplies the D1 bindings. */
  workerDir: string;
  /** The target Worker's name. */
  worker: string;
  /** The project name every database this run touches is claimed for — `add` writes, so it must name itself. */
  project: string;
  /**
   * The Cloudflare account this project belongs to, or `null` when it names none. `add`'s migrate is a
   * `dev` run today, so `null` costs it nothing; it is threaded because the step it feeds
   * (`migrateProject`) can reach a live schema and must never do so under an account nobody named (#234).
   */
  account: CloudflareAccountSelection | null;
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
const defaultMigrate: MigrateStep = async ({ projectDir, workerDir, worker, project, account }) => {
  // `fresh`, and it is the whole point of the sentence above. The wiring was written moments ago, and
  // this process has already imported this config — `pithy add` resolves the target Worker's capabilities
  // before it wires anything. Taking the cache here returned the module from *before* the write, so the
  // registry was built without the capability just added and its migrations were never applied. `add`
  // reported a clean run and `pithy dev` served 500s off tables nothing had created (#273).
  const config = await loadWorkerConfig(workerDir, { fresh: true });
  const runs = await migrateProject({
    projectDir,
    env: "dev",
    project,
    account,
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
  /**
   * The project name, resolved by the **caller** from the root `pithy.config.ts` (`requireProjectName`)
   * and handed over as a plain string. It is the first segment of every resource name `add` proposes —
   * and, because `add` finishes by running the Worker's dev migrations, the name that database is
   * claimed for. Required for exactly that reason: the proposal can degrade to nothing, a write to a
   * database cannot. A project with no `name` is told to set one before `add` installs anything.
   *
   * `runAdd` deliberately never loads the root config itself. `loadProject` imports it live, and vitest
   * can only transform a TS config that lives under the project root — the add-flow suites scaffold into
   * the OS tmpdir, so an import there fails with an error about the config rather than about the test.
   */
  project: string;
  /**
   * The Cloudflare account this project belongs to, from `projectCloudflareAccount(projectDir)`, or
   * `null` when it names none. Required (#234): `pithy add secrets` records the account's one
   * `SECRETS_STORE_ID`, and it recorded the *default* account's for as long as `bootstrapAdd`'s
   * parameter was optional and this one did not exist.
   */
  account: CloudflareAccountSelection | null;
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
  /**
   * Compose the capability's declared prerequisites too, without asking (`--with-prerequisites`).
   *
   * The deterministic answer a non-interactive run needs. Left unset, a run with a human attached is
   * asked ({@link RunAddOptions.askPrerequisites}) and any other run is refused, naming the commands —
   * because composing a capability nobody asked for is not something to do behind an adopter's back, and
   * neither is reporting `Done.` on a project that cannot boot (#273).
   */
  withPrerequisites?: boolean;
  /** Ask a human whether to compose the missing prerequisites. Omitted in non-interactive / `--json` runs. */
  askPrerequisites?: PrerequisitePrompt;
}

export interface AddResult extends WorkerIdentity {
  capability: string;
  package: string;
  packageManager: string;
  databases: DatabaseRun[];
  /**
   * The KV namespace titles to create, `<project>-<env>-<binding>`, one per environment that gained the
   * binding. Reported rather than written because a `kv_namespaces` entry has no title field; D1's
   * proposal goes straight into `wrangler.jsonc` as `database_name`. Empty when the capability needs no
   * KV, when no project name was resolved, or on a re-run.
   */
  kvNamespaces: ProposedName[];
  /**
   * What `add` finished, and what it could not — one line each, printed in order.
   *
   * A binding whose entry carries a provisioned value is never written into `wrangler.jsonc`, so the
   * adopter is otherwise told about it by a 500 on their first request. These lines say it at add time:
   * the dev master key `pithy add secrets` just minted, or the provision command a Workflow needs.
   * Empty for a capability every one of whose bindings `add` writes.
   */
  notes: string[];
  /**
   * The prerequisites composed on the way to this one, in the order they were composed — deepest first,
   * so `pithy add auth` on a bare Worker reports `["secrets", "email"]`.
   *
   * Empty when the capability declares none, and empty on a re-run into a Worker that already composes
   * them. Each of them was a full `pithy add` of its own: package installed, config and bindings wired,
   * dev secrets minted, audited as `capability/added` in its own right.
   */
  prerequisites: string[];
  /** Present when `--eject` ran: what was copied and which deps were promoted. */
  eject?: EjectResult;
}

/**
 * The kit capabilities a Worker's `pithy.config.ts` composes: installed under the project root, **and**
 * registered in this Worker's file.
 *
 * Both halves, for the reason `reconcile.ts` states — one install at the root is shared by every Worker,
 * so "installed" describes the project and only the config says what this Worker is made of.
 *
 * The source is read, never imported. The config this is asked about is routinely one that cannot boot —
 * that is the whole subject — and a capability whose package is half-installed would turn a question
 * about composition into a module-resolution failure.
 */
async function composedCapabilities(installed: readonly CapabilityManifest[], workerDir: string): Promise<Set<string>> {
  const read = await readFileOutcome(join(workerDir, "pithy.config.ts"));
  const source = read.state === "read" ? read.text : "";
  return new Set(installed.filter((manifest) => isRegistered(source, manifest.name)).map((manifest) => manifest.name));
}

/**
 * The prerequisites this Worker lacks for the capability being added, deepest first.
 *
 * A peer's manifest is read when its package is already on disk — every capability's peers are its own
 * npm dependencies, so installing `@pithy-sh/auth` brings `@pithy-sh/email` and `@pithy-sh/secrets` with
 * it — and treated as a leaf when it is not. Either way the answer is complete enough to act on: each
 * prerequisite is composed by a full `runAdd` of its own, which resolves *its* peers against a tree that
 * now has them.
 */
async function missingFor(projectDir: string, workerDir: string, manifest: CapabilityManifest): Promise<string[]> {
  if (manifest.peerCapabilities.length === 0) return [];
  const { manifests } = await availableManifests(projectDir);
  const composed = await composedCapabilities(manifests, workerDir);
  const byName = new Map(manifests.map((found) => [found.name, found]));
  return prerequisiteClosure({ manifest, composed, manifestFor: (name) => byName.get(name) });
}

/** What composing a capability's prerequisites produced — merged into the result the adopter reads. */
interface ComposedPrerequisites {
  /** The prerequisite names, in the order composed. */
  names: string[];
  /** Their `notes`, in order, ahead of this capability's own. */
  notes: string[];
  /** Their KV namespace proposals, in order, ahead of this capability's own. */
  kvNamespaces: ProposedName[];
}

/**
 * Compose whatever this capability declares and this Worker lacks — or refuse, naming the commands.
 *
 * **The decision is made once, and then it is carried.** A run that says yes to `auth` is not asked
 * again about `email`'s own `secrets`: the nested add inherits `withPrerequisites` and no prompt. One
 * intent, one question.
 *
 * **Each prerequisite is a real `pithy add`.** Not a config line written by this function — the same
 * install, the same manifest read, the same bindings in every environment stanza, the same dev secrets,
 * the same audit event. A cheaper "just add the import" is how the wiring for a capability composed this
 * way would differ from the wiring for one composed by name, and that difference is a second defect
 * waiting in the same place as the first.
 *
 * Their config options take manifest defaults. The adopter asked for one capability, not for an
 * interview about three; `pithy add email --set …` re-runs against the same registration afterwards.
 */
async function composePrerequisites(
  options: RunAddOptions & { worker: string; manifest: CapabilityManifest },
): Promise<ComposedPrerequisites> {
  const { projectDir, workerDir, worker, manifest } = options;
  const empty: ComposedPrerequisites = { names: [], notes: [], kvNamespaces: [] };

  const missing = await missingFor(projectDir, workerDir, manifest);
  if (missing.length === 0) return empty;

  // Named by its `apps/` directory, never by its deployed script name: every command in the sentence
  // takes `--worker <dir>`, and a refusal that names `replay-board` sends the adopter to a flag value
  // that does not resolve.
  const named = workerIdentity({ name: worker, dir: workerDir }).worker;
  const agreed =
    options.withPrerequisites === true ||
    (options.askPrerequisites !== undefined &&
      (await options.askPrerequisites({ capability: manifest.name, worker: named, missing })));
  if (!agreed) throw prerequisiteRefusal({ capability: manifest.name, worker: named, missing });

  const composed: ComposedPrerequisites = { names: [], notes: [], kvNamespaces: [] };
  for (const name of missing) {
    const result = await runAdd({
      projectDir,
      workerDir,
      worker,
      project: options.project,
      account: options.account,
      capability: name,
      withPrerequisites: true,
      ...(options.install === undefined ? {} : { install: options.install }),
      ...(options.migrate === undefined ? {} : { migrate: options.migrate }),
      ...(options.audit === undefined ? {} : { audit: options.audit }),
    });
    composed.names.push(...result.prerequisites, result.capability);
    composed.notes.push(...result.notes);
    composed.kvNamespaces.push(...result.kvNamespaces);
  }
  return composed;
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
    // Resolved through the catalog, never interpolated from the name: `controlplane` ships inside
    // `@pithy-sh/core`, so `@pithy-sh/controlplane` is a package that has never existed and the install
    // would fail before the manifest was ever read.
    const { packageManager } = await install({ projectDir, pkg: capabilityPackageName(capability) });

    const manifest = await loadManifest(capability, projectDir);

    // Before a byte of this capability's wiring is written: what it composes against, and whether this
    // Worker has it. Refusing here leaves an installed package and nothing else — a config half-wired
    // around an absent peer is the state #273 is about.
    const prerequisites = await composePrerequisites({ ...options, worker, manifest });

    let configValues = coerceSetFlags(manifest, options.setFlags ?? []);
    if (options.prompt && manifest.configOptions.length > 0) {
      configValues = await options.prompt(manifest, configValues);
    }

    const { kvNamespaces } = await addCapability({
      workerDir,
      manifest,
      configValues,
      project: options.project,
    });

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

    const databases = await migrate({
      projectDir,
      workerDir,
      worker,
      project: options.project,
      account: options.account,
    });

    // Last, after every step that can fail: a dev key is minted only into a project the add finished
    // on. It is absent-only anyway, so an earlier failure costs a re-run rather than a stranded value.
    const notes = await bootstrapAdd({ projectDir, manifest, account: options.account });

    await audit({
      action: "capability/added",
      outcome: "success",
      severity: "info",
      resourceType: "capability",
      resourceId: manifest.name,
      metadata: { targetWorker: worker, package: manifest.package, packageManager, ejected: Boolean(eject) },
    });

    return {
      capability: manifest.name,
      // Both names, and the audit trail above keeps using the deployed one deliberately: an audit event
      // records what was acted on in the account, where `dash-board` is the identifier that means
      // something. The result is read by a human or a script holding the checkout, where the directory
      // is. See `workerIdentity` for why the two are not interchangeable.
      ...workerIdentity({ name: worker, dir: workerDir }),
      package: manifest.package,
      packageManager,
      // One run, not four. The closing migrate re-reads the config and migrates everything this Worker
      // now composes, prerequisites included, so merging each nested run's databases would report the
      // same migrations several times over.
      databases,
      // Merged, and theirs first, because the order is the order things happened. A prerequisite's notes
      // are the ones an adopter most needs to see and least expects to be given — the dev master key
      // `add secrets` mints is a line printed once, and swallowing it costs them the key.
      kvNamespaces: [...prerequisites.kvNamespaces, ...kvNamespaces],
      notes: [...prerequisites.notes, ...notes],
      prerequisites: prerequisites.names,
      eject,
    };
  } catch (error) {
    await audit({
      action: "capability/added",
      outcome: "failure",
      severity: "info",
      resourceType: "capability",
      resourceId: capability,
      metadata: { targetWorker: worker, error: messageOf(error) },
    });
    throw error;
  }
}

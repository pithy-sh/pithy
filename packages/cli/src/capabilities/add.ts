// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BindingSpec } from "@pithy-sh/core/src/capability/bindings";
import {
  type CapabilityManifest,
  renderCapabilityImport,
  renderCapabilityRegistration,
  renderConfigOptionComment,
  renderConfigOptionLine,
} from "@pithy-sh/core/src/capability/manifest";
import { ConflictError, InternalError } from "@pithy-sh/core/src/error/pithyError";
import { isValidEnvironment } from "@pithy-sh/core/src/naming/environment";
import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import { readWranglerConfig, writeWranglerConfig } from "../project/wrangler";
import { capabilityImportSpecifier, findNamedImport, importOrigin } from "./configImports";
import { ejectImportPath } from "./eject";

/** A config option's value: the JSON scalars a manifest default can be. */
export type ConfigValue = string | number | boolean;

export interface AddCapabilityOptions {
  /**
   * The **Worker's** directory (`apps/<name>`) — where that Worker's `pithy.config.ts` and
   * `wrangler.jsonc` live. Capabilities are per-Worker: the composed route tree, the bindings, and the
   * Durable Object class migrations all attach to one script, so wiring never touches the project root.
   */
  workerDir: string;
  /** The capability's validated manifest (pithy.manifest.json shape). */
  manifest: CapabilityManifest;
  /** Per-option overrides; an unset option renders its manifest default. */
  configValues?: Record<string, ConfigValue>;
  /**
   * The project name, resolved by the caller from the root `pithy.config.ts` (`requireProjectName`) and
   * passed as a plain string. It is the first segment of every name proposed here.
   *
   * **A string, never a loader.** Resolving it in here would mean importing the root config live, and a
   * live import only works under the project root — the wiring tests scaffold into the OS tmpdir, where
   * it fails with an error about the config rather than about the test. The caller already has the
   * config; it hands over the answer.
   *
   * Omitted when no project name could be resolved: nothing is proposed and the entries carry only their
   * binding, which is exactly what `pithy add` wrote before. A guessed prefix would be worse than none —
   * every command that later recomputes the name would compute a different one.
   */
  project?: string;
}

/** A `<project>-<env>-<binding>` name `pithy add` proposes for a resource the adopter creates themselves. */
export interface ProposedName {
  /** The Worker env binding the name is proposed for (e.g. `SESSIONS`). */
  binding: string;
  /** The environment whose stanza declares it — `dev` for the top-level one. */
  env: string;
  /** The proposed resource name, composed by the one naming rule: `<project>-<env>-<binding>`. */
  name: string;
}

/** What {@link addCapability} wired that the config file itself cannot carry. */
export interface AddCapabilityResult {
  /**
   * The KV namespace titles to give the namespaces this capability needs.
   *
   * **KV is reported rather than written, because wrangler has nowhere to write it.** A `kv_namespaces`
   * entry takes `binding`, `id`, `preview_id`, and `remote` — there is no title field, so the name lives
   * only in the account. D1 is different (`database_name` is a real key) and is written into the file.
   * R2 is deliberately absent from both: `pithy storage provision` and `pithy media provision` write
   * `bucket_name` themselves, and a second writer would collide with them.
   *
   * Empty when no project name was resolved, and empty on a re-run — a binding already present is left
   * exactly as the adopter has it.
   */
  kvNamespaces: ProposedName[];
}

/** The managed-region marker each Worker's `pithy.config.ts` plants inside `capabilities: [...]`. */
const MARKER = "// pithy:capabilities";

/**
 * One binding entry, as wrangler writes it. `remote` rides along when the spec sets it; the
 * resource's identity (`database_id`, `id`, `bucket_name`) is provision-time and is filled later by
 * `pithy provision` or the capability's own provisioner.
 *
 * `database_name` is the exception, and it is a *proposal*, not an identity: wrangler accepts a D1
 * entry naming a database that does not exist yet, and an adopter who leaves the field alone gets a
 * project-scoped name instead of inventing `db` or `my-db`.
 */
interface BindingEntry {
  binding: string;
  database_name?: string;
  remote?: boolean;
}

/** A single Durable Object namespace binding, as wrangler writes it. */
interface DurableObjectBinding {
  name: string;
  class_name: string;
  remote?: boolean;
}

/** A Durable Object class migration — a versioned tag registering (or dropping) DO classes. */
interface DurableObjectMigration {
  tag: string;
  new_sqlite_classes?: string[];
}

/**
 * A wrangler stanza's binding arrays — the keys `pithy add` touches. `durable_objects.bindings` is
 * per-environment (each environment gets its own DO namespace); DO class `migrations` are **top-level
 * only** (they register the class against the script, not per-environment), so they live on the root
 * config, not in `env.*` — see {@link appendDurableObjectMigrations}.
 *
 * `ai` is a single object, not an array: a Worker has exactly one Workers AI binding.
 */
interface WranglerBindings {
  d1_databases?: BindingEntry[];
  kv_namespaces?: BindingEntry[];
  r2_buckets?: BindingEntry[];
  ai?: BindingEntry;
  durable_objects?: { bindings: DurableObjectBinding[] };
  migrations?: DurableObjectMigration[];
  env?: Record<string, WranglerBindings | undefined>;
}

/** The single DO class-migration tag Pithy scaffolds under. New DO classes merge into it at add time. */
const DO_MIGRATION_TAG = "v1";

/**
 * Wire a capability into **one Worker** — the pure logic behind `pithy add`. Inserts the import and
 * registration into that Worker's `pithy.config.ts` managed region and appends the manifest's required
 * bindings to every environment of that Worker's `wrangler.jsonc`, comment-preserving. Idempotent: a
 * second run changes nothing. A sibling Worker is never touched.
 */
export async function addCapability(options: AddCapabilityOptions): Promise<AddCapabilityResult> {
  await updateConfig(options);
  return { kvNamespaces: await updateWrangler(options) };
}

/** Escape a capability name for use inside a `RegExp` (names are simple, but be safe). */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Render a capability's registration. With no config options it's a one-liner
 * (`auth(),`); with options it's a block — one commented `key: default` per
 * option — so `pithy.config.ts` documents itself (docs/CLI.md §Config). The mount
 * path and every other knob live here, in the user's surface; the handler stays
 * in the package.
 *
 * Every line of it comes from core's renderers now, the call included. This function used to interpolate
 * `manifest.name` into the call itself, which is how a manifest declaring `audit }) ; evil(` closed the
 * capabilities array and opened a call of its own (#183) — the same defect as the option key #174 closed,
 * one line up.
 */
function renderRegistration(
  manifest: CapabilityManifest,
  configValues: Record<string, ConfigValue>,
  indent: string,
): string {
  const inner = `${indent}  `;
  const optionLines: string[] = [];
  for (const option of manifest.configOptions) {
    const value = configValues[option.key] ?? option.default;
    // The same two lines `pithy upgrade` writes, from the same two functions. Two renderers of one line
    // is how `add` and `upgrade` came to disagree about a nested default in the first place (#171), and
    // the comment was still built here and there separately until the manifest text going into it got a
    // rule of its own (#174).
    optionLines.push(renderConfigOptionComment(option.describe, inner));
    optionLines.push(renderConfigOptionLine(option.key, value, inner));
  }
  return renderCapabilityRegistration({ name: manifest.name, indent, optionLines });
}

async function updateConfig({ workerDir, manifest, configValues }: AddCapabilityOptions): Promise<void> {
  const path = join(workerDir, "pithy.config.ts");
  let source = await readFile(path, "utf8");

  const markerLine = source.split("\n").find((line) => line.trimStart().startsWith(MARKER));
  if (markerLine === undefined) {
    throw new InternalError({
      message: `${path} has no "${MARKER}" marker.`,
      action: "Restore the managed-region marker inside capabilities: []. Run pithy add again.",
    });
  }

  const lines = source.split("\n");
  // Idempotency on the import is keyed on the *binding*, then checked against where it comes from.
  // Keyed on the whole line, an adopter who corrected a specifier by hand — which `pithy add secrets`
  // required, for as long as `@pithy-sh/secrets` shipped no `src/index` — got the original line back
  // on the next run, and two bindings of one name is a redeclaration the config never loads past.
  // Keyed on the binding alone, an adopter's own `auth` suppressed our import while `auth()` still
  // went into the managed region, so the config composed their middleware and said nothing. One is
  // loud and wrong, the other is silent and wrong. So: the name identifies the import, the specifier
  // decides what to do about it, and a name bound to something else is refused before anything is
  // written.
  const existing = findNamedImport(source, manifest.name);
  const origin = existing && importOrigin(existing.specifier, manifest.package, ejectImportPath(manifest.name));
  if (existing === undefined) {
    source = `${renderCapabilityImport(manifest.name, capabilityImportSpecifier(manifest.package))}\n${source}`;
  } else if (origin === "foreign") {
    throw new ConflictError({
      message: `${path} already imports ${manifest.name} from "${existing.specifier}".`,
      action: `Rename that import, then run pithy add ${manifest.name} again.`,
      detail: `Wiring ${manifest.name}() would have composed ${existing.specifier} as the capability.`,
    });
  } else if (origin === "unresolvable") {
    // Ours, and dead: the package exports `./src/*` and no `.`, so this line throws the moment anything
    // loads the config. Accepted as wiring, `add` wrote the registration against an import that could
    // never bind and exited 0. Refused rather than rewritten — the specifier is the adopter's line to
    // correct, and a command that silently repoints imports is one nobody can predict.
    throw new ConflictError({
      message: `${path} imports ${manifest.name} from "${existing.specifier}", which resolves to nothing.`,
      action: `Point that import at "${capabilityImportSpecifier(manifest.package)}", then run pithy add ${manifest.name} again.`,
      detail: `${manifest.package} exports ./src/* only, so the bare specifier has no entry point.`,
    });
  }

  // Idempotency anchors on the registration *call*, not an exact line: a block
  // form spans several lines, and `auth(` must not match an existing `myauth(`.
  const registered = new RegExp(`^${escapeRegExp(manifest.name)}\\(`);
  if (!lines.some((line) => registered.test(line.trim()))) {
    const indent = markerLine.slice(0, markerLine.length - markerLine.trimStart().length);
    const registration = renderRegistration(manifest, configValues ?? {}, indent);
    // A replacement function keeps `$` in the registration literal.
    source = source.replace(markerLine, () => `${registration}\n${markerLine}`);
  }

  await writeFile(path, source);
}

/**
 * Stamp the spec's `remote` flag onto an emitted entry. An unset `remote` writes no key at all: the
 * capability has no opinion, and an explicit `remote: false` would pin the binding to local
 * emulation the adopter may well want to override.
 */
function withRemote<Entry extends object>(entry: Entry, binding: BindingSpec): Entry {
  return binding.remote === undefined ? entry : { ...entry, remote: binding.remote };
}

/** Which project and which environment a stanza's names are composed for. */
interface NameScope {
  /** The project name, or absent when none was resolved — in which case nothing is proposed. */
  project?: string;
  /** The environment this stanza *is* — `dev` for the top-level one, else the `env.<name>` key. */
  env: string;
}

/**
 * The `<project>-<env>-<binding>` name to propose for a binding, or `undefined` when there is nothing
 * safe to propose.
 *
 * **Through the facade, per namespace.** A D1 database and a KV namespace are different Cloudflare
 * namespaces with different limits — no published cap and 512 respectively — and calling the generic
 * composer held both to 63, which is R2's number and only R2's. `resourceNames(project).env(env)` picks
 * the budget from the kind of thing being named, so `add`'s proposal is byte-identical to the name every
 * other command computes for the same resource *and* correct for the namespace it lands in.
 *
 * Two cases propose nothing rather than guessing. No project name: a guessed prefix is worse than none,
 * since every command that later recomputes the name would compute a different one. And an `env.<key>`
 * the naming scheme does not accept — an eleven-character environment eats the room every project name
 * was already accepted against, so no name for it is honest. The binding is still wired either way:
 * refusing to add a capability because of a stanza key would be the worse answer.
 */
function proposeName(scope: NameScope, binding: string, kind: "d1" | "kv"): string | undefined {
  if (scope.project === undefined || !isValidEnvironment(scope.env)) return undefined;
  return resourceNames(scope.project).env(scope.env)[kind](binding);
}

/**
 * Every environment's binding stanza, paired with the environment it *is*: the top-level one (the dev
 * environment) plus each `env.<name>`.
 *
 * The pairing is the point. Both writers used to walk `Object.values(config.env)` and drop the key, which
 * was harmless while an entry carried nothing but its binding — and wrong the moment a name has the
 * environment in it. Mirrors `reconcile.ts`'s `envStanzas` on the read side; the two are kept in lockstep
 * by intent, so a change here is a change there.
 */
function envStanzas(config: WranglerBindings): { env: string; stanza: WranglerBindings }[] {
  const list: { env: string; stanza: WranglerBindings }[] = [{ env: "dev", stanza: config }];
  for (const [env, stanza] of Object.entries(config.env ?? {})) {
    if (stanza) list.push({ env, stanza });
  }
  return list;
}

/**
 * Append a binding entry if its name isn't already bound. Mutates in place.
 *
 * The writer emits a binding's **shape** — its name, and whatever the spec can state (`class_name`,
 * `remote`). Resource identity is provision-time and stays absent here: `database_id`, `id`, and
 * `bucket_name` are written later by `pithy provision` or the capability's own provisioner.
 * That is the contract `d1` and `kv` have had since the first release.
 *
 * **`vectorize` and `workflows` are deliberately not emitted at all**, and that is the difference
 * between a binding wrangler completes later and a config wrangler refuses to load. Wrangler's
 * validator *requires* `index_name` on every `vectorize` entry and `name` + `class_name` on every
 * `workflows` entry — an entry carrying only `binding` fails the config, so `wrangler dev` and
 * `wrangler deploy` both stop. Neither missing value is knowable here: a Vectorize index name is a
 * provisioning output (`<project>-<env>-vector-<index>`) and a Workflow's script name is per project and
 * environment (`<project>-<env>-<capability>-<job>`), while `add` is offline by design. So the whole entry
 * is left to
 * the capability's own provisioner — `pithy vector provision` and `pithy storage provision` write
 * complete, per-environment entries through `project/appBindings.ts` once the resources exist. Same
 * precedent as `service` below, and the same reason: an entry we cannot complete is worse than none.
 */
function appendBindings(stanza: WranglerBindings, manifest: CapabilityManifest, scope: NameScope): ProposedName[] {
  const proposed: ProposedName[] = [];
  for (const binding of manifest.requiredBindings) {
    // An `optional` binding is one the capability only needs under a particular config — the seam's
    // `CONTROL_PLANE` KV, which nothing reads under the default `d1` replay backend. The manifest is one
    // static file and cannot vary with config, so it declares the union and marks such a binding
    // optional; writing it anyway would make every project provision and bind a namespace no code path
    // in the tree ever reads, and re-add it the moment an adopter deleted it. `createBackend` reads the
    // same flag to decide whether a missing binding is fatal at assembly.
    if (binding.optional) continue;
    if (binding.type === "d1") {
      stanza.d1_databases ??= [];
      if (!stanza.d1_databases.some((entry) => entry.binding === binding.name)) {
        const name = proposeName(scope, binding.name, "d1");
        stanza.d1_databases.push(
          withRemote({ binding: binding.name, ...(name ? { database_name: name } : {}) }, binding),
        );
      }
    }
    if (binding.type === "kv") {
      stanza.kv_namespaces ??= [];
      if (!stanza.kv_namespaces.some((entry) => entry.binding === binding.name)) {
        stanza.kv_namespaces.push(withRemote({ binding: binding.name }, binding));
        // No title field exists on a `kv_namespaces` entry, so the proposal is reported, not written.
        const name = proposeName(scope, binding.name, "kv");
        if (name) proposed.push({ binding: binding.name, env: scope.env, name });
      }
    }
    if (binding.type === "r2") {
      stanza.r2_buckets ??= [];
      if (!stanza.r2_buckets.some((entry) => entry.binding === binding.name)) {
        stanza.r2_buckets.push(withRemote({ binding: binding.name }, binding));
      }
    }
    // A Worker gets exactly one Workers AI binding, so `ai` is an object rather than an array. An
    // existing one is left alone: it is either this capability's (idempotency) or an adopter's
    // deliberate choice of binding name, and clobbering either would break their Worker.
    if (binding.type === "ai") {
      stanza.ai ??= withRemote({ binding: binding.name }, binding);
    }
    if (binding.type === "durable_object" && binding.className) {
      stanza.durable_objects ??= { bindings: [] };
      stanza.durable_objects.bindings ??= [];
      if (!stanza.durable_objects.bindings.some((entry) => entry.name === binding.name)) {
        stanza.durable_objects.bindings.push(
          withRemote({ name: binding.name, class_name: binding.className }, binding),
        );
      }
    }
    // Still unwritten: `queue`, `ratelimit`, `email`, and `secret` — none of which any shipped
    // capability declares — plus `service`, which the feature provisioner owns because it resolves to
    // the target Worker's environment-scoped script name (feature/wranglerEnv.ts:applyWorkerEnv), and
    // `vectorize`/`workflow`, which the capability's own provisioner owns (project/appBindings.ts).
  }
  return proposed;
}

/**
 * Register a capability's Durable Object classes in the **top-level** `migrations` array — the class
 * migration tag, distinct from D1 (Kysely) migrations and from the per-environment DO bindings.
 *
 * We choose `new_sqlite_classes`, not `new_classes`, deliberately: a Pithy session object stores its state
 * in SQLite-backed DO storage, and `new_classes` would provision a key-value backend that silently cannot
 * run SQL — the well-known DO footgun. All classes merge into one tag (`v1`) at add time. **Note:** adding
 * a DO class to a worker that has *already deployed* `v1` needs a *new* tag; this scaffolds the first-add
 * case, which is the only one Pithy has today (multiplayer is its first and only DO).
 */
function appendDurableObjectMigrations(config: WranglerBindings, manifest: CapabilityManifest): void {
  const classes = manifest.requiredBindings
    .filter((binding) => binding.type === "durable_object" && binding.className)
    .map((binding) => binding.className as string);
  if (classes.length === 0) return;

  config.migrations ??= [];
  let tag = config.migrations.find((migration) => migration.tag === DO_MIGRATION_TAG);
  if (!tag) {
    tag = { tag: DO_MIGRATION_TAG, new_sqlite_classes: [] };
    config.migrations.push(tag);
  }
  tag.new_sqlite_classes ??= [];
  for (const className of classes) {
    if (!tag.new_sqlite_classes.includes(className)) tag.new_sqlite_classes.push(className);
  }
}

async function updateWrangler({ workerDir, manifest, project }: AddCapabilityOptions): Promise<ProposedName[]> {
  const config = (await readWranglerConfig(workerDir)) as WranglerBindings;

  const kvNamespaces: ProposedName[] = [];
  for (const { env, stanza } of envStanzas(config)) {
    kvNamespaces.push(...appendBindings(stanza, manifest, { ...(project === undefined ? {} : { project }), env }));
  }
  // DO class migrations are top-level only — they register the class against the script, not per-env.
  appendDurableObjectMigrations(config, manifest);

  await writeWranglerConfig(workerDir, config);
  return kvNamespaces;
}

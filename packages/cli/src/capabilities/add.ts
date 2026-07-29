import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BindingSpec } from "@pithy-sh/core/src/capability/bindings";
import type { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { readWranglerConfig, writeWranglerConfig } from "../project/wrangler";

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
}

/** The managed-region marker each Worker's `pithy.config.ts` plants inside `capabilities: [...]`. */
const MARKER = "// pithy:capabilities";

/**
 * One binding entry, as wrangler writes it. `remote` rides along when the spec sets it; the
 * resource's identity (`database_id`, `id`, `bucket_name`) is provision-time and is filled later by
 * `pithy feature provision` or the capability's own provisioner.
 */
interface BindingEntry {
  binding: string;
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
export async function addCapability(options: AddCapabilityOptions): Promise<void> {
  await updateConfig(options);
  await updateWrangler(options);
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
 */
function renderRegistration(
  manifest: CapabilityManifest,
  configValues: Record<string, ConfigValue>,
  indent: string,
): string {
  if (manifest.configOptions.length === 0) return `${indent}${manifest.name}(),`;

  const inner = `${indent}  `;
  const lines = [`${indent}${manifest.name}({`];
  for (const option of manifest.configOptions) {
    const value = option.key in configValues ? configValues[option.key] : option.default;
    lines.push(`${inner}// ${option.describe}`);
    lines.push(`${inner}${option.key}: ${JSON.stringify(value)},`);
  }
  lines.push(`${indent}}),`);
  return lines.join("\n");
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
  const importLine = `import { ${manifest.name} } from "${manifest.package}/src/index";`;
  if (!lines.some((line) => line.trim() === importLine)) {
    source = `${importLine}\n${source}`;
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

/**
 * Append a binding entry if its name isn't already bound. Mutates in place.
 *
 * The writer emits a binding's **shape** — its name, and whatever the spec can state (`class_name`,
 * `remote`). Resource identity is provision-time and stays absent here: `database_id`, `id`, and
 * `bucket_name` are written later by `pithy feature provision` or the capability's own provisioner.
 * That is the contract `d1` and `kv` have had since the first release.
 *
 * **`vectorize` and `workflows` are deliberately not emitted at all**, and that is the difference
 * between a binding wrangler completes later and a config wrangler refuses to load. Wrangler's
 * validator *requires* `index_name` on every `vectorize` entry and `name` + `class_name` on every
 * `workflows` entry — an entry carrying only `binding` fails the config, so `wrangler dev` and
 * `wrangler deploy` both stop. Neither missing value is knowable here: a Vectorize index name is a
 * provisioning output (`pithy-vector-<index>-<env>`) and a Workflow's script name is per environment
 * (`pithy-<capability>-<job>-<env>`), while `add` is offline by design. So the whole entry is left to
 * the capability's own provisioner — `pithy vector provision` and `pithy storage provision` write
 * complete, per-environment entries through `project/appBindings.ts` once the resources exist. Same
 * precedent as `service` below, and the same reason: an entry we cannot complete is worse than none.
 */
function appendBindings(stanza: WranglerBindings, manifest: CapabilityManifest): void {
  for (const binding of manifest.requiredBindings) {
    if (binding.type === "d1") {
      stanza.d1_databases ??= [];
      if (!stanza.d1_databases.some((entry) => entry.binding === binding.name)) {
        stanza.d1_databases.push(withRemote({ binding: binding.name }, binding));
      }
    }
    if (binding.type === "kv") {
      stanza.kv_namespaces ??= [];
      if (!stanza.kv_namespaces.some((entry) => entry.binding === binding.name)) {
        stanza.kv_namespaces.push(withRemote({ binding: binding.name }, binding));
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

async function updateWrangler({ workerDir, manifest }: AddCapabilityOptions): Promise<void> {
  const config = (await readWranglerConfig(workerDir)) as WranglerBindings;

  appendBindings(config, manifest);
  for (const stanza of Object.values(config.env ?? {})) {
    if (stanza) appendBindings(stanza, manifest);
  }
  // DO class migrations are top-level only — they register the class against the script, not per-env.
  appendDurableObjectMigrations(config, manifest);

  await writeWranglerConfig(workerDir, config);
}

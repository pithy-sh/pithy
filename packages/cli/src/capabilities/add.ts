import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

/** A single Durable Object namespace binding, as wrangler writes it. */
interface DurableObjectBinding {
  name: string;
  class_name: string;
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
 */
interface WranglerBindings {
  d1_databases?: { binding: string }[];
  kv_namespaces?: { binding: string }[];
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

/** Append a binding entry if its name isn't already bound. Mutates in place. */
function appendBindings(stanza: WranglerBindings, manifest: CapabilityManifest): void {
  for (const binding of manifest.requiredBindings) {
    if (binding.type === "d1") {
      stanza.d1_databases ??= [];
      if (!stanza.d1_databases.some((entry) => entry.binding === binding.name)) {
        stanza.d1_databases.push({ binding: binding.name });
      }
    }
    if (binding.type === "kv") {
      stanza.kv_namespaces ??= [];
      if (!stanza.kv_namespaces.some((entry) => entry.binding === binding.name)) {
        stanza.kv_namespaces.push({ binding: binding.name });
      }
    }
    if (binding.type === "durable_object" && binding.className) {
      stanza.durable_objects ??= { bindings: [] };
      stanza.durable_objects.bindings ??= [];
      if (!stanza.durable_objects.bindings.some((entry) => entry.name === binding.name)) {
        stanza.durable_objects.bindings.push({ name: binding.name, class_name: binding.className });
      }
    }
    // Other binding kinds (email, secret, workflow, …) are wired by their
    // capabilities' scaffold steps when those capabilities ship (Phase 1+).
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

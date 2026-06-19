import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { readWranglerConfig, writeWranglerConfig } from "../project/wrangler";

/** A config option's value: the JSON scalars a manifest default can be. */
export type ConfigValue = string | number | boolean;

export interface AddCapabilityOptions {
  /** The project root — where pithy.config.ts and wrangler.jsonc live. */
  projectDir: string;
  /** The capability's validated manifest (pithy.manifest.json shape). */
  manifest: CapabilityManifest;
  /** Per-option overrides; an unset option renders its manifest default. */
  configValues?: Record<string, ConfigValue>;
}

/** The managed-region marker `pithy init` plants inside `capabilities: [...]`. */
const MARKER = "// pithy:capabilities";

/** A wrangler stanza's binding arrays — the only keys `pithy add` touches. */
interface WranglerBindings {
  d1_databases?: { binding: string }[];
  kv_namespaces?: { binding: string }[];
  env?: Record<string, WranglerBindings | undefined>;
}

/**
 * Wire a capability into a project — the pure logic behind `pithy add`. Inserts
 * the import and registration into pithy.config.ts's managed region and appends
 * the manifest's required bindings to every wrangler.jsonc environment,
 * comment-preserving. Idempotent: a second run changes nothing.
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

async function updateConfig({ projectDir, manifest, configValues }: AddCapabilityOptions): Promise<void> {
  const path = join(projectDir, "pithy.config.ts");
  let source = await readFile(path, "utf8");

  const markerLine = source.split("\n").find((line) => line.trimStart().startsWith(MARKER));
  if (markerLine === undefined) {
    throw new InternalError({
      message: `pithy.config.ts has no "${MARKER}" marker.`,
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
    // Other binding kinds (email, secret, workflow, …) are wired by their
    // capabilities' scaffold steps when those capabilities ship (Phase 1+).
  }
}

async function updateWrangler({ projectDir, manifest }: AddCapabilityOptions): Promise<void> {
  const config = (await readWranglerConfig(projectDir)) as WranglerBindings;

  appendBindings(config, manifest);
  for (const stanza of Object.values(config.env ?? {})) {
    if (stanza) appendBindings(stanza, manifest);
  }

  await writeWranglerConfig(projectDir, config);
}

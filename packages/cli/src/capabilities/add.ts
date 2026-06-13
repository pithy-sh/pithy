import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { parse, stringify } from "comment-json";

export interface AddCapabilityOptions {
  /** The project root — where pithy.config.ts and wrangler.jsonc live. */
  projectDir: string;
  /** The capability's validated manifest (pithy.manifest.json shape). */
  manifest: CapabilityManifest;
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

async function updateConfig({ projectDir, manifest }: AddCapabilityOptions): Promise<void> {
  const path = join(projectDir, "pithy.config.ts");
  let source = await readFile(path, "utf8");

  const markerLine = source.split("\n").find((line) => line.trimStart().startsWith(MARKER));
  if (markerLine === undefined) {
    throw new InternalError({
      message: `pithy.config.ts has no "${MARKER}" marker.`,
      action: "Restore the managed-region marker inside capabilities: []. Run pithy add again.",
    });
  }

  // Match whole lines, not substrings: `auth(),` is a substring of `myauth(),`,
  // so a substring check would wrongly treat `auth` as already registered.
  const lines = source.split("\n");
  const hasLine = (text: string): boolean => lines.some((line) => line.trim() === text);

  const importLine = `import { ${manifest.name} } from "${manifest.package}/src/index";`;
  if (!hasLine(importLine)) {
    source = `${importLine}\n${source}`;
  }

  const registration = `${manifest.name}(),`;
  if (!hasLine(registration)) {
    const indent = markerLine.slice(0, markerLine.length - markerLine.trimStart().length);
    // A replacement function keeps `$` in the registration literal.
    source = source.replace(markerLine, () => `${indent}${registration}\n${markerLine}`);
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
  const path = join(projectDir, "wrangler.jsonc");
  // comment-json keeps the file's comments and formatting through the round-trip.
  const config = parse(await readFile(path, "utf8")) as unknown as WranglerBindings;

  appendBindings(config, manifest);
  for (const stanza of Object.values(config.env ?? {})) {
    if (stanza) appendBindings(stanza, manifest);
  }

  await writeFile(path, `${stringify(config, null, 2)}\n`);
}

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { InternalError, NotFoundError } from "@pithy-sh/core/src/error/pithyError";

/** Every capability ships under this npm scope; the CLI resolves them by name. */
const SCOPE = "@pithy-sh";
/** The manifest file each capability package ships at its root (strict JSON). */
const MANIFEST_FILE = "pithy.manifest.json";

/** Where a capability's manifest lands once installed into the project. */
function manifestPath(projectDir: string, name: string): string {
  return join(projectDir, "node_modules", SCOPE, name, MANIFEST_FILE);
}

/** Read and validate one manifest file; a malformed payload throws through Zod. */
async function readManifest(path: string): Promise<CapabilityManifest> {
  const raw = await readFile(path, "utf8");
  return CapabilityManifest.parse(JSON.parse(raw));
}

/**
 * Resolve a capability's manifest by reading `pithy.manifest.json` from the
 * installed `@pithy-sh/<name>` package. An uninstalled or unknown name fails
 * with a `PithyError` naming the capability and how to add it.
 */
export async function loadManifest(name: string, projectDir: string): Promise<CapabilityManifest> {
  let raw: string;
  try {
    raw = await readFile(manifestPath(projectDir, name), "utf8");
  } catch {
    throw new NotFoundError({
      message: `No capability named "${name}" is installed.`,
      action: `Run pithy add ${name} to install it.`,
    });
  }
  try {
    return CapabilityManifest.parse(JSON.parse(raw));
  } catch (cause) {
    throw new InternalError({
      message: `${SCOPE}/${name} ships a malformed ${MANIFEST_FILE}.`,
      action: "Reinstall the capability, or report this to its maintainer.",
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

/**
 * Every installed capability's manifest, validated — what `pithy add --list`
 * cross-references against the catalog. Scans `node_modules/@pithy-sh/*` and
 * skips packages that ship no manifest (core, cli). Empty when nothing's installed.
 */
export async function availableManifests(projectDir: string): Promise<CapabilityManifest[]> {
  const scopeDir = join(projectDir, "node_modules", SCOPE);
  let entries: string[];
  try {
    entries = await readdir(scopeDir);
  } catch {
    return []; // no node_modules/@pithy-sh — nothing installed
  }

  const manifests: CapabilityManifest[] = [];
  for (const name of entries) {
    try {
      manifests.push(await readManifest(join(scopeDir, name, MANIFEST_FILE)));
    } catch {
      // No manifest (core, cli) — not a capability. Skip silently.
    }
  }
  return manifests;
}

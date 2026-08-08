// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { InternalError, messageOf, NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import { type CatalogEntry, capabilityPackageDir } from "./catalog";

/** Every capability ships under this npm scope; the CLI resolves them by name. */
const SCOPE = "@pithy-sh";
/** The manifest file each capability package ships at its root (strict JSON). */
const MANIFEST_FILE = "pithy.manifest.json";

/**
 * Where a capability's manifest lands once installed into the project.
 *
 * The directory comes from the catalog's `package`, not from the capability name. Almost always they
 * agree — but `controlplane` ships inside `@pithy-sh/core`, so a name-derived path would look in a
 * package that does not exist. Deriving it from the one field that already records where a capability
 * lives means the exception is stated once (see {@link CatalogEntry.package}) rather than mirrored here.
 */
function manifestPath(projectDir: string, name: string): string {
  return join(projectDir, "node_modules", SCOPE, capabilityPackageDir(name), MANIFEST_FILE);
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
      message: `${SCOPE}/${name} ships a malformed ${MANIFEST_FILE}${firstFault(cause)}`,
      action: "Reinstall the capability, or report this to its maintainer.",
      detail: faults(cause),
    });
  }
}

/** A Zod issue path as a manifest reader would write it: `configOptions[2].key`, not `configOptions.2.key`. */
function fieldPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "<root>";
  return path.reduce<string>(
    (text, segment) =>
      typeof segment === "number"
        ? `${text}[${segment}]`
        : text === ""
          ? String(segment)
          : `${text}.${String(segment)}`,
    "",
  );
}

/**
 * A manifest's faults, one per line as `<path>: <why>` — the `detail` a refusal carries.
 *
 * A `ZodError`'s own `message` is the issue array as JSON, which buries the one sentence that says what
 * is wrong. The path is what names the option: `configOptions[2].key` is the third option, and #174's
 * messages carry the offending key or rationale verbatim beside it.
 */
function faults(cause: unknown): string {
  if (!(cause instanceof z.ZodError)) return messageOf(cause);
  return cause.issues.map((issue) => `${fieldPath(issue.path)}: ${issue.message}`).join("\n");
}

/**
 * The first fault, as a clause for the refusal's `message`.
 *
 * The manifest is named in the message and the option must be too — a capability with a dozen options
 * and one bad key is otherwise a refusal that says only "malformed". The rest of the faults stay in
 * `detail`, which is where throw-site context belongs (CLAUDE.md §Errors).
 */
function firstFault(cause: unknown): string {
  const issue = cause instanceof z.ZodError ? cause.issues[0] : undefined;
  if (!issue) return ".";
  return `: ${fieldPath(issue.path)} — ${issue.message}`;
}

/**
 * Every installed capability's manifest, validated — what `pithy add --list`
 * cross-references against the catalog. Scans `node_modules/@pithy-sh/*` and
 * skips packages that ship no manifest (cli). Empty when nothing's installed.
 *
 * Core does ship one now: the `control-plane` seam is a real capability living inside it, so the
 * directory scan finds `@pithy-sh/core` and reads it out as `controlplane`. Nothing here special-cases
 * that — the scan reads whatever manifest it finds, and the name comes from the file.
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

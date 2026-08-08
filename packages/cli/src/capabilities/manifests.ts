// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { InternalError, messageOf, NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import { errnoOf } from "../project/atomic";
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

/**
 * What reading one package's `pithy.manifest.json` produced.
 *
 * The three answers are three different facts, and collapsing any two of them is what this file kept
 * getting wrong. "The package ships no manifest" is ordinary — `@pithy-sh/cli` is not a capability. "The
 * manifest is there and unusable" is a defect in someone's package, and it has to be said out loud. They
 * were one `catch` for as long as this code existed (#184).
 */
type ManifestRead =
  /** The package ships a manifest, and it parses. */
  | { readonly state: "manifest"; readonly manifest: CapabilityManifest }
  /** The package ships no manifest at all — the one case that may be skipped in silence. */
  | { readonly state: "absent" }
  /** The manifest is there and unusable: unreadable, unparseable, or refused by the schema. */
  | { readonly state: "invalid"; readonly cause: unknown };

/**
 * Read and validate one package's manifest, distinguishing "not there" from "there and broken".
 *
 * **Only `ENOENT` means the package ships no manifest.** Every other errno is a file that exists and did
 * not open — `EACCES` after someone tightened a mode, `EISDIR`, `EIO` on failing disk — and reading those
 * as absence is how a present-but-unreadable capability disappears from `pithy add --list` with nothing
 * said. That is the same rule `readDevVarsSource` states for `.dev.vars` and `readDevJson` for `dev.json`
 * (`../devSecrets/`); this is its third instance in the codebase, and the third for the same reason.
 *
 * Nothing is thrown: the caller decides what a fault means. `loadManifest` was asked for this capability
 * and refuses; `availableManifests` was asked for all of them and must still answer for the rest.
 */
async function readInstalledManifest(path: string): Promise<ManifestRead> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (cause) {
    if (errnoOf(cause) === "ENOENT") return { state: "absent" };
    return { state: "invalid", cause };
  }
  try {
    return { state: "manifest", manifest: CapabilityManifest.parse(JSON.parse(raw)) };
  } catch (cause) {
    return { state: "invalid", cause };
  }
}

/**
 * Resolve a capability's manifest by reading `pithy.manifest.json` from the
 * installed `@pithy-sh/<name>` package. An uninstalled or unknown name fails
 * with a `PithyError` naming the capability and how to add it.
 *
 * A manifest that is there and will not open is **not** "not installed": telling an adopter to run
 * `pithy add auth` when the file is unreadable sends them to the command that just declined to run.
 */
export async function loadManifest(name: string, projectDir: string): Promise<CapabilityManifest> {
  const read = await readInstalledManifest(manifestPath(projectDir, name));
  if (read.state === "manifest") return read.manifest;
  if (read.state === "absent") {
    throw new NotFoundError({
      message: `No capability named "${name}" is installed.`,
      action: `Run pithy add ${name} to install it.`,
    });
  }
  throw new InternalError({
    message: `${SCOPE}/${capabilityPackageDir(name)} ships a malformed ${MANIFEST_FILE}${firstFault(read.cause)}`,
    action: "Reinstall the capability, or report this to its maintainer.",
    detail: faults(read.cause),
  });
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
 * An installed package whose manifest is there and unusable — named, with the reason, for whoever is
 * reporting. A capability with one of these is missing from every answer this module gives, and the
 * point of the type is that it can no longer be missing silently.
 */
export const ManifestFault = z
  .object({
    package: z.string().describe("The package the manifest was read from, as an adopter names it: @pithy-sh/audit."),
    reason: z
      .string()
      .describe(
        "Why it could not be used: the schema's own refusal text where the schema refused it — the same sentence loadManifest gives on the direct path — or the errno where the file would not open.",
      ),
  })
  .describe("An installed package whose pithy.manifest.json is present and unusable, named with the reason.");
export type ManifestFault = z.infer<typeof ManifestFault>;

/** What a scan of `node_modules/@pithy-sh` found: the manifests it could use, and the ones it could not. */
export interface AvailableManifests {
  /** Every installed capability's validated manifest, in directory order. */
  manifests: CapabilityManifest[];
  /** Packages shipping a manifest that is present and unusable. Empty on a healthy install. */
  faults: ManifestFault[];
}

/**
 * Every installed capability's manifest, validated — what `pithy add --list`
 * cross-references against the catalog. Scans `node_modules/@pithy-sh/*` and
 * skips packages that ship no manifest (cli). Empty when nothing's installed.
 *
 * Core does ship one now: the `control-plane` seam is a real capability living inside it, so the
 * directory scan finds `@pithy-sh/core` and reads it out as `controlplane`. Nothing here special-cases
 * that — the scan reads whatever manifest it finds, and the name comes from the file.
 *
 * **A package shipping no manifest is skipped; a package shipping a broken one is reported.** This used
 * to be one `catch` around both, so a manifest the schema refused made the capability vanish from
 * `pithy add --list`, `pithy upgrade` and `pithy doctor` with no message anywhere — the three commands
 * most likely to be run when something is missing were the three that stayed silent (#184). The faults
 * ride back with the manifests rather than throwing, because one broken package must not take the
 * listing of the other fifteen with it.
 */
export async function availableManifests(projectDir: string): Promise<AvailableManifests> {
  const scopeDir = join(projectDir, "node_modules", SCOPE);
  let entries: string[];
  try {
    entries = await readdir(scopeDir);
  } catch {
    return { manifests: [], faults: [] }; // no node_modules/@pithy-sh — nothing installed
  }

  const manifests: CapabilityManifest[] = [];
  const broken: ManifestFault[] = [];
  for (const name of entries) {
    const read = await readInstalledManifest(join(scopeDir, name, MANIFEST_FILE));
    if (read.state === "manifest") manifests.push(read.manifest);
    // Absent is ordinary — `@pithy-sh/cli` is not a capability — and stays silent, as it always has.
    if (read.state === "invalid") broken.push({ package: `${SCOPE}/${name}`, reason: faults(read.cause) });
  }
  return { manifests, faults: broken };
}

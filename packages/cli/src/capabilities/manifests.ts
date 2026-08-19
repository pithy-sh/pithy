// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { InternalError, messageOf, NotFoundError, type PithyError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import { readFileOutcome } from "../project/readOptionalFile";
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
 * **Only `ENOENT` means the package ships no manifest**, and that decision is {@link readFileOutcome}'s
 * now (`../project/readOptionalFile.ts`) rather than a third local copy of it. Reading any other errno as
 * absence is how a present-but-unreadable capability disappears from `pithy add --list` with nothing said
 * (#184); the primitive is where that sentence and its three producers live.
 *
 * The read is taken as a *value* and not as a throw, because the caller decides what a fault means:
 * `loadManifest` was asked for this capability and refuses; `availableManifests` was asked for all of
 * them and must still answer for the rest. Node's own error rides along as `cause`, so {@link faults}
 * reports the errno an adopter can act on.
 */
async function readInstalledManifest(path: string): Promise<ManifestRead> {
  const read = await readFileOutcome(path);
  if (read.state === "absent") return { state: "absent" };
  if (read.state === "unreadable") return { state: "invalid", cause: read.cause };
  try {
    return { state: "manifest", manifest: CapabilityManifest.parse(JSON.parse(read.text)) };
  } catch (cause) {
    return { state: "invalid", cause };
  }
}

/**
 * Resolve a capability's manifest by reading `pithy.manifest.json` from the installed
 * `@pithy-sh/<name>` package. Every failure is a `PithyError` naming the capability.
 *
 * **Three refusals, because there are three failures**, and the rule joining them is one sentence: a
 * refusal never names the command that has just run. A manifest that is there and will not open is not
 * "not installed" — telling an adopter to run `pithy add auth` when the file is unreadable sends them to
 * the command that just declined to run. Neither is a package that is installed and ships no manifest;
 * see {@link absenceRefusal}, which is the half of that sentence #415 paid for.
 */
export async function loadManifest(name: string, projectDir: string): Promise<CapabilityManifest> {
  const read = await readInstalledManifest(manifestPath(projectDir, name));
  if (read.state === "manifest") return read.manifest;
  if (read.state === "absent") throw await absenceRefusal(name, projectDir);
  throw new InternalError({
    message: `${SCOPE}/${capabilityPackageDir(name)} ships a malformed ${MANIFEST_FILE}${firstFault(read.cause)}`,
    action: "Reinstall the capability, or report this to its maintainer.",
    detail: faults(read.cause),
  });
}

/**
 * The refusal for a manifest that is not there — **two different refusals, told apart by whether the
 * package is.**
 *
 * `runAdd` installs the package and *then* reads its manifest, so this branch is reached with the
 * package already in `node_modules`. One sentence covered both cases for as long as the code existed,
 * and it was the wrong one for exactly the case that can be reached from `pithy add`: telling an adopter
 * to run `pithy add rating` is a dead end when `pithy add rating` is what they just ran and what
 * installed the package this is complaining about. `@pithy-sh/matchmaking` and `@pithy-sh/rating` were
 * complete, installable, and unaddable behind that answer (#415).
 *
 * A package that is there and ships no manifest is a defect in the package — either it is not a
 * capability at all, or its author left the one file that makes a capability addable out of the publish.
 * `capabilities/addable.test.ts` is what keeps that from being one of ours again.
 */
async function absenceRefusal(name: string, projectDir: string): Promise<PithyError> {
  const pkg = `${SCOPE}/${capabilityPackageDir(name)}`;
  if (!(await isInstalled(projectDir, name))) {
    return new NotFoundError({
      message: `No capability named "${name}" is installed.`,
      action: `Run pithy add ${name} to install it.`,
    });
  }
  // `core/not_found`, the same code the other branch answers — the classification was never the bug and
  // only the sentence moved. A package that is installed and is not a capability is an adopter naming the
  // wrong thing (`pithy add cloudflare` finds a real @pithy-sh package that ships no manifest), so a 500
  // would send them to *our* logs for an answer that is not in them, and would leave a `--json` caller
  // unable to tell an ordinary mistake from a Pithy defect.
  return new NotFoundError({
    message: `${pkg} is installed and ships no ${MANIFEST_FILE}, so there is no capability named "${name}" to wire.`,
    action: `Check the name against pithy add --list. If ${pkg} is meant to be a capability, report the missing ${MANIFEST_FILE} to its maintainer.`,
    detail: `${manifestPath(projectDir, name)} does not exist, but the package directory does`,
  });
}

/**
 * Whether the package behind a capability name is installed at all.
 *
 * Asked of `package.json` rather than of the directory: npm and bun both leave empty directories behind,
 * and an empty one is not an install. Read through {@link readFileOutcome} so the module's one rule
 * holds here too — only `ENOENT` is absence, and a `package.json` that is there and will not open is a
 * package that is there.
 */
async function isInstalled(projectDir: string, name: string): Promise<boolean> {
  const read = await readFileOutcome(
    join(projectDir, "node_modules", SCOPE, capabilityPackageDir(name), "package.json"),
  );
  return read.state !== "absent";
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

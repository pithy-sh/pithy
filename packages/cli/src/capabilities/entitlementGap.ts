// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join, relative, sep } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { gateCallSites } from "@pithy-sh/core/src/entitlement/gateScan";
import { readSource, sourcePaths } from "../ci/sourceFiles";

/**
 * The entitlement composition check — the CLI half of the entitlement seam.
 *
 * The seam fails closed: with no provider composed, `c.var.entitlements` holds nothing and every
 * `requireEntitlement()` denies. That is the right runtime behaviour and the wrong developer
 * experience, because the runtime cannot tell the two cases apart. A legitimately unentitled user and
 * a Worker that forgot to compose `payments` produce the identical 403, so the second one ships,
 * paywalls every paid route shut, and is diagnosed from support tickets.
 *
 * So the mistake is caught where it is still cheap: `pithy doctor` and `pithy dev` compare the gates in
 * a Worker's own source against whether any capability it composes declares
 * {@link Capability.providesEntitlements}. Runtime denial stays the backstop; this is the check.
 *
 * What is left here is the filesystem half: which files to read, and which to leave alone. Deciding
 * whether a given source gates is `@pithy-sh/core/src/entitlement/gateScan` — pure, and importable from a
 * Workers-typed program, which is the half an adopter asserting their own rules needs.
 */

/** Source extensions a Worker's routes can live in. `.tsx` is included — a route file may render. */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"];

/** A file a Worker's routes could live in, by base name. */
function isWorkerSource(name: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

/**
 * The Worker's own source files that gate a route on an entitlement, relative to the Worker directory
 * and sorted. Only `src/` is scanned: `node_modules` holds the seam's own source, so scanning it would
 * report a gap on every project that installed `@pithy-sh/core`.
 *
 * The traversal is `ci/sourceFiles.ts` — the one walk in this repository, which skips dependencies, build
 * output and dotted directories, never descends a symlink, and treats a directory it cannot list and a file
 * that vanished between the listing and the read as skipped rather than fatal. This is the one of the five
 * private walks #202 found that was not a test: it runs inside `pithy doctor` and `pithy dev`, against a
 * directory the adopter is editing while it runs, so a throw here is a command that fails on a file the
 * adopter had just moved. Synchronous, like the walk it now shares; the signature stays async because the
 * scan it feeds is the caller's contract.
 */
export async function entitlementGates(workerDir: string): Promise<string[]> {
  const sources: Record<string, string> = {};
  for (const path of sourcePaths(join(workerDir, "src"), { keep: isWorkerSource })) {
    const text = readSource(path);
    if (text !== null) sources[relative(workerDir, path).split(sep).join("/")] = text;
  }
  return gateCallSites(sources);
}

/** The composed capability that fills the entitlement seam, by name, or null when none does. */
export function entitlementProvider(capabilities: readonly Capability[]): string | null {
  return capabilities.find((capability) => capability.providesEntitlements === true)?.name ?? null;
}

/**
 * The gap: the Worker's gating source files when nothing it composes provides entitlements. Empty
 * otherwise — including when there are no gates at all, which is most projects, and when a provider is
 * composed but nothing gates yet, which is a project mid-build rather than a mistake.
 */
export async function findEntitlementGap(workerDir: string, capabilities: readonly Capability[]): Promise<string[]> {
  if (entitlementProvider(capabilities) !== null) return [];
  return entitlementGates(workerDir);
}

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { gateCallSites } from "@pithy-sh/core/src/entitlement/gateScan";

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

/** Directories never scanned: dependencies, build output, and caches. */
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".turbo", ".wrangler", "coverage", ".git"]);

/** Every scannable source file under `dir`, recursively, as paths relative to `dir`. */
async function sourceFiles(dir: string, root: string): Promise<string[]> {
  // No such directory — a Worker need not have a `src/`, and a health check never fails on that.
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      found.push(...(await sourceFiles(join(dir, entry.name), root)));
    } else if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      found.push(relative(root, join(dir, entry.name)).split(sep).join("/"));
    }
  }
  return found;
}

/**
 * The Worker's own source files that gate a route on an entitlement, relative to the Worker directory
 * and sorted. Only `src/` is scanned: `node_modules` holds the seam's own source, so scanning it would
 * report a gap on every project that installed `@pithy-sh/core`.
 */
export async function entitlementGates(workerDir: string): Promise<string[]> {
  const files = await sourceFiles(join(workerDir, "src"), workerDir);
  const sources = await Promise.all(files.map(async (file) => [file, await readFile(join(workerDir, file), "utf8")]));
  return gateCallSites(Object.fromEntries(sources));
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

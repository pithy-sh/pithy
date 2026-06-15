/**
 * The built-in discovery catalog — the capabilities `pithy add --list` shows
 * before anything is installed. Hand-maintained as capabilities ship; the full
 * manifest is still read from the package after install (manifests.ts). Names and
 * rationales track docs/CLI.md §4.2.
 */

export interface CatalogEntry {
  /** Capability name, the `pithy add <name>` argument. */
  name: string;
  /** The npm package providing it, always `@pithy-sh/<name>`. */
  package: string;
  /** One-line rationale — why a project would enable this. */
  whenToEnable: string;
}

export const CATALOG: readonly CatalogEntry[] = [
  { name: "auth", package: "@pithy-sh/auth", whenToEnable: "Authentication and session management." },
  { name: "storage", package: "@pithy-sh/storage", whenToEnable: "R2-backed object storage." },
  { name: "leaderboard", package: "@pithy-sh/leaderboard", whenToEnable: "Multi-tenant ranking." },
  { name: "vector", package: "@pithy-sh/vector", whenToEnable: "Vectorize wrapper for embeddings and search." },
  { name: "jobs", package: "@pithy-sh/jobs", whenToEnable: "Scheduled and queued background work." },
];

/** A catalog entry tagged with whether the project already has it installed. */
export interface CatalogListing extends CatalogEntry {
  installed: boolean;
}

/** Tag every catalog entry with its installed state, in catalog order. */
export function buildCatalogListing(installed: ReadonlySet<string>): CatalogListing[] {
  return CATALOG.map((entry) => ({ ...entry, installed: installed.has(entry.name) }));
}

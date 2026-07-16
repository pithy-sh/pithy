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
  {
    name: "secrets",
    package: "@pithy-sh/secrets",
    whenToEnable: "Encrypted secret storage with a worker-only master key and automatic at-rest key rotation.",
  },
  {
    name: "email",
    package: "@pithy-sh/email",
    whenToEnable:
      "Transactional and lifecycle email — magic link, OTP, welcome, alerts — sent as durable, tracked jobs.",
  },
  {
    name: "turnstile",
    package: "@pithy-sh/turnstile",
    whenToEnable:
      "Stop bots at login, signup, and form-submit points with a Cloudflare Turnstile humanity check — stacked on any route, with test keys wired automatically in dev and staging.",
  },
  {
    name: "audit",
    package: "@pithy-sh/audit",
    whenToEnable:
      "A queryable audit trail of security-relevant actions — who did what, when, and whether it succeeded — recorded from Workers and the CLI, attributed to the right actor.",
  },
  { name: "storage", package: "@pithy-sh/storage", whenToEnable: "R2-backed object storage." },
  {
    name: "media",
    package: "@pithy-sh/media",
    whenToEnable:
      "Store, track, and enrich media — images, video, audio, and documents — with direct-upload URLs and opt-in AI alt text, transcription, and text extraction. Config picks the backend; the package does the rest.",
  },
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

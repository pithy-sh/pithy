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
  {
    name: "leaderboard",
    package: "@pithy-sh/leaderboard",
    whenToEnable:
      "Rank your players — daily, weekly, calendar-month, calendar-year, or all-time, because a board's window is a CRON expression rather than a fixed list. Boards are config. Closed windows stay in your own D1 for as long as you ask, in plain SQL you can join against your own tables. Writes are server-authoritative by default.",
  },
  {
    name: "multiplayer",
    package: "@pithy-sh/multiplayer",
    whenToEnable:
      "Authoritative, turn-based multiplayer sessions on Cloudflare — the server holds the game state no client can be trusted with, resolves it, and writes a durable result to your own D1. Games are pluggable: three example games ship — `battle` (simultaneous), `connect-n` (tic-tac-toe/Connect Four), `craps` (a wagering table) — each built on a reusable pattern helper you can layer your own game on, and you can register your own. Supports N players. Includes a wagering stack: provably-fair dice, persistent tables (buy in/cash out between rounds), and wallet-settled bets — pair with @pithy-sh/wallet. Pithy's first Durable Object: the CLI wires the DO binding and its class migration tag for you. Not rooms, chat, or real-time netcode — use Cloudflare's PartyServer for those. Sessions bind to an authenticated user, so add auth too.",
  },
  {
    name: "wallet",
    package: "@pithy-sh/wallet",
    whenToEnable:
      "Give every player a balance — a per-user ledger for chips, gold, gems, credits, or tokens, in your own D1. Every movement is atomic, idempotent (a payout delivered twice pays once), and overdraft-safe by a database CHECK constraint. Holds reserve a stake the moment a bet is placed, then release or capture it — which is what makes wagering safe, so it pairs with @pithy-sh/multiplayer. Currency-agnostic; whether the units map to money, and any regulation that implies, is yours. Reads scope to the caller; moving another player's balance needs the admin scope, so add auth too.",
  },
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

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The built-in discovery catalog — the capabilities `pithy add --list` shows
 * before anything is installed. Hand-maintained as capabilities ship; the full
 * manifest is still read from the package after install (manifests.ts). Names and
 * rationales track docs/CLI.md §4.2.
 */

export interface CatalogEntry {
  /** Capability name, the `pithy add <name>` argument. */
  name: string;
  /**
   * The npm package providing it — `@pithy-sh/<name>` for all but one.
   *
   * `controlplane` ships inside `@pithy-sh/core`, because every capability contributing admin routes
   * imports its guard, and a capability may depend on a core seam but never on a sibling package. This
   * field is therefore the authority on where a capability's manifest lives, and `manifests.ts` resolves
   * the directory from it rather than from the name — one place to state the exception, so the two
   * cannot drift.
   */
  package: string;
  /** One-line rationale — why a project would enable this. */
  whenToEnable: string;
}

/** The npm scope every capability ships under. */
export const CAPABILITY_SCOPE = "@pithy-sh";

/**
 * The npm package a capability ships in — the catalog's `package`, or `@pithy-sh/<name>` when the
 * catalog does not know it (an installed package that predates a catalog entry).
 *
 * **Use this rather than interpolating the name.** `@pithy-sh/${capability}` was the rule everywhere
 * until `controlplane` shipped inside `@pithy-sh/core`, and every remaining hand-rolled interpolation
 * is a place that silently reaches for a package that does not exist.
 */
export function capabilityPackageName(name: string): string {
  return CATALOG.find((candidate) => candidate.name === name)?.package ?? `${CAPABILITY_SCOPE}/${name}`;
}

/**
 * The package directory a capability's files live in — {@link capabilityPackageName} minus the scope.
 * This is the `node_modules/@pithy-sh/<dir>` a manifest is read from.
 */
export function capabilityPackageDir(name: string): string {
  return capabilityPackageName(name).slice(`${CAPABILITY_SCOPE}/`.length);
}

/**
 * Packages that host more than the one capability named after them, and must therefore never be
 * uninstalled when that capability is removed.
 *
 * `@pithy-sh/core` is every capability's dependency and the runtime the app is built on. Removing
 * `controlplane` unwires the seam; uninstalling core would take the project with it.
 */
export function isSharedCapabilityPackage(pkg: string): boolean {
  return pkg === `${CAPABILITY_SCOPE}/core`;
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
  {
    name: "storage",
    package: "@pithy-sh/storage",
    whenToEnable:
      "Put your users' files in your own R2, behind one ObjectStore seam any capability can hold — multipart uploads for the large ones, Range, ETag, and Content-Disposition streaming for the rest, per-owner scoping, byte quotas, server-side copy, revocable share links, and a daily workflow that reconciles orphaned rows and orphaned objects in both directions. Uploaded bytes are treated as untrusted on the way out: nosniff and a locked-down CSP on every object response, and an active type (HTML, SVG, anything +xml, script) served as an attachment whatever was stored — so a user's file cannot execute on your origin. Keys are server-derived and opaque, so a client can never name an object or guess the one beside it; you supply a logical path, and that path is stored, indexed, and listable. It takes no position on what the bytes are — no transcoding, no thumbnails, no AI. That is @pithy-sh/media, which already presigns through this ObjectStore against its own bucket and credential name, and inherits none of these tables or routes for doing so. `pithy add storage` writes the bindings and touches no Cloudflare account; `pithy storage provision` creates the bucket. Objects belong to an authenticated owner, so add auth too.",
  },
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
      "Authoritative, turn-based multiplayer sessions on Cloudflare — the server holds the game state no client can be trusted with, resolves it, and writes a durable result to your own D1. Games are pluggable: three example games ship — `battle` (simultaneous), `connect-n` (tic-tac-toe/Connect Four), `craps` (a wagering table) — each built on a reusable pattern helper you can layer your own game on, and you can register your own. Supports N players. Includes a wagering stack: provably-fair dice, persistent tables (buy in/cash out between rounds), and ledger-settled bets — pair with @pithy-sh/ledger. Pithy's first Durable Object: the CLI wires the DO binding and its class migration tag for you. Not rooms, chat, or real-time netcode — use Cloudflare's PartyServer for those. Sessions bind to an authenticated user, so add auth too.",
  },
  {
    name: "rating",
    package: "@pithy-sh/rating",
    whenToEnable:
      "Two numbers per player, per pool, in your own D1: a skill rating (MMR) that moves both ways with every result and feeds matchmaking, and an experience total (XP) that only ever rises and drives rank. They are separate on purpose — one number cannot both rank a player fairly and reward them for turning up. The algorithm is a choice rather than a hardcode: `elo` (1v1, transparent, one tunable), `glicko` (Glicko-2, 1v1, carrying an uncertainty term so a player returning on stale form is not rated as if they never left), and `trueskill` (any roster, and the only one that rates teams) ship built in, and registerRatingAlgorithm takes your own. Wiring a 1v1-only algorithm to a four-player game fails on deploy, not on the first recorded result. Pools are named, so several games can share one ladder or each can keep its own — and a pool is what @pithy-sh/matchmaking buckets its open queue on, which makes this the skill source that capability needs. Recording an outcome is server-authoritative by default and needs the rating:record scope, so a device cannot report that it won. This is the input system @pithy-sh/leaderboard deliberately left out: a leaderboard ranks what has happened, a rating estimates what will. Ratings bind to an authenticated player, so add auth too — without it every route is denied.",
  },
  {
    name: "matchmaking",
    package: "@pithy-sh/matchmaking",
    whenToEnable:
      "How players find each other. @pithy-sh/multiplayer gives you an authoritative session once players are in it; this is the four ways they get there, and every one of them ends at a session id. A room code — short, shareable, short-lived, limited-use — for playing with someone who is already beside you. A direct invite by email or screen name, pending until the invitee accepts. A symmetric friend graph formed by mutual accept. And an open queue: one Durable Object per game pairs waiting players, bucketed by Cloudflare's own edge geolocation and by skill read from @pithy-sh/rating, widening each player's skill band the longer they wait until any opponent qualifies. A second Durable Object holds every online player's WebSocket and pushes match-found, invite-received, and friend-request in real time, over the Hibernation API so a connection waiting on nothing bills no duration. Two Durable Objects means two bindings and two class migration tags across every environment, and the CLI writes all of it — that wiring is the reason this is a capability rather than a snippet. Nothing here is a hard dependency: without auth every route is denied, without rating the queue buckets by region alone, without multiplayer session minting is off. Add auth at minimum, and read packages/matchmaking/docs/costs.md before production — a presence socket is cheap and a busy queue's alarm cadence is the dial that decides how cheap.",
  },
  {
    name: "ledger",
    package: "@pithy-sh/ledger",
    whenToEnable:
      "Give every player a balance — a per-user ledger for chips, gold, gems, credits, or tokens, in your own D1. Every movement is atomic, idempotent (a payout delivered twice pays once), and overdraft-safe by a database CHECK constraint. Holds reserve a stake the moment a bet is placed, then release or capture it — which is what makes wagering safe, so it pairs with @pithy-sh/multiplayer. Currency-agnostic; whether the units map to money, and any regulation that implies, is yours. Reads scope to the caller; moving another player's balance needs the admin scope, so add auth too.",
  },
  {
    name: "vector",
    package: "@pithy-sh/vector",
    whenToEnable:
      "Semantic search over your own Vectorize index, with the metadata half taken seriously. Vectorize returns partial results — silently — when you filter on a field whose metadata index was created after the vectors were written, and it stops at ten metadata indexes per index. Both fail quietly, in production. So filterable fields are a schema decision here: declare them once, and the package provisions the metadata indexes from that schema, types every filter against it, refuses a filter on a field the schema does not mark, and reconciles the live index against the config on every `pithy vector provision` — waiting for each metadata index to go live before anything writes a vector. `provision` records what it observed, and the Worker refuses to boot when the config declares a filterable field that record does not have, so a schema edited and deployed without re-provisioning fails naming the field rather than returning short results. Embeddings come from Workers AI, the model is pinned per index for writes and queries alike, and `pithy vector reprocess` re-embeds what a model change left behind. Documents live in your own D1; chunking stays yours. Pairs with @pithy-sh/media, whose extracted text and transcripts are the obvious thing to embed.",
  },
  {
    name: "payments",
    package: "@pithy-sh/payments",
    whenToEnable:
      "Four payment rails — Apple, Google, Stripe, Lemon Squeezy — resolving to one cross-rail entitlement, in your own Worker and your own D1. Buy Pro on iOS, be entitled on the web, with no hosted data plane holding your purchase history. Lemon Squeezy is the merchant of record on its rail, so global sales tax, EU VAT, invoicing and dunning are its problem rather than yours. A product is not an entitlement: `pro_monthly` and `pro_annual`, across four stores' catalogs, grant one key — `pro` — and gating code names the key, never a SKU. Every write converges on one idempotent projection keyed on (rail, provider transaction id), so a client submission, a provider webhook, and a reconciliation pass produce the identical row: a dropped client call costs nothing and a replayed webhook changes nothing. The projection is monotonic on the provider's own event time, because providers do not guarantee delivery order and a stale `expired` arriving after the `renewed` that superseded it would silently revoke a paying subscriber. Sandbox purchases are tracked as sandbox and never grant a production entitlement. A cron Workflow re-verifies what the webhooks missed, because webhook-only systems rot silently. Add auth — every route belongs to an authenticated purchaser or a machine proving authenticity, and there are no public routes. Add secrets: the four rails' credentials are read through it, so payments will not compose without it. Ledger fulfillment is opt-in per product; most products never touch a balance.",
  },
  {
    name: "support",
    package: "@pithy-sh/support",
    whenToEnable:
      "An inbound support inbox that lands mail in your own D1, classifies it on your own Workers AI binding, and links each sender to the account and purchases your app already knows about. Support is the employee a solo developer cannot hire, and every piece needed to build it was already in the catalog. Mail arrives through Cloudflare Email Routing, is parsed (multipart and attachments included), threaded on In-Reply-To and References so a conversation stays one conversation, and classified three ways at once \u2014 category, priority, sentiment \u2014 which makes a sortable inbox rather than a labelled one. The taxonomy is federated: eight categories ship, and you add your own with defineSupportCategories. Classification runs on your binding, so the inference lands on your bill and your customers' support mail never leaves your infrastructure. Everything is derived from immutable mail: a wrong classification is recomputed, not repaired, and there is no assignment and no status workflow, because that is a helpdesk product and this is not one. Replies go out through @pithy-sh/email carrying your domain, your DKIM, and correct threading headers \u2014 which only the Worker can set. The admin surface is control-plane only and default-denied. Cloudflare Email Routing takes over a zone's MX, so use a subdomain (support@help.yourdomain.com) and never your apex, or you will move your real mail off your existing provider.",
  },
  {
    name: "testers",
    package: "@pithy-sh/testers",
    whenToEnable:
      "Google Play makes every new personal developer account run a closed test with at least 12 testers opted in for 14 continuous days before it will grant production access, and there is no screen anywhere that tells you where you stand. Lose one tester on day nine and the clock effectively starts again. This runs that process: a cohort with a target and a window, a roster you invite by email from your own domain, a one-tap confirmation link that needs no account, and a fourteen-day clock replayed from your own event log so a correction is a recomputation rather than an overwrite. The clock is honest about what it is. Pithy's count is an estimate from your own invite records; Google's count is authoritative and no API exposes it — not the roster, not the number, not a tester quietly opting out — so every figure derived from it is named `estimated`, the response carries that sentence as a required field, and nothing here claims to read the console. What Pithy can read is activity, and that is the part nobody else has: resolve each tester to their user through `@pithy-sh/auth` and you learn who has actually opened the app, so a tester dark for eight days shows up on day eight rather than on day fourteen when the count finally moves. A daily Workflow advances state, chases whoever needs chasing under a mandatory per-tester cooldown, and writes one snapshot per cohort per day — which is what makes the trend chartable at all, because activity cannot be reconstructed after the fact the way an event log can. Every nudge ships default copy, so this works from the CLI with no dashboard; a control-plane caller may override the words as plain text and never as markup, because those words go out over your own DKIM signature.",
  },
  {
    name: "controlplane",
    package: "@pithy-sh/core",
    whenToEnable:
      "Let a management client — the Pithy dashboard, or one you write yourself — reach into your own Worker, with no data plane in between. Present and denying by default: with no connection registered every route answers 403, and there is no backdoor to open. `pithy dashboard connect --env prod` grants exactly the operations you name, per environment, so a staging credential can never touch production. The credential is asymmetric — the client holds a private key, you hold and can revoke the public one — so nothing secret of yours ever leaves your infrastructure and a breach on their side is not a breach on yours. Rotation is append, prove, then expire, never replace, so a rotation that fails leaves the old key working instead of locking anyone out; revocation is a row you delete, immediate and needing nothing from them. Every call carries a signed 60-second single-scope token bound to a digest of its own body, is checked for replay, and lands in your audit trail under its own actor kind, so what the dashboard did is answerable separately from what your users did. Capabilities contribute their own admin routes behind it — payments puts manual entitlement grant and revoke here — so adding one adds its management surface with nothing to wire. It ships inside @pithy-sh/core, so it is already installed; adding it composes it, and connecting a client is the deliberate second step.",
  },
];

/** A catalog entry tagged with whether the project already has it installed. */
export interface CatalogListing extends CatalogEntry {
  installed: boolean;
}

/** Tag every catalog entry with its installed state, in catalog order. */
export function buildCatalogListing(installed: ReadonlySet<string>): CatalogListing[] {
  return CATALOG.map((entry) => ({ ...entry, installed: installed.has(entry.name) }));
}

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { baseUrlFor, domainFor, type WorkerDomains } from "@pithy-sh/core/src/naming/domains";

/**
 * The one resolver for "where does this Worker answer".
 *
 * ## What it replaced
 *
 * Three derivations, none of which reconciled with the others:
 *
 * - `deriveBaseUrl` in `envInventory.ts` scraped the first `routes`/`route` pattern out of
 *   `wrangler.jsonc`, returning the literal `"local"` for `dev` and `null` when no route was declared.
 * - `pithy email provision` and `pithy turnstile` each read a hand-set `vars.BASE_URL` — with two
 *   different parsers, two different error messages, and no validation in one of them.
 * - `pithy dashboard connect` derived nothing at all and simply demanded `--worker-url`.
 *
 * `email provision` refused to run without `vars.BASE_URL` while `pithy env` printed a URL derived from
 * the routes beside it, and nothing anywhere noticed when the two disagreed. That is a defect waiting to
 * be hit; before the first customer it is a refactor, and after it is a migration for every project that
 * guessed differently.
 *
 * ## The order, and why it is this order
 *
 * 1. **The `domains` declaration** for this Worker and environment — authoritative, because it is the
 *    thing the `routes` entry and `BASE_URL` are *generated from*. If it is present, everything else is
 *    downstream of it and cannot disagree without being stale.
 * 2. **The first `routes`/`route` pattern**, for projects that predate the declaration or hand-edit
 *    wrangler. This is what keeps the change non-breaking: an adopter who wrote their own route keeps
 *    working and is never told to migrate.
 * 3. **`vars.BASE_URL`**, for a project that set it by hand and declared no route. Last among the
 *    config sources because it is the one an adopter can most easily leave stale — it used to be the
 *    only input, so it is exactly where a contradiction lives.
 *
 * `workers.dev` is deliberately **not** in this list. It is resolved separately and only where an
 * account is reachable and has the subdomain enabled, because it can be disabled per account and
 * commonly is in production — a fallback that is weakest in the environment that counts is not a
 * fallback worth silently depending on.
 *
 * ## Why the source is reported, not just the URL
 *
 * Every consumer either shows a human what it found (`pithy env`, `pithy dashboard connect` confirming
 * an address before registering it) or needs to explain why it found nothing. "Where did this come
 * from" is the first question in both cases, and reconstructing it after the fact is what produced
 * three resolvers in the first place.
 */

/** Where a resolved address came from. Ordered by authority, most authoritative first. */
export type WorkerAddressSource = "declaration" | "route" | "var" | "workers.dev";

/** A resolved address, and the evidence for it. */
export interface WorkerAddress {
  /** The absolute base URL, e.g. `https://api.example.com`. Never a bare hostname. */
  url: string;
  /** Which input produced it. */
  source: WorkerAddressSource;
  /** The hostname alone — what Turnstile binds a widget to, and what a route pattern is. */
  hostname: string;
}

/** The slice of a wrangler stanza an address can be read out of. */
export interface AddressStanza {
  route?: string | { pattern?: string };
  routes?: (string | { pattern?: string })[];
  vars?: Record<string, unknown>;
}

/** What the resolver reads. Every field optional — a project may have none of them. */
export interface ResolveWorkerAddressInput {
  /** The environment being resolved. `dev` never resolves to a public address. */
  environment: string;
  /** The Worker's declared `domains` block, when it has one. */
  domains?: WorkerDomains | undefined;
  /** The `wrangler.jsonc` stanza for this environment (the top-level doc is the `dev` stanza). */
  stanza?: AddressStanza | undefined;
}

/** One route entry reduced to its pattern, in either form wrangler accepts. */
function routePattern(route: string | { pattern?: string } | undefined): string | null {
  if (typeof route === "string") return route.length > 0 ? route : null;
  const pattern = route?.pattern;
  return typeof pattern === "string" && pattern.length > 0 ? pattern : null;
}

/**
 * Turn whatever an input held into an absolute URL and a hostname, or null.
 *
 * Accepts both shapes on purpose: a route pattern is a bare hostname (possibly with a path, which is
 * dropped), while a hand-set `vars.BASE_URL` is usually a full URL and occasionally a bare hostname.
 * Anything unparseable is null rather than a throw — the resolver's whole contract is that it reports
 * what it found, and a malformed value found is the same as nothing found for the caller's purposes.
 */
function toAddress(value: string, source: WorkerAddressSource): WorkerAddress | null {
  const candidate = /^https?:\/\//.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(candidate);
    if (!url.hostname) return null;
    return { url: `https://${url.hostname}`, source, hostname: url.hostname };
  } catch {
    return null;
  }
}

/**
 * Resolve a Worker's public address for one environment from config alone — no network.
 *
 * Offline by construction, because `pithy env` is contractually read-only and always exits 0: a resolver
 * that reached Cloudflare would turn it into a command that fails without credentials. The `workers.dev`
 * tier is a separate, explicitly asynchronous step for the callers that can afford it.
 *
 * Returns null for `dev` always. There is no public address for a local run — the answer is
 * `http://localhost:<port>` from the port the feature pinned, which lives in `.dev.config.json` and is
 * not this function's business.
 */
export function resolveWorkerAddress(input: ResolveWorkerAddressInput): WorkerAddress | null {
  if (input.environment === "dev") return null;

  const declared = domainFor(input.domains, input.environment);
  if (declared) {
    return { url: baseUrlFor(declared), source: "declaration", hostname: declared.pattern };
  }

  const stanza = input.stanza;
  const pattern = routePattern(stanza?.routes?.[0]) ?? routePattern(stanza?.route);
  if (pattern) {
    const fromRoute = toAddress(pattern, "route");
    if (fromRoute) return fromRoute;
  }

  const baseUrl = stanza?.vars?.BASE_URL;
  if (typeof baseUrl === "string" && baseUrl.length > 0) {
    const fromVar = toAddress(baseUrl, "var");
    if (fromVar) return fromVar;
  }

  return null;
}

/**
 * The `workers.dev` address for a script, when the account has a subdomain.
 *
 * Separate from {@link resolveWorkerAddress} and never folded into it, for two reasons. It needs the
 * network, and the resolver must stay offline. And it is the weakest tier by a distance: `workers.dev`
 * can be disabled per account and commonly is in production, where a live domain is the only intended
 * entry point — so a caller has to opt into it deliberately rather than inherit it as a default that
 * quietly stops working in exactly the environment that matters.
 *
 * `subdomain` is whatever `CloudflareWorkersManager.accountSubdomain()` returned, which is already null
 * when the account has none.
 */
export function workersDevAddress(scriptName: string, subdomain: string | null): WorkerAddress | null {
  if (!subdomain || !scriptName) return null;
  return {
    url: `https://${scriptName}.${subdomain}.workers.dev`,
    source: "workers.dev",
    hostname: `${scriptName}.${subdomain}.workers.dev`,
  };
}

/** How a resolved address reads in CLI output — the URL, and where it came from. */
export function describeAddressSource(source: WorkerAddressSource): string {
  switch (source) {
    case "declaration":
      return "declared in pithy.config.ts";
    case "route":
      return "from the route in wrangler.jsonc";
    case "var":
      return "from vars.BASE_URL in wrangler.jsonc";
    case "workers.dev":
      return "your workers.dev subdomain";
  }
}

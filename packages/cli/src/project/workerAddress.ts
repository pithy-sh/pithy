// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { featureOrigin, resolveOrigin, type WorkerDomains } from "@pithy-sh/core/src/naming/domains";
import { FEATURE_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { BASE_URL_VAR } from "@pithy-sh/core/src/worker/identity";
import { parse } from "comment-json";
import { wranglerConfigPath } from "../provision/featureConfig";

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
 * `workers.dev` is deliberately **not** in this list for a declared environment. It is resolved separately
 * and only where an account is reachable and has the subdomain enabled, because it can be disabled per
 * account and commonly is in production — a fallback that is weakest in the environment that counts is not
 * a fallback worth silently depending on.
 *
 * ## A feature environment is the exception, and it is not a fallback there (#643)
 *
 * A feature has no domain and never will: its hostname is composed from the branch. Its script name is its
 * `workers.dev` prefix, so `https://<script>.<account subdomain>.workers.dev` **is** its address — the only
 * one it has. So for `feature`, and only for `feature`, the order is: that derivation, from the stanza's `name`
 * and the `subdomain` a caller looked up, then the address provisioning stamped as `vars.BASE_URL` — which is
 * the same derivation, written down for the callers that have no account to ask. Never a route: a route on a
 * feature is a domain another environment owns. The stamp is read through core's `featureOrigin`, so a `BASE_URL` the feature
 * inherited from the top level (production's, most likely) is never mistaken for the feature's own.
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
  /** The script name this stanza deploys as — a feature's `workers.dev` prefix. */
  name?: string;
  route?: string | { pattern?: string };
  routes?: (string | { pattern?: string })[];
  vars?: Record<string, unknown>;
  /** wrangler's `workers_dev`. `false` means the Worker answers on no `workers.dev` address at all. */
  workers_dev?: unknown;
}

/** What the resolver reads. Every field optional — a project may have none of them. */
export interface ResolveWorkerAddressInput {
  /** The environment being resolved. `dev` never resolves to a public address. */
  environment: string;
  /** The Worker's declared `domains` block, when it has one. */
  domains?: WorkerDomains | undefined;
  /** The `wrangler.jsonc` stanza for this environment (the top-level doc is the `dev` stanza). */
  stanza?: AddressStanza | undefined;
  /**
   * The account's `workers.dev` subdomain, when the caller looked it up — `CloudflareWorkersManager.
   * accountSubdomain()`, through `accountWorkersSubdomain`. Read for a feature environment only. The resolver
   * never looks it up itself: it stays offline, so the caller decides whether reaching the account is
   * affordable.
   */
  subdomain?: string | null | undefined;
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
  if (input.environment === FEATURE_ENVIRONMENT) return resolveFeatureAddress(input);

  // Through the shared resolver, so the answer this reports and the answer an adopter's config composes
  // are the same function (#256). `declared` is what keeps the fallback out of here: a `LOCAL_ORIGIN`
  // returned as an address would stop the route and `BASE_URL` tiers below from ever being reached.
  const declared = resolveOrigin(input.environment, input.domains);
  if (declared.declared) {
    return { url: declared.origin, source: "declaration", hostname: declared.hostname };
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
 * A feature environment's address: its `workers.dev` one, when wrangler would give it one — derived, then stamped.
 * See the module comment for why a feature is the one environment `workers.dev` answers for.
 *
 * **Never a route (#643).** A feature's only address is the one composed from its branch. A route on its
 * stanza is a custom domain some other environment owns — inherited from the top level, since wrangler carries
 * `routes` into every environment that does not set its own — and a branch deploy that took it would be serving
 * that domain. Provisioning writes `routes: []` into every feature stanza so it never does.
 *
 * **And only when wrangler gives one.** wrangler's own rule: `workers_dev` when stated, and otherwise on exactly
 * when the Worker has no routes. A stanza that inherited routes and states no `workers_dev` deploys with no
 * `workers.dev` address at all, so none is derived or read for it.
 */
function resolveFeatureAddress(input: ResolveWorkerAddressInput): WorkerAddress | null {
  const stanza = input.stanza;
  const routes = stanza?.routes ?? (stanza?.route === undefined ? [] : [stanza.route]);
  const workersDev = stanza?.workers_dev ?? routes.length === 0;
  if (workersDev !== true) return null;

  const derived = workersDevAddress(stanza?.name ?? "", input.subdomain ?? null);
  if (derived) return derived;

  const stamped = stanza?.vars?.[BASE_URL_VAR];
  const origin = featureOrigin(typeof stamped === "string" ? stamped : undefined);
  return origin ? { url: origin.origin, source: "workers.dev", hostname: origin.hostname } : null;
}

/**
 * The stanza an address is read out of, for one Worker and one environment — from the file that describes
 * that environment: the generated config for a feature, the tracked `wrangler.jsonc` for everything else.
 *
 * **One reader, because the callers each read the tracked file (#643).** A feature's stanza is never there —
 * provisioning writes it under `.wrangler/` — so every caller asking "where does the feature answer" found no
 * stanza, and so no address. `undefined` for a missing file, an unparseable one, or an absent stanza: the
 * resolver's contract is to report what it found, and a caller that needs one says so in its own words.
 */
export async function readAddressStanza(workerDir: string, env: string): Promise<AddressStanza | undefined> {
  try {
    const config = parse(await readFile(wranglerConfigPath(workerDir, env), "utf8")) as
      | (AddressStanza & { env?: Record<string, AddressStanza | undefined> })
      | null;
    const stanza = config?.env?.[env];
    return stanza ? inheritAddressKeys(config, stanza, env) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A stanza as wrangler deploys it, for the keys an address depends on: its own, else the top level's where
 * wrangler inherits one.
 *
 * **`workers_dev` is inheritable (#643).** wrangler carries a top-level `workers_dev` into every environment
 * that does not set its own, and provisioning never repeats it into a generated stanza — so a stanza read
 * alone said nothing, a feature derived a `workers.dev` address, and the address stamped was one the deployed
 * Worker never answers on.
 *
 * **So are `routes` and `route`, and for a feature that is read too.** wrangler inherits each of them into an
 * environment that does not set it, and a top-level route on a feature stanza means both that the feature would
 * take a custom domain and — with no `workers_dev` — that it gets no `workers.dev` address. A declared
 * environment's address is read from its own stanza, as it always was: its `domains` declaration and its own
 * routes are what it answers on, and #89 holds that nothing falls back from them. `vars` is never inherited.
 */
export function inheritAddressKeys(
  top: AddressStanza | null | undefined,
  stanza: AddressStanza,
  env?: string,
): AddressStanza {
  if (top === null || top === undefined) return stanza;
  const keys = env === FEATURE_ENVIRONMENT ? (["workers_dev", "routes", "route"] as const) : (["workers_dev"] as const);
  const inherited: AddressStanza = { ...stanza };
  let changed = false;
  for (const key of keys) {
    if (Object.hasOwn(stanza, key) || !Object.hasOwn(top, key)) continue;
    Object.assign(inherited, { [key]: top[key] });
    changed = true;
  }
  return changed ? inherited : stanza;
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

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { baseUrlFor, DOMAIN_ENVIRONMENTS, domainFor, type WorkerDomains } from "@pithy-sh/core/src/naming/domains";
import { readWranglerConfig, writeWranglerConfig } from "./wrangler";

/**
 * Generate a Worker's `routes` and `vars.BASE_URL` from its `domains` declaration.
 *
 * One declaration in, two derived wrangler values out, per environment. Nothing is hand-maintained: the
 * whole point of #89 Part 1 is that an adopter states the address once and everything downstream of it is
 * computed, so a route and a `BASE_URL` can no longer disagree with each other or with the declaration.
 *
 * `BASE_URL` stays a wrangler var rather than moving into the declaration alone, because the **Worker
 * reads it at runtime** — `@pithy-sh/email` builds tracking and unsubscribe links against it, and the
 * email Workflow host has it stamped into its own config at provision time. What changed is that it is
 * derived rather than hand-set.
 *
 * ## Per environment, always
 *
 * `env.<name>` stanzas **replace** the top level rather than merging with it, so a value written once at
 * the top would be invisible to staging and prod. That is the same trap `scaffoldProject` handles with
 * `replaceAll` for `PROJECT`/`WORKER`, and the reason nothing here writes to the top-level stanza: `dev`
 * has no domain by design.
 *
 * ## In place, never replaced
 *
 * `comment-json` stores an adopter's comments as symbol-keyed properties on the very array or object they
 * hang off, so replacing an array deletes their notes. Every mutation here reuses the existing container.
 */

/** One environment's derived values, for the caller to report. */
export interface AppliedDomain {
  /** The environment written. */
  env: string;
  /** The hostname the route now points at. */
  pattern: string;
  /** The base URL written to `vars.BASE_URL`. */
  baseUrl: string;
}

/** The wrangler shape this writes. Only the keys it owns. */
interface DomainStanza {
  routes?: unknown[];
  route?: unknown;
  vars?: Record<string, unknown>;
}
interface DomainWrangler extends DomainStanza {
  env?: Record<string, DomainStanza | undefined>;
}

/** A route entry as this generator writes one — a custom domain attached to its zone. */
interface CustomDomainRoute {
  pattern?: string;
  custom_domain?: boolean;
  zone_name?: string;
}

/**
 * Upsert the custom-domain route for one environment, in place.
 *
 * Matches on `custom_domain: true` rather than on the pattern, because the pattern is precisely what may
 * have changed — matching on it would append a second entry for the same Worker every time an adopter
 * moved their domain, and wrangler would then serve whichever it liked. Any other route entry the adopter
 * wrote is left exactly where it is: this owns the custom domain, not the route list.
 */
function upsertRoute(stanza: DomainStanza, pattern: string, zone: string): void {
  if (!Array.isArray(stanza.routes)) stanza.routes = [];
  const routes = stanza.routes;
  const existing = routes.find(
    (entry): entry is CustomDomainRoute =>
      typeof entry === "object" && entry !== null && (entry as CustomDomainRoute).custom_domain === true,
  );
  if (existing) {
    existing.pattern = pattern;
    existing.zone_name = zone;
    return;
  }
  routes.push({ pattern, custom_domain: true, zone_name: zone });
}

/**
 * Write the declaration into a Worker's `wrangler.jsonc`. Returns what it wrote, per environment.
 *
 * Idempotent: running it twice writes the same bytes, and running it after an adopter moved their domain
 * updates the one route entry rather than appending another. An environment with no declared domain is
 * left completely alone — never cleared, because an adopter may have written a route by hand and this must
 * not delete it just because they have not adopted the declaration for that environment.
 */
export async function applyDomains(workerDir: string, domains: WorkerDomains): Promise<AppliedDomain[]> {
  const config = (await readWranglerConfig(workerDir)) as DomainWrangler;
  const applied: AppliedDomain[] = [];

  for (const env of DOMAIN_ENVIRONMENTS) {
    const domain = domainFor(domains, env);
    if (!domain) continue;

    // `dev` is never in `DOMAIN_ENVIRONMENTS`, so this only ever reaches an `env.<name>` stanza — which is
    // also the only place the values would be read from, since env stanzas replace the top level.
    config.env ??= {};
    config.env[env] ??= {};
    const stanza = config.env[env];

    upsertRoute(stanza, domain.pattern, domain.zone);
    stanza.vars ??= {};
    const baseUrl = baseUrlFor(domain);
    stanza.vars.BASE_URL = baseUrl;

    applied.push({ env, pattern: domain.pattern, baseUrl });
  }

  if (applied.length > 0) await writeWranglerConfig(workerDir, config);
  return applied;
}

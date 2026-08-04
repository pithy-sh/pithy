// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { ENVIRONMENTS } from "./environment";

/**
 * Where a Worker answers, declared once per Worker per environment.
 *
 * ## The problem this replaces
 *
 * Nothing in `pithy.config.ts` described a Worker's address, so three commands each reconstructed it
 * differently and none of them reconciled: `pithy env` scraped the first `routes` pattern out of
 * `wrangler.jsonc`, `pithy email provision` and `pithy turnstile` read a hand-set `vars.BASE_URL`, and
 * `pithy deploy` scraped the last URL wrangler happened to print. `email provision` refused to run
 * without `vars.BASE_URL` while `pithy env` cheerfully printed a URL derived from routes, and nothing
 * noticed when the two disagreed. Three answers to one question, in one CLI.
 *
 * So the address is declared, and everything else is generated from it — the `routes` entry with
 * `custom_domain` and `zone_name`, and `vars.BASE_URL`. `BASE_URL` stays a wrangler var because the
 * **Worker reads it at runtime**: `@pithy-sh/email` builds tracking and unsubscribe links against it and
 * Turnstile binds its widget to that domain. What changes is that it is derived rather than hand-set and
 * able to contradict the routes beside it.
 *
 * ## Per Worker, per environment
 *
 * Per Worker because each serves its own hostname. Per environment because `staging.api.example.com` and
 * `api.example.com` are one Worker in two environments, and `env.<name>` stanzas in `wrangler.jsonc`
 * replace rather than merge — so one declaration has to fan out to all of them.
 *
 * ## `dev` carries no domain
 *
 * Deliberately absent from the accepted keys. Local answers on `http://localhost:<port>` from the port
 * the feature's `.dev.config.json` pinned at creation, and a domain there would be a second answer to a
 * question the port allocator already answers. `requireManagedEnvironment` refuses `dev` for the same
 * reason everywhere else.
 */

/** A hostname a Worker answers on. No scheme, no path, no port — wrangler's `routes` pattern is a host. */
const HOSTNAME_PATTERN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

/** The environments a domain may be declared for — every managed one, never `dev`. */
export const DOMAIN_ENVIRONMENTS = ENVIRONMENTS.filter((environment) => environment !== "dev");

/** One environment's public address for one Worker. */
export const WorkerDomain = z
  .object({
    pattern: z
      .string()
      .regex(
        HOSTNAME_PATTERN,
        "A domain is a bare hostname — no scheme, no path, no port (e.g. `api.example.com`, not `https://api.example.com/`).",
      )
      .describe(
        "The hostname this Worker answers on in this environment, e.g. `api.example.com`. Written into `wrangler.jsonc` as a `routes` entry with `custom_domain: true`, and into `vars.BASE_URL` as `https://<pattern>`. A bare hostname rather than a URL, because that is what wrangler's route matcher takes — a scheme here would be silently wrong.",
      ),
    zone: z
      .string()
      .regex(HOSTNAME_PATTERN, "A zone is the registrable domain on your Cloudflare account, e.g. `example.com`.")
      .describe(
        "The Cloudflare zone `pattern` sits under — the registrable domain as it appears on your account, e.g. `example.com` for `api.example.com`. Cloudflare needs it to attach a custom domain, and it is not always derivable from the hostname: a zone can be a subdomain, and a public-suffix guess would be wrong for exactly the adopters who are hardest to debug.",
      ),
  })
  .describe("Where one Worker answers in one environment: the hostname, and the Cloudflare zone it sits under.")
  .check((ctx) => {
    // A pattern outside its own zone produces a `routes` entry Cloudflare refuses at deploy, with an
    // error naming neither of the two values that disagree. Catching it here names both.
    const { pattern, zone } = ctx.value;
    if (pattern !== zone && !pattern.endsWith(`.${zone}`)) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["pattern"],
        message: `The domain \`${pattern}\` is not inside the zone \`${zone}\`. A custom domain must sit on the zone it names — set \`zone\` to the registrable domain \`${pattern}\` belongs to.`,
      });
    }
  });
export type WorkerDomain = z.infer<typeof WorkerDomain>;

/**
 * A Worker's domains, keyed by environment.
 *
 * Every key optional: a project with no domain yet is legitimate, and so is one that has staging wired
 * and production not. Adding one later is a config edit plus a deploy, never a rescaffold.
 */
export const WorkerDomains = z
  .object({
    staging: WorkerDomain.optional().describe("Where this Worker answers in `staging`, if it has a domain yet."),
    prod: WorkerDomain.optional().describe("Where this Worker answers in `prod`, if it has a domain yet."),
  })
  .describe(
    "Where this Worker answers, per environment. `dev` is absent by design — local runs on `http://localhost:<port>` from the port pinned in `.dev.config.json`. Everything else is generated from this: the `routes` entry with `custom_domain` and `zone_name`, and `vars.BASE_URL`.",
  );
export type WorkerDomains = z.infer<typeof WorkerDomains>;

/** The declared domain for one environment, or null where none is declared (including every `dev`). */
export function domainFor(domains: WorkerDomains | undefined, environment: string): WorkerDomain | null {
  if (!domains) return null;
  if (environment === "staging") return domains.staging ?? null;
  if (environment === "prod") return domains.prod ?? null;
  return null;
}

/** The base URL a declared domain implies. Always `https` — a custom domain on Cloudflare is TLS-terminated. */
export function baseUrlFor(domain: WorkerDomain): string {
  return `https://${domain.pattern}`;
}

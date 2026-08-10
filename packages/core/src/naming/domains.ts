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

/**
 * The declared domain for one environment, or null where none is declared (including every `dev`).
 *
 * `environment` may be `undefined`, which is what `compositionEnvironment()` answers when nothing stamped
 * one. That is not a `dev` default — it is "this composition names no environment", and an environment
 * nobody named has declared no domain, so the answer is the same `null` an undeclared one gets.
 */
export function domainFor(domains: WorkerDomains | undefined, environment: string | undefined): WorkerDomain | null {
  if (!domains) return null;
  if (environment === "staging") return domains.staging ?? null;
  if (environment === "prod") return domains.prod ?? null;
  return null;
}

/** The base URL a declared domain implies. Always `https` — a custom domain on Cloudflare is TLS-terminated. */
export function baseUrlFor(domain: WorkerDomain): string {
  return `https://${domain.pattern}`;
}

/**
 * The origin an environment with no declared domain resolves to.
 *
 * **No port, and that is the whole design.** Local dev's port is assigned per Worker per run from the
 * feature's reserved block, so it is the one address nobody can write down — `@pithy-sh/auth` resolves
 * dev's base URL from the host the request arrived at for exactly that reason, and a config-time value
 * could only ever be a stale guess at it. So this is a *placeholder that fails closed*: a link built
 * against it goes nowhere, which is useless rather than harmful.
 *
 * Compare what it replaces. Every capability that made an adopter write an origin got production's
 * written into staging, and the failure was never "the link is broken" — it was a staging deploy mailing
 * real users magic links **into production**, an unsubscribe from a staging test unsubscribing that
 * person in production, and a Checkout return landing a staging payer in production on an account that
 * had bought nothing. A fallback that goes nowhere is the only one that cannot do any of that.
 */
export const LOCAL_ORIGIN = "http://localhost";

/** An environment's public origin, and whether the declaration is where it came from. */
export interface ResolvedOrigin {
  /** The absolute origin — scheme and host, never a trailing slash. */
  origin: string;
  /** The hostname alone: a route pattern, and what Turnstile binds a widget to. */
  hostname: string;
  /** Whether `domains` declared it. `false` means {@link LOCAL_ORIGIN} was substituted. */
  declared: boolean;
}

/**
 * **Where is this Worker publicly reachable, in this environment?** — asked once, answered once.
 *
 * The two halves already existed ({@link domainFor} and {@link baseUrlFor}) and nothing composed them,
 * so every caller that needed the answer did the two-step for itself and every *adopter* who needed it
 * wrote a URL down. The first adopter's one Worker config carried `https://app.pithy.sh` three times —
 * `auth.baseURL`, `email.baseUrl`, and the Stripe return URLs — each wrong for staging in its own way,
 * each found on a different day. Fixing it inside one capability does not stop the next capability
 * asking the same question, so the question gets one answer that anyone can call.
 *
 * **The fallback never reaches for another environment's origin.** An environment absent from `domains`
 * is one that is not published, so it resolves to {@link LOCAL_ORIGIN} and nothing else. Falling back to
 * production's is what the shape being replaced did, and it is the one behaviour here that was actively
 * dangerous rather than merely wrong.
 *
 * **A deployed environment must never *keep* that fallback**, and it is not this function's job to say
 * so — `pithy deploy --env <name>` refuses an environment whose origin its config does not declare
 * (#253), and `pithy doctor` reports it first. One rule in two halves: this one cannot invent another
 * environment's origin, and deploy makes sure the placeholder never ships.
 *
 * **Not every origin should derive from this, and `controlplane.issuer` is the one to name.** That is an
 * **identity**, not an address: a connection stores the issuer it was created with and verification
 * checks that stored value, so a per-environment issuer would make a connection minted in staging
 * unverifiable in production. That may be the better isolation, but it is a decision about trust rather
 * than about reachability, and a helper whose job is "where am I reachable" must not sweep it up.
 */
export function resolveOrigin(environment: string | undefined, domains: WorkerDomains | undefined): ResolvedOrigin {
  const domain = domainFor(domains, environment);
  if (domain) return { origin: baseUrlFor(domain), hostname: domain.pattern, declared: true };
  return { origin: LOCAL_ORIGIN, hostname: "localhost", declared: false };
}

/**
 * The one line an adopter writes: this Worker's public origin for the environment it is running in.
 *
 * ```ts
 * const DOMAINS = { staging: { … }, prod: { … } };
 * const PUBLIC_ORIGIN = originFor(compositionEnvironment(), DOMAINS);
 * ```
 *
 * That is the line `pithy init` scaffolds, so an adopter who never thinks about it gets it right and one
 * who wants a literal can still write one. `compositionEnvironment()` is `string | undefined`, and it is
 * taken as such rather than defaulted to `dev` at the call site: an unstamped composition has declared no
 * domain either way, and a `?? "dev"` in every adopter's config would be a default nobody chose.
 *
 * Named for what it is rather than for who asked. The first adopter's own version was called
 * `AUTH_BASE_URL`, which is part of why `email` and `payments` were missed for days: the constant read
 * as auth's private business when it is the Worker's address, and every capability that needs an origin
 * needs this one.
 */
export function originFor(environment: string | undefined, domains: WorkerDomains | undefined): string {
  return resolveOrigin(environment, domains).origin;
}

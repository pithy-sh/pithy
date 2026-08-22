// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ZoneInfo } from "@pithy-sh/cloudflare/src/zones/zonesManager";
import { DOMAIN_ENVIRONMENTS, WorkerDomain, type WorkerDomains } from "@pithy-sh/core/src/naming/domains";

/**
 * Asking an adopter where a Worker will answer, against reality rather than as free text.
 *
 * ## Against the account, not against a text box
 *
 * A domain has two parts an adopter can get wrong independently: the hostname, and the zone it sits
 * under. Free text accepts both mistakes silently, and neither surfaces until `pithy deploy` returns a
 * Cloudflare error naming neither value. Offering the account's real zones turns the second half into a
 * choice, and lets the first half be checked against it — so a typo fails here, with a list of what
 * actually exists.
 *
 * **Free text stays** for the account that cannot be reached: no token, no `Zone:Read`, an offline
 * laptop, or a domain not yet on Cloudflare. Requiring the network to answer a config question would
 * make `pithy init` a command that fails without credentials, which it has never been.
 *
 * ## Skippable, and re-runnable
 *
 * A project without a domain yet is legitimate — most are, on the first day. Skipping writes no
 * `domains` block at all, and the address resolver falls through to the route and then to `BASE_URL`
 * exactly as it does for a project that predates the declaration. Adding one later is a config edit plus
 * a deploy, never a rescaffold.
 *
 * This module is pure: it decides *what to ask* and *what an answer means*, and the command layer owns
 * the `@clack/prompts` calls. That is what makes the interesting half testable without a TTY.
 */

/** One environment's question, and the zones it can be answered from. */
export interface DomainQuestion {
  /** The environment being asked about — `staging` or `prod`, never `dev`. */
  env: string;
  /** The prompt text, in the house convention: a short question, no trailing period. */
  message: string;
  /** A placeholder showing the shape of an answer for this environment. */
  placeholder: string;
}

/** What an adopter answered for one environment. An empty hostname means "skip this one". */
export interface DomainAnswer {
  /** The environment. */
  env: string;
  /** The hostname they gave, trimmed. Empty to skip. */
  hostname: string;
  /** The zone they chose, when a picker was offered and they picked one. */
  zone?: string;
}

/** Why a zone picker could not be offered, for the caller to say out loud before falling back to text. */
export type ZoneUnavailable = "no-credentials" | "no-access" | "no-zones";

/** The questions to ask, one per managed environment. `dev` is never asked about — it has no domain. */
export function domainQuestions(workerName: string): DomainQuestion[] {
  return DOMAIN_ENVIRONMENTS.map((env) => ({
    env,
    message: `Domain for ${workerName} in ${env}`,
    placeholder: env === "prod" ? "api.example.com" : `${env}.api.example.com`,
  }));
}

/**
 * The zone that owns a hostname, from the account's real list — longest match, or null.
 *
 * Longest match is the only correct rule when an account holds both `example.com` and `eu.example.com`:
 * `api.eu.example.com` belongs to the latter, and taking the first would attach the Worker to the wrong
 * zone. No public-suffix guess is used, because a zone can itself be a subdomain.
 */
export function zoneForHostname(hostname: string, zones: readonly ZoneInfo[]): ZoneInfo | null {
  const candidates = zones.filter((zone) => hostname === zone.name || hostname.endsWith(`.${zone.name}`));
  if (candidates.length === 0) return null;
  return candidates.reduce((longest, zone) => (zone.name.length > longest.name.length ? zone : longest));
}

/**
 * How a zone reads in a picker. A zone that is not yet active is shown and labeled, never hidden:
 * hiding it makes the account look like it does not have the domain, which is the more confusing failure.
 */
export function describeZone(zone: ZoneInfo): string {
  return zone.status === "active" ? zone.name : `${zone.name} (${zone.status})`;
}

/** Why a hostname was refused, in brand voice — a problem line and what to do about it. */
export interface DomainRejection {
  /** What is wrong. */
  message: string;
  /** What to do next. */
  action: string;
}

/**
 * Turn answers into a validated `domains` block, or the first reason one cannot be built.
 *
 * Validation goes through `WorkerDomain` rather than being re-implemented, so the prompt refuses exactly
 * what the config would refuse — a scheme, a path, a port, or a hostname outside its own zone. A prompt
 * that accepted something the config rejects would move the failure from a question to a stack trace.
 *
 * An answer with no hostname is a skip, and skipping every environment yields `undefined` rather than an
 * empty object: a project with no domains should have no `domains` key at all.
 */
export function buildDomains(
  answers: readonly DomainAnswer[],
): { domains: WorkerDomains | undefined } | { rejected: DomainRejection } {
  const domains: Record<string, { pattern: string; zone: string }> = {};

  for (const answer of answers) {
    const hostname = answer.hostname.trim();
    if (!hostname) continue;

    // Absent a picker, the zone is inferred as the registrable pair — a reasonable default for the
    // common `api.example.com` case, and one the adopter can correct in the config. Where a picker ran,
    // the account's own answer wins over any inference.
    const zone = answer.zone?.trim() || inferZone(hostname);
    const parsed = WorkerDomain.safeParse({ pattern: hostname, zone });
    if (!parsed.success) {
      return {
        rejected: {
          message: `\`${hostname}\` is not a domain this Worker can answer on in ${answer.env}.`,
          action:
            parsed.error.issues[0]?.message ??
            "Give a bare hostname like `api.example.com` — no scheme, no path, no port.",
        },
      };
    }
    domains[answer.env] = parsed.data;
  }

  return { domains: Object.keys(domains).length === 0 ? undefined : (domains as WorkerDomains) };
}

/**
 * The registrable pair of a hostname — `api.example.com` → `example.com`.
 *
 * A deliberate guess, used **only** when the account could not be reached, and it is wrong for a
 * multi-part public suffix (`example.co.uk`) and for an account whose zone is itself a subdomain. That is
 * acceptable precisely because it is the offline path: the value lands in `pithy.config.ts` where the
 * adopter can see and correct it, rather than being buried in a generated wrangler file. With the account
 * reachable, `zoneForHostname` answers from the real list and this is never called.
 */
function inferZone(hostname: string): string {
  const labels = hostname.split(".");
  return labels.length <= 2 ? hostname : labels.slice(-2).join(".");
}

/**
 * One `<env>: { pattern, zone },` line, at the given indent. Both renderers below emit the same entries;
 * only where they sit differs.
 */
function domainEntries(domains: WorkerDomains, indent: string): string[] {
  const lines: string[] = [];
  for (const env of DOMAIN_ENVIRONMENTS) {
    const domain = domains[env as keyof WorkerDomains];
    if (!domain) continue;
    lines.push(
      `${indent}${env}: { pattern: ${JSON.stringify(domain.pattern)}, zone: ${JSON.stringify(domain.zone)} },`,
    );
  }
  return lines;
}

/**
 * The hoisted `const DOMAINS = { … };` a scaffolded `pithy.config.ts` carries, filled in.
 *
 * Hoisted rather than nested because the Worker's public origin is derived from it on the very next line
 * — `originFor(compositionEnvironment(), DOMAINS)` — and a value inside the config object literal cannot
 * be read by that same literal. That derivation is the whole point: it is what lets every capability take
 * `PUBLIC_ORIGIN` instead of asking the adopter for a URL (#256).
 *
 * The comment above the const belongs to the scaffold and is not restated here — this replaces the
 * declaration alone, so an adopter who has rewritten that comment keeps it.
 */
export function renderDomainsConst(domains: WorkerDomains): string {
  return ["const DOMAINS = {", ...domainEntries(domains, "  "), "};"].join("\n");
}

/**
 * The `domains` block as it is written into a `pithy.config.ts` scaffolded **before** the hoisted const —
 * a key inside the config object. Kept for those projects; a config carrying the const takes
 * {@link renderDomainsConst} instead.
 */
export function renderDomainsBlock(domains: WorkerDomains): string {
  const lines = ["  // Where this Worker answers, per environment."];
  lines.push("  // `routes` and `vars.BASE_URL` in wrangler.jsonc are generated from this — declare it once here.");
  lines.push("  domains: {");
  lines.push(...domainEntries(domains, "    "));
  lines.push("  },");
  return lines.join("\n");
}

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename } from "node:path";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { DOMAIN_ENVIRONMENTS, type WorkerDomains } from "@pithy-sh/core/src/naming/domains";
import { isSourceEnvironment } from "../provision/featureConfig";
import { loadProject, loadProjectEnvironments, loadWorkerConfig, loadWorkerDomains } from "./config";
import {
  type AddressStanza,
  resolveWorkerAddress,
  type WorkerAddress,
  type WorkerAddressSource,
} from "./workerAddress";
import { discoverWorkers } from "./workers";
import { readOptionalWranglerConfig } from "./wrangler";

/**
 * **Every origin a deployed Worker answers on is one its configuration names, and every origin its
 * configuration names has something configured to serve it.**
 *
 * That is the whole invariant — both directions of it — and #253 and #264 are what happen without each
 * half. Anything derived from an environment's public origin — an auth `baseURL`, an OAuth callback, a
 * magic-link URL, a CSRF allowed-origin — has to answer "what is this environment's origin?". When
 * nothing in the config
 * answers, every caller invents one, and the inventions are wrong in different directions: production's
 * origin emails real users magic links into production from a staging deploy (the shape the first
 * adopter shipped), `http://localhost:…` serves links that go nowhere, and a throw at module scope turns
 * an auth-config typo into a total outage. There is no good answer at the point of use, because by then
 * the information is already missing.
 *
 * So the question is asked here, once, from files — and it is asked in **both** directions, because a
 * config and the origins it serves fall out of step three ways.
 *
 * ## One: the config names no origin at all
 *
 * `resolveWorkerAddress` is the one resolver, and it already reads the three places an address can be
 * stated: the `domains` declaration, a hand-written `routes` pattern, and a hand-set `vars.BASE_URL`. If
 * all three are empty for an environment, nothing downstream can compute an origin and this refuses.
 *
 * Note what that does *not* refuse. A project that predates the declaration and wrote its own route is
 * fine. A project on a custom declared environment — `live`, which `WorkerDomains` has no key for — is
 * fine the moment it sets `vars.BASE_URL`, which is the same thing the declaration generates. The
 * refusal is aimed at the third state the issue names, where the origin is neither declared nor
 * derivable and each caller guesses.
 *
 * ## Two: the config names an origin and nothing serves it
 *
 * **Every origin the config names has to have something in that config configured to serve it**, and until
 * #264 nothing asked. `resolveWorkerAddress` takes the `domains` declaration as authoritative — rightly,
 * it is what the `routes` entry is generated *from* — so "board answers on `https://app.example.com`" was
 * asserted from the declaration alone, and whether any route pointed there was never a question. Only
 * `applyDomains` ever writes that route, only an interactive `pithy init` or `pithy worker` ever calls it,
 * and `askDomains` returns nothing at all when a session is not interactive. So an adopter who declared
 * `domains` by hand — the documented way to add an environment — had a declaration with no route behind it,
 * and every check here was green.
 *
 * Then this file's own remedy for fault three below finished the job: it told them to set
 * `"workers_dev": false`, which closed the *only* origin that was actually serving. Doctor, `pithy deploy`
 * and the post-deploy probe all stayed green over a Worker reachable at no address.
 *
 * The rule is asked as one question of the resolved address — *what in this config serves this host?* — and
 * not as a list of key combinations, because a list is what missed this one. A route pattern that covers
 * the hostname serves it; for a `workers.dev` hostname, `workers_dev` not being off serves it. Nothing
 * else can.
 *
 * ## Three: `workers.dev` serves an origin nothing named
 *
 * A Worker deployed with a custom domain **still answers on `<name>.<subdomain>.workers.dev`**, because
 * wrangler's `workers_dev` defaults to `true` and declaring `routes` does not change that. `preview_urls`
 * then defaults to whatever `workers_dev` is, so every deployed version is reachable there too. That
 * second origin is undeclared, and everything derived from the declaration is wrong on it: `BASE_URL`
 * names the custom domain, so OAuth callbacks and magic links point away from the host in use; the CSRF
 * same-origin gate allows the custom domain, so mutating cookie routes fail there — reachable, and broken
 * in the half that decides who you are; and anything bound to the hostname rather than the script (WAF
 * rules, Access policies, per-hostname rate limits) does not apply at all.
 *
 * **The fault is the absence of a decision, not the decision.** An explicit `"workers_dev": true` is an
 * adopter saying out loud that the subdomain is an origin they want — a team wanting the `workers.dev`
 * URL for staging before DNS is cut over is a real case — and a named origin satisfies the invariant. It
 * is the *unset* key that means nobody chose, and that is what this reports.
 *
 * ## Where it is answered
 *
 * `pithy deploy --env <name>` refuses, because it already knows the environment and the config and it is
 * the last moment before the mistake becomes real — the same shape as its refusal of a binding with no id
 * (#240). `pithy doctor` reports the same drift so it is findable before a deploy is attempted. One
 * reader, so the two can never disagree about what "declared" means.
 */

/** Which of the three ways a config and the origins it serves fall out of step. Three remedies. */
export type OriginFault =
  /** Nothing in the config states an address for this environment, so no caller can compute one. */
  | "no-origin"
  /** An origin is named and **nothing in the config serves it**, so the Worker answers at no address. */
  | "unserved-origin"
  /** An origin is named and served, and `workers.dev` serves a second one that nothing decided about. */
  | "workers-dev-open";

/** One Worker-and-environment whose named and served origins do not line up. */
export interface OriginDrift {
  /** The Worker's `apps/<name>` directory. */
  worker: string;
  /** The environment. */
  env: string;
  /** Which fault this is. */
  fault: OriginFault;
  /** The origin the config does name, or `null` when it names none. Evidence, never a secret. */
  origin: string | null;
  /**
   * Where the unserved origin was named, on `unserved-origin` alone — and the whole remedy turns on it.
   *
   * A `declaration` is *generated from*, so `pithy worker sync` writes the route that was never written.
   * A hand-set `vars.BASE_URL` is generated from nothing, so there is no command to offer and the route
   * is the adopter's to write. Offering `worker sync` there would send them to a command that reads a
   * `domains` block they do not have and reports, correctly and uselessly, that it wrote nothing.
   */
  source?: WorkerAddressSource;
}

/** What `doctor` learned. Listed positively, so an inconclusive read never gates CI. */
export type OriginsState =
  /** Every declared environment names every origin it serves, and serves every origin it names. */
  | "ok"
  /** The root config would not load, so there is no declared set to walk. */
  | "could-not-check"
  /** An environment's named and served origins disagree. Established from local files alone. */
  | "drifted";

/** What `doctor` reports about this project's origins. */
export interface OriginsCheck {
  state: OriginsState;
  drift: OriginDrift[];
}

/** The `wrangler.jsonc` keys this reads: the address inputs, plus the `workers_dev` decision. */
interface OriginStanza extends AddressStanza {
  workers_dev?: unknown;
}
interface OriginWrangler extends OriginStanza {
  env?: Record<string, OriginStanza | undefined>;
}

/**
 * Is this hostname on `workers.dev`?
 *
 * Asked because an adopter whose *named* origin is the subdomain — the `workers.dev`-only project, which
 * states it in `vars.BASE_URL` — is naming exactly the origin `workers_dev` serves. Turning it off would
 * be the contradiction; leaving it on is the configuration working.
 */
function isWorkersDevHost(hostname: string): boolean {
  return hostname === "workers.dev" || hostname.endsWith(".workers.dev");
}

/**
 * The `workers_dev` decision in force for one environment: the stanza's own, else the top level's, else
 * `undefined` for "nobody decided".
 *
 * `undefined` is not `false`. Wrangler documents the default as `true` and documents nothing about
 * `routes` changing it, so an absent key is the subdomain being served — which is the whole finding. It
 * is kept distinct from an explicit `true` because the two mean opposite things here: one is a decision,
 * the other is its absence.
 */
function workersDevDecision(config: OriginWrangler, stanza: OriginStanza | undefined): boolean | undefined {
  const value = stanza?.workers_dev ?? config.workers_dev;
  return typeof value === "boolean" ? value : undefined;
}

/** Every route pattern an environment's stanza states, in either form wrangler accepts. */
function routePatterns(stanza: OriginStanza | undefined): string[] {
  const entries = [...(Array.isArray(stanza?.routes) ? stanza.routes : []), stanza?.route];
  return entries
    .map((entry) => (typeof entry === "string" ? entry : typeof entry?.pattern === "string" ? entry.pattern : ""))
    .filter((pattern) => pattern.length > 0);
}

/**
 * Does one route pattern cover this hostname?
 *
 * A pattern is a matcher, not a literal: it may carry a path (`example.com/api/*`, dropped — a host is
 * either matched or it is not) and `*` stands for any run of characters, so `*.example.com/*` covers
 * `app.example.com`. Matching on equality alone would report a fault against an adopter whose wildcard
 * route has been serving the host for a year, which is the fastest way to get a check ignored.
 */
function routeCovers(pattern: string, hostname: string): boolean {
  const host = pattern.split("/")[0] ?? "";
  if (host.length === 0) return false;
  if (host === hostname) return true;
  if (!host.includes("*")) return false;
  const expression = host
    .split("*")
    .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${expression}$`).test(hostname);
}

/**
 * **What in this config serves this address?** — the one question, asked of the one resolved origin.
 *
 * Two answers exist and there is no third. A route pattern that covers the hostname serves it. A
 * `workers.dev` hostname is served by the subdomain itself, unless `workers_dev` has been turned off —
 * which is the same fault from the other end, and needs no separate rule: an adopter whose named origin
 * *is* the subdomain, with `"workers_dev": false` beside it, has closed the only thing serving them.
 */
function servesOrigin(
  address: WorkerAddress,
  stanza: OriginStanza | undefined,
  workersDev: boolean | undefined,
): boolean {
  if (routePatterns(stanza).some((pattern) => routeCovers(pattern, address.hostname))) return true;
  return isWorkersDevHost(address.hostname) && workersDev !== false;
}

/**
 * One Worker's declared `domains`, **and whether its config could be asked at all**.
 *
 * The two must not arrive as one. A config that will not import — dependencies not installed, most
 * often — returns no declaration, and a reader that took that as "declares none" would refuse a deploy
 * for an environment whose domain is sitting in the file it could not open, telling the adopter to
 * declare what they already declared. That was not hypothetical: it is what this did on a freshly
 * scaffolded project before `bun install`, and the refusal named the wrong fix.
 *
 * So `loaded` is carried, and a negative finding is only ever made against a config that was read. The
 * `workers.dev` finding is unaffected either way, because its evidence is the `wrangler.jsonc` alone.
 */
async function workerDomains(workerDir: string): Promise<{ domains: WorkerDomains | undefined; loaded: boolean }> {
  try {
    return { domains: loadWorkerDomains(await loadWorkerConfig(workerDir)), loaded: true };
  } catch {
    // A config that will not import has its own, better error waiting one step later — the same rule
    // `unprovisionedBindings` states. This reader gates a deploy; it does not diagnose a broken config.
    return { domains: undefined, loaded: false };
  }
}

/**
 * Every Worker-and-environment in `environments` whose named and served origins disagree, in worker then
 * environment order.
 *
 * Files only, offline, and no account call — the same standard the other deploy gate is held to. A
 * process with no `wrangler.jsonc` (a Vite frontend in the dev set) answers on nothing and is skipped.
 */
export async function originDrift(projectDir: string, environments: readonly string[]): Promise<OriginDrift[]> {
  const drift: OriginDrift[] = [];
  for (const target of await discoverWorkers(projectDir)) {
    if (target.hasWrangler === false) continue;
    const config = (await readOptionalWranglerConfig(target.dir).catch(() => null)) as OriginWrangler | null;
    if (!config) continue;
    const { domains, loaded } = await workerDomains(target.dir);
    const worker = basename(target.dir);
    for (const env of environments) {
      const stanza = config.env?.[env];
      const address = resolveWorkerAddress({ environment: env, domains, stanza });
      if (!address) {
        // Only against a config that was actually read. "This declares no domain" is a negative claim,
        // and a `pithy.config.ts` nobody could import is exactly what might have declared one.
        if (loaded) drift.push({ worker, env, fault: "no-origin", origin: null });
        continue;
      }
      const workersDev = workersDevDecision(config, stanza);
      // The origin is named. Is anything serving it? One fault per environment, and this is the one that
      // comes first: a Worker answering at no address makes the question of a *second* origin moot, and
      // the one remedy — `pithy worker sync` — writes the route and the `workers_dev` decision together,
      // so naming both faults would be two sentences about one edit.
      if (!servesOrigin(address, stanza, workersDev)) {
        drift.push({ worker, env, fault: "unserved-origin", origin: address.url, source: address.source });
        continue;
      }
      // A named origin that is itself the subdomain leaves nothing unnamed, whatever `workers_dev` says.
      if (isWorkersDevHost(address.hostname)) continue;
      if (workersDev === undefined) {
        drift.push({ worker, env, fault: "workers-dev-open", origin: address.url });
      }
    }
  }
  return drift;
}

/** One drift, as the sentence that fits it. Three faults, three remedies, and no two are each other's. */
export function describeOriginDrift(drift: OriginDrift): string {
  if (drift.fault === "no-origin") {
    return `${drift.worker} has no origin for ${drift.env}. ${originRemedy(drift.env)}`;
  }
  if (drift.fault === "unserved-origin") {
    return `${drift.worker} answers on nothing in ${drift.env}: ${drift.origin} is its origin and no route in env.${drift.env} serves it. ${routeRemedy(drift)}`;
  }
  return `${drift.worker} answers on ${drift.origin} in ${drift.env}, and also on workers.dev, which nothing declared. Set "workers_dev": false in env.${drift.env} of its wrangler.jsonc — or "workers_dev": true to say you meant both.`;
}

/** The hostname a route pattern would have to carry, from the origin this reported. */
function hostnameOf(origin: string | null): string {
  try {
    return new URL(origin ?? "").hostname;
  } catch {
    return origin ?? "";
  }
}

/**
 * How to make something serve an origin already named. Three answers, because the remedy is whatever the
 * origin was named *by*.
 *
 * A `domains` declaration is the one that has a command: `pithy worker sync` writes the route from it, and
 * that command exists because before #264 nothing non-interactive did. A hand-set `vars.BASE_URL` was
 * generated from nothing, so the route is written by hand. And an origin on `workers.dev` needs no route
 * at all — the subdomain serves it, and turning `workers_dev` back on is the whole fix.
 */
function routeRemedy(drift: OriginDrift): string {
  const hostname = hostnameOf(drift.origin);
  if (isWorkersDevHost(hostname)) {
    return `That host is the workers.dev subdomain and "workers_dev": false closed it. Set it back to true in env.${drift.env} of its wrangler.jsonc, or name an origin you do serve.`;
  }
  if (drift.source === "declaration") {
    return `Run pithy worker sync to write the route from the domains declaration.`;
  }
  return `Add a routes entry for ${hostname} to env.${drift.env} in its wrangler.jsonc.`;
}

/**
 * How to give an environment an origin. Two answers, because `WorkerDomains` has keys for `staging` and
 * `prod` only — a project on a custom declared environment cannot state one there, and telling it to
 * would send it to a declaration that would not validate.
 */
function originRemedy(env: string): string {
  // Widened deliberately: `DOMAIN_ENVIRONMENTS` is the literal union `WorkerDomains` has keys for, and
  // the question here is about an arbitrary declared environment — `live` is a legal one and is exactly
  // the case that needs the other answer.
  if ((DOMAIN_ENVIRONMENTS as readonly string[]).includes(env)) {
    return `Declare domains.${env} in the Worker's pithy.config.ts, or set vars.BASE_URL in env.${env} of its wrangler.jsonc.`;
  }
  return `Set vars.BASE_URL in env.${env} of its wrangler.jsonc — domains covers ${DOMAIN_ENVIRONMENTS.join(" and ")} only.`;
}

/**
 * Refuse to deploy into an environment whose named and served origins do not line up.
 *
 * **A feature environment is exempt, and deliberately.** It is ephemeral, created by pithy from a branch
 * name, it has no declared domain by design, and `workers.dev` is exactly how it is reached — so holding
 * it to a declaration it can never have would refuse every feature deploy. `isSourceEnvironment` is the
 * same predicate the config-path resolver uses, so the two cannot disagree about which environments are
 * a project's own.
 */
export async function assertOriginsDeclared(projectDir: string, env: string): Promise<void> {
  if (!isSourceEnvironment(env)) return;
  const drift = await originDrift(projectDir, [env]);
  if (drift.length === 0) return;
  const first = drift[0] as OriginDrift;
  throw new ValidationError({
    message:
      first.fault === "unserved-origin"
        ? `${env} names an origin nothing serves: ${drift.map((entry) => entry.worker).join(", ")}.`
        : `${env} serves an origin nothing declares: ${drift.map((entry) => entry.worker).join(", ")}.`,
    action: drift.map(describeOriginDrift).join(" "),
    detail: originDetail(first.fault),
  });
}

/** The throw-site context behind each fault — why this one is worth a refusal. */
function originDetail(fault: OriginFault): string {
  switch (fault) {
    case "no-origin":
      return "Every auth baseURL, OAuth callback, magic-link URL and CSRF allowed-origin is derived from this, and with nothing declared each of them invents its own.";
    case "unserved-origin":
      // The failure this refusal exists for: it deploys clean, verifies clean, and answers nowhere.
      return "A declared domain and the route that serves it are two halves of one fact written in two files, and only applyDomains writes the second — so a domains block added by hand routes nowhere, and every check downstream reads the declaration rather than the route.";
    case "workers-dev-open":
      return "wrangler's workers_dev defaults to true and routes do not change it, so a Worker with a custom domain answers on its workers.dev subdomain too — and preview_urls follows workers_dev.";
  }
}

/**
 * The same question asked of every environment the project declares, for `pithy doctor`.
 *
 * `could-not-check` when the root config will not load: with no declaration there is no set to walk, and
 * the `Project:` block already owns saying that a config would not read.
 */
export async function checkOrigins(projectDir: string): Promise<OriginsCheck> {
  let environments: readonly string[];
  try {
    environments = loadProjectEnvironments(await loadProject(projectDir));
  } catch {
    return { state: "could-not-check", drift: [] };
  }
  const drift = await originDrift(projectDir, environments);
  return { state: drift.length > 0 ? "drifted" : "ok", drift };
}

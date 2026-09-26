// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { CloudflareNotConfiguredError } from "@pithy-sh/cloudflare/src/client/errors";
import type { ZoneInfo } from "@pithy-sh/cloudflare/src/zones/zonesManager";
import { domainFor } from "@pithy-sh/core/src/naming/domains";
import { loadWorkerDomains, type WorkerConfig } from "../project/config";

/**
 * **Which zones the `ci-system` token may attach a route to, answered from the project's own
 * declaration.**
 *
 * `pithy deploy` of an environment with a declared domain ends in `POST /zones/<zone>/workers/routes`,
 * and a minted token's resources are account-scoped — so the zone-level Workers Routes group needs a
 * *zone* resource beside the account one or the call is refused. That refusal is what #651 is: the one
 * credential the kit tells an adopter to put in CI could not deploy any environment with a domain, and
 * the error named a zone id and nothing else.
 *
 * Two rules decide the scope, and both are here rather than at the mint.
 *
 * **The zones are the declared ones, never the account's.** A `ci-system` token scoped to every zone on
 * the account would deploy fine and would be a credential that can repoint any hostname the account
 * holds — including a customer's, on an account that runs more than this project. So the set is exactly
 * the zones the project's `domains` name, and a project that declares none gets no zone policy at all.
 *
 * **An unresolvable zone fails the mint.** A zone the account does not hold cannot be scoped, and minting
 * without it produces a token that passes every check here and fails at deploy, hours later, in someone
 * else's CI log. So it refuses at mint time and names the domain and the zone — the two values the
 * adopter can act on, neither of which Cloudflare's own error mentions.
 */

/** One Worker's declared domain for one environment, before the zone has been resolved to an id. */
export interface DeclaredRouteZone {
  /** The Worker that declares it, so a refusal names the config to open. */
  worker: string;
  /** The hostname the Worker answers on in this environment. */
  domain: string;
  /** The registrable domain the declaration names as its Cloudflare zone. */
  zone: string;
}

/** A declared domain whose zone the account holds, with the id a token policy resource can name. */
export interface ResolvedRouteZone extends DeclaredRouteZone {
  /** The CF zone id — the only thing `com.cloudflare.api.account.zone.<id>` can be built from. */
  zoneId: string;
}

/** The zone read this needs, and the whole of it: the account's zones. Never a write. */
export interface ZoneDirectory {
  listZones(): Promise<ZoneInfo[]>;
}

/** The slice of a resolved Worker this reads — its name, and the config the declaration lives in. */
export interface DomainDeclaringWorker {
  name: string;
  config: WorkerConfig;
}

/**
 * Every domain the project declares for one environment, in worker order.
 *
 * The configs must already be **composed for that environment** — a `pithy.config.ts` may name its
 * domains from the environment it is composed for, and the scaffold does exactly that, so a reading
 * composed for another environment answers the wrong question rather than none.
 */
export function declaredRouteZones(
  workers: readonly DomainDeclaringWorker[],
  environment: string,
): DeclaredRouteZone[] {
  const declared: DeclaredRouteZone[] = [];
  for (const worker of workers) {
    const domain = domainFor(loadWorkerDomains(worker.config), environment);
    if (domain) declared.push({ worker: worker.name, domain: domain.pattern, zone: domain.zone });
  }
  return declared;
}

/**
 * Resolve each declared zone against the account's own zone list, or refuse.
 *
 * Matched by **exact zone name**, not by hostname suffix. The declaration already states the zone — and
 * `WorkerDomain` has already checked the pattern sits inside it — so this is a lookup, not a guess.
 * A suffix match would resolve `notexample.com` against `example.com` and scope the token to a zone the
 * adopter never named.
 *
 * Nothing declared means no call: a project with no domain must mint exactly the token it minted before
 * this existed, and that includes making no extra request to do it.
 */
export async function resolveRouteZones(
  declared: readonly DeclaredRouteZone[],
  zones: ZoneDirectory,
): Promise<ResolvedRouteZone[]> {
  if (declared.length === 0) return [];
  const byName = new Map<string, ZoneInfo[]>();
  for (const zone of await zones.listZones()) {
    byName.set(zone.name, [...(byName.get(zone.name) ?? []), zone]);
  }
  return declared.map((entry) => ({ ...entry, zoneId: resolveOne(entry, byName.get(entry.zone) ?? []).id }));
}

/**
 * The one zone a declaration names, or the refusal that fits — absent, ambiguous, or not yet live.
 *
 * Three ways a lookup fails and three sentences, because they are three different edits. Rolled into
 * one "could not resolve" they would each send an adopter to read the other two's remedy.
 */
function resolveOne(entry: DeclaredRouteZone, candidates: readonly ZoneInfo[]): ZoneInfo {
  if (candidates.length === 0) {
    throw new CloudflareNotConfiguredError({
      message: `This account holds no zone \`${entry.zone}\`, so the CI token cannot be scoped to attach \`${entry.domain}\`.`,
      action: `Add the zone ${entry.zone} to this Cloudflare account, or fix \`domains\` in ${entry.worker}'s pithy.config.ts, then mint again.`,
      detail: `resolve route zones: ${entry.worker} declares ${entry.domain} on zone ${entry.zone}, which this account does not hold`,
    });
  }
  if (candidates.length > 1) {
    // The same refusal `resolvePermissionGroups` makes for a display name with two ids, for the same
    // reason: one name, two things, and picking either scopes a live CI credential to a guess.
    throw new CloudflareNotConfiguredError({
      message: `This account holds ${candidates.length} zones named \`${entry.zone}\`, so the CI token cannot be scoped to attach \`${entry.domain}\`.`,
      action: `Remove the duplicate zone, or name the one you mean by scoping ${entry.worker}'s \`domains\` to a zone with a unique name, then mint again.`,
      detail: `resolve route zones: ${entry.zone} matches ${candidates.map((zone) => zone.id).join(", ")}`,
    });
  }
  // biome-ignore lint/style/noNonNullAssertion: exactly one candidate — both guards above proved it.
  const zone = candidates[0]!;
  if (zone.status !== "active") {
    // A zone Cloudflare is not yet serving cannot carry a custom domain, so a token scoped to it is a
    // credential whose deploy fails anyway — the outcome the absent-zone refusal exists to prevent,
    // reached by a second road. `status` is read rather than assumed because `ZoneInfo` carries it for
    // exactly this: a picker shows a pending zone and says so, and a mint refuses it and says so.
    throw new CloudflareNotConfiguredError({
      message: `The zone \`${entry.zone}\` is ${zone.status}, not active, so it cannot carry \`${entry.domain}\` yet.`,
      action: `Finish setting the zone up on Cloudflare — it must be active before a Worker can answer on it — then mint again.`,
      detail: `resolve route zones: ${entry.worker} declares ${entry.domain} on zone ${entry.zone} (${zone.id}), status ${zone.status}`,
    });
  }
  return zone;
}

/** The zone ids a route policy names: de-duped and sorted, so declaration order cannot change the token. */
export function routeZoneIds(resolved: readonly ResolvedRouteZone[]): string[] {
  return [...new Set(resolved.map((entry) => entry.zoneId))].sort();
}

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ControlPlaneConnection } from "@pithy-sh/core/src/controlPlane/data/connection";
import { type DashboardClient, DEFAULT_DASHBOARD_ORIGIN } from "./contract";

/**
 * **Which dashboard a `pithy dashboard` command talks to — decided once, here (#614).**
 *
 * Every subcommand built its own client from `--origin`, and the flag's absence meant
 * {@link DEFAULT_DASHBOARD_ORIGIN}. That is right for the adopter Pithy hosts and wrong for everybody
 * who self-hosts: `status --verify` on a connection registered against `staging.app.pithy.sh` asked
 * `app.pithy.sh` about it, could not reach a host that was never involved, and reported that the
 * *connection* needed reconnecting. The report printed `Issuer https://staging.app.pithy.sh` two lines
 * under the error — the address it should have used, on the screen, unread.
 *
 * So the choice stops being four call sites reading a flag and becomes one function reading a
 * connection. The order is the order of what is known:
 *
 * 1. **`--origin`**, when it is passed. An operator naming an address outranks a record of one, and it
 *    is how a moved dashboard is re-pointed.
 * 2. **The origin recorded at connect**, which is the answer for every connection registered by a CLI
 *    that has this.
 * 3. **The issuer**, for a row written before the column existed. Near enough to ask — it is what that
 *    dashboard signs as — and *not the same fact*, which is exactly why the recorded origin exists:
 *    nothing says a management client's API answers where its tokens claim to come from.
 * 4. **The hosted dashboard**, when nothing is registered at all. A first `connect` has no row to read.
 *
 * `source` travels with the answer because the failures differ. A call that could not reach a *recorded*
 * origin is a dashboard that moved or is down; one that could not reach the *default* is usually an
 * operator who meant to pass `--origin`. An error that names the address and where it came from lets a
 * reader tell those apart without running anything.
 */

/** Where an origin came from — see the order in this module's docblock. */
export type OriginSource = "flag" | "recorded" | "issuer" | "default";

/** The origin a command will call, and what decided it. */
export interface ResolvedOrigin {
  /** The address, with any trailing slash removed — `https://app.pithy.sh`. */
  origin: string;
  /** What decided it, for an error that has to say more than "could not connect". */
  source: OriginSource;
}

/** What {@link resolveDashboardOrigin} reads. */
export interface ResolveOriginOptions {
  /** `--origin`, when it was passed. */
  flag?: string | undefined;
  /** The registered connection, or null when this environment has none. */
  connection: Pick<ControlPlaneConnection, "issuer" | "managementOrigin"> | null;
}

/** One address, however it was spelled. A trailing slash is not a different dashboard. */
function tidy(origin: string): string {
  return origin.replace(/\/+$/, "");
}

/** Decide which management client this command talks to. */
export function resolveDashboardOrigin(options: ResolveOriginOptions): ResolvedOrigin {
  if (options.flag !== undefined && options.flag !== "") return { origin: tidy(options.flag), source: "flag" };
  const connection = options.connection;
  if (connection === null) return { origin: tidy(DEFAULT_DASHBOARD_ORIGIN), source: "default" };
  const recorded = connection.managementOrigin;
  if (recorded) return { origin: tidy(recorded), source: "recorded" };
  return { origin: tidy(connection.issuer), source: "issuer" };
}

/**
 * Whether an explicit `--origin` names somewhere other than what the row records.
 *
 * The one question that decides a re-point. Asked here rather than at the call sites so "the flag
 * overrides *and* moves the record" is one rule with one implementation — and so a flag naming the
 * address already stored writes nothing, because a command that recorded a change that did not happen
 * would put a lie in the adopter's audit trail.
 */
export function repointsOrigin(resolved: ResolvedOrigin, connection: ControlPlaneConnection | null): boolean {
  if (resolved.source !== "flag" || connection === null) return false;
  return connection.managementOrigin === null || tidy(connection.managementOrigin) !== resolved.origin;
}

/** Build the client for a resolved origin. The one call site that may name a `DashboardClient`'s origin. */
export type DashboardClientFactory = (resolved: ResolvedOrigin) => DashboardClient;

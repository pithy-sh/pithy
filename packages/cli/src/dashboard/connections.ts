// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { connectionView } from "@pithy-sh/core/src/controlPlane/http/connections";
import { ConnectionView } from "@pithy-sh/core/src/controlPlane/http/responses";
import { z } from "zod";
import { formatDone, formatJsonLine } from "../terminal/output";
import { dim } from "../terminal/style";
import type { ConnectionRegistry } from "./registry";

/**
 * `pithy dashboard connections --principal <email>`: everything one person authorized, across the project's
 * environments, and with `--revoke` the end of it. Each environment is read through its own registry, so the
 * listing is core's `listConnections` and every revocation is recorded on that environment's trail.
 */

/** One environment's connections for a principal. */
export const PrincipalEnvironment = z
  .object({
    environment: z.string().describe("The environment these connections are bound to."),
    connections: z.array(ConnectionView).describe("The connections the principal authorized, oldest first."),
    unattributed: z
      .array(ConnectionView)
      .describe(
        "The connections registered before principals were recorded, oldest first. Listed for a person to read; never revoked by a principal match.",
      ),
  })
  .describe("One environment's connections for a principal.");
export type PrincipalEnvironment = z.output<typeof PrincipalEnvironment>;

/** One connection a `--revoke` ended. */
export const RevokedConnection = z
  .object({
    environment: z.string().describe("The environment the connection is bound to."),
    connectionId: z.string().describe("The connection revoked."),
    revokedKeyIds: z.array(z.string()).describe("The keys revoked."),
    revokedTrustIds: z.array(z.string()).describe("The trusts revoked."),
  })
  .describe("One connection a `--revoke` ended.");
export type RevokedConnection = z.output<typeof RevokedConnection>;

/** Run `work` against one environment's registry, and release it after. */
export type OpenRegistry = <T>(environment: string, work: (registry: ConnectionRegistry) => Promise<T>) => Promise<T>;

/** Every environment's connections for `principal`, in the order the environments were named. */
export async function listPrincipalConnections(options: {
  principal: string;
  environments: readonly string[];
  open: OpenRegistry;
  now: Date;
}): Promise<PrincipalEnvironment[]> {
  const found: PrincipalEnvironment[] = [];
  for (const environment of options.environments) {
    const listing = await options.open(environment, (registry) => registry.list(options.principal));
    found.push({
      environment,
      connections: listing.connections.map((connection) => connectionView(connection, options.now)),
      unattributed: listing.unattributed.map((connection) => connectionView(connection, options.now)),
    });
  }
  return found;
}

/**
 * The connections a `--revoke` would end: the principal's ones holding any key or trust not yet revoked, live or not.
 * One that has not started verifies once the Worker's clock reaches it, and this clock may run behind that one. Never
 * an unattributed one.
 */
export function revocable(
  found: readonly PrincipalEnvironment[],
): { environment: string; connection: ConnectionView }[] {
  return found.flatMap((entry) =>
    entry.connections
      .filter((connection) => connection.credentialKind !== "none" && connection.revokedAt === null)
      .map((connection) => ({ environment: entry.environment, connection })),
  );
}

/** Revoke every connection {@link revocable} names, each recorded on its environment's trail with `reason`. */
export async function revokePrincipalConnections(options: {
  found: readonly PrincipalEnvironment[];
  reason: string;
  open: OpenRegistry;
  now: Date;
}): Promise<RevokedConnection[]> {
  const revoked: RevokedConnection[] = [];
  for (const { environment, connection } of revocable(options.found)) {
    const result = await options.open(environment, (registry) =>
      registry.revokeConnection(connection.id, options.reason, options.now),
    );
    if (result === null) continue;
    revoked.push({
      environment,
      connectionId: connection.id,
      revokedKeyIds: [...result.revokedKeyIds],
      revokedTrustIds: [...result.revokedTrustIds],
    });
  }
  return revoked;
}

/** One connection, as one line a person reads before deciding. */
function connectionLine(environment: string, connection: ConnectionView): string {
  const state = connection.live ? "live" : connection.revokedAt ? `revoked ${connection.revokedAt}` : "nothing live";
  const purpose = connection.purpose === null ? "" : `  ${JSON.stringify(connection.purpose)}`;
  return `  ${environment}  ${connection.id}  ${connection.actorKind ?? "unknown kind"}  ${connection.credentialKind}  ${state}\n    ${dim(`scopes ${connection.scopes.join(", ") || "none"}  registered ${connection.registeredAt}`)}${purpose}`;
}

/** The listing, as a person reads it: the principal's connections, then the unattributed ones apart. */
export function formatPrincipalConnections(principal: string, found: readonly PrincipalEnvironment[]): string {
  const mine = found.flatMap((entry) =>
    entry.connections.map((connection) => connectionLine(entry.environment, connection)),
  );
  const apart = found.flatMap((entry) =>
    entry.unattributed.map((connection) => connectionLine(entry.environment, connection)),
  );
  const head =
    mine.length === 0
      ? `No connection authorized by ${principal}.\n`
      : `Authorized by ${principal}:\n${mine.join("\n")}\n`;
  const tail =
    apart.length === 0
      ? ""
      : `\nRegistered before principals were recorded. Read these yourself; none is revoked by a principal:\n${apart.join("\n")}\n`;
  return head + tail;
}

/** What a `--revoke` will end, said before it asks. */
export function formatRevocationPlan(principal: string, found: readonly PrincipalEnvironment[]): string {
  const plan = revocable(found);
  if (plan.length === 0) return `Nothing authorized by ${principal} is left to revoke.\n`;
  return `Revoking ${count(plan.length, "connection")} authorized by ${principal}:\n${plan
    .map(({ environment, connection }) => connectionLine(environment, connection))
    .join("\n")}\n`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** What a `--revoke` ended. */
export function formatRevoked(revoked: readonly RevokedConnection[]): string {
  if (revoked.length === 0) return "";
  const lines = revoked.map(
    (entry) =>
      `Revoked ${entry.connectionId} on ${entry.environment}: ${count(entry.revokedKeyIds.length, "key")}, ${count(entry.revokedTrustIds.length, "trust")}.`,
  );
  const trusts = revoked.some((entry) => entry.revokedTrustIds.length > 0)
    ? "A token already minted under a revoked trust stays usable until it expires.\n"
    : "";
  return `${lines.join("\n")}\n${trusts}${formatDone()}\n`;
}

/** What `pithy dashboard connections` found, and with `--revoke` what it ended. */
export interface PrincipalReport {
  principal: string;
  byEnvironment: readonly PrincipalEnvironment[];
  /** Present only on a `--revoke` run. */
  revocations?: readonly RevokedConnection[];
}

/** The report, as `--json` writes it or as a person reads it. */
export function formatPrincipalReport(report: PrincipalReport, options: { json: boolean }): string {
  if (options.json) return `${formatJsonLine({ command: "dashboard.connections", ...report })}\n`;
  if (report.revocations === undefined) return formatPrincipalConnections(report.principal, report.byEnvironment);
  return formatRevoked(report.revocations);
}

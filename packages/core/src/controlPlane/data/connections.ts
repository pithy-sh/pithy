// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { sql } from "kysely";
import { ConflictError } from "../../error/pithyError";
import { type ConnectionCredentialKind, ControlPlaneConnection, type RegisteredKey } from "./connection";
import { activeKeys } from "./keyLifecycle";
import { activeTrusts, type OidcTrust } from "./oidcTrust";
import { CONTROL_PLANE_CONNECTIONS_TABLE, type ControlPlaneDatabase } from "./tables";

/**
 * Every connection in one database, read for a review: which person authorized each, and which still answer.
 *
 * `GET {basePath}/connections` and `pithy dashboard connections` both read through {@link listConnections}, so the
 * Worker's answer and the CLI's cannot list different things.
 */

/** Which credential kinds a connection holds, live or not. */
export function connectionCredentialKind(connection: ControlPlaneConnection): ConnectionCredentialKind {
  const keys = connection.keys.length > 0;
  const trusts = (connection.trusts ?? []).length > 0;
  if (keys && trusts) return "both";
  if (keys) return "key";
  if (trusts) return "trust";
  return "none";
}

/** Whether any key or trust on the connection can verify a call at `now`. */
export function connectionLive(connection: ControlPlaneConnection, now: Date): boolean {
  return activeKeys(connection.keys, now).length > 0 || activeTrusts(connection.trusts ?? [], now).length > 0;
}

/**
 * When the connection was revoked: the latest revocation among its credentials, once none is live and every one of
 * them was revoked. Null while anything is live, and for a connection whose keys merely expired.
 */
export function connectionRevokedAt(connection: ControlPlaneConnection, now: Date): Date | null {
  if (connectionLive(connection, now)) return null;
  const credentials = [...connection.keys, ...(connection.trusts ?? [])];
  if (credentials.length === 0) return null;
  let latest: Date | null = null;
  for (const credential of credentials) {
    if (credential.revokedAt === null) return null;
    if (latest === null || credential.revokedAt.getTime() > latest.getTime()) latest = credential.revokedAt;
  }
  return latest;
}

/** What {@link revokeCredentials} changed. */
export interface RevokedCredentials {
  /** The connection with every key and trust not yet revoked revoked at `now`. */
  readonly connection: ControlPlaneConnection;
  readonly revokedKeyIds: readonly string[];
  readonly revokedTrustIds: readonly string[];
}

/**
 * Revoke every key and trust not yet revoked, whatever its window. One that has not started will verify once its
 * window opens, and the revoker's clock may run behind the Worker that stamped it, so it is revoked too. A credential
 * already revoked keeps its instant.
 */
export function revokeCredentials(connection: ControlPlaneConnection, now: Date): RevokedCredentials {
  const keyIds = connection.keys.filter((key) => key.revokedAt === null).map((key) => key.keyId);
  const trustIds = (connection.trusts ?? []).filter((trust) => trust.revokedAt === null).map((trust) => trust.trustId);
  return {
    connection: {
      ...connection,
      keys: connection.keys.map((key) => (key.revokedAt === null ? { ...key, revokedAt: now } : key)),
      trusts: (connection.trusts ?? []).map((trust) =>
        trust.revokedAt === null ? { ...trust, revokedAt: now } : trust,
      ),
      updatedAt: keyIds.length + trustIds.length > 0 ? now : connection.updatedAt,
    },
    revokedKeyIds: keyIds,
    revokedTrustIds: trustIds,
  };
}

/** Whether a connection was authorized by `principal`. An email, compared without regard to case. */
export function authorizedByPrincipal(connection: ControlPlaneConnection, principal: string): boolean {
  return connection.authorizedBy !== null && connection.authorizedBy.toLowerCase() === principal.toLowerCase();
}

/** Which connections {@link listConnections} reads. */
export interface ConnectionFilter {
  /** Only connections this email authorized. Unattributed connections are listed apart either way. */
  readonly principal?: string | undefined;
  /** Only connections bound to this environment. */
  readonly environment?: string | undefined;
}

/** The connections a filter selects, with the ones no principal was recorded for kept apart. */
export interface ConnectionListing {
  /** Connections with a recorded principal, matching the filter, oldest first. */
  readonly connections: readonly ControlPlaneConnection[];
  /** Connections registered before principals were recorded, oldest first. Never matched by a principal. */
  readonly unattributed: readonly ControlPlaneConnection[];
}

/** Every connection in the database, attributed ones matching the filter, unattributed ones apart. */
export async function listConnections(
  db: ControlPlaneDatabase,
  filter: ConnectionFilter = {},
): Promise<ConnectionListing> {
  let query = db.selectFrom(CONTROL_PLANE_CONNECTIONS_TABLE).selectAll().orderBy("createdAt").orderBy("id");
  if (filter.environment !== undefined) query = query.where("environment", "=", filter.environment);
  const rows = (await query.execute()).map((row) => ControlPlaneConnection.parse(row));
  const { principal } = filter;
  return {
    connections: rows.filter(
      (row) => row.authorizedBy !== null && (principal === undefined || authorizedByPrincipal(row, principal)),
    ),
    unattributed: rows.filter((row) => row.authorizedBy === null),
  };
}

/** Read one connection by id, or null. */
export async function readConnection(db: ControlPlaneDatabase, id: string): Promise<ControlPlaneConnection | null> {
  const row = await db.selectFrom(CONTROL_PLANE_CONNECTIONS_TABLE).selectAll().where("id", "=", id).executeTakeFirst();
  return row ? ControlPlaneConnection.parse(row) : null;
}

/**
 * A connection read for a write to its credential columns, with those columns exactly as stored. A write made from it
 * lands only while they are unchanged, so a revocation landing in between is never overwritten.
 */
export interface ConnectionForWrite {
  readonly connection: ControlPlaneConnection;
  /** The keys column as stored, compared as stored. */
  readonly storedKeys: unknown;
  /** The trusts column as stored, compared as stored. */
  readonly storedTrusts: unknown;
}

/** Read one connection by id for a write, or null. With `environment`, null for a connection bound to another. */
export async function readConnectionForWrite(
  db: ControlPlaneDatabase,
  id: string,
  options: { readonly environment?: string | undefined } = {},
): Promise<ConnectionForWrite | null> {
  let query = db.selectFrom(CONTROL_PLANE_CONNECTIONS_TABLE).selectAll().where("id", "=", id);
  if (options.environment !== undefined) query = query.where("environment", "=", options.environment);
  const row = await query.executeTakeFirst();
  if (!row) return null;
  return { connection: ControlPlaneConnection.parse(row), storedKeys: row.keys, storedTrusts: row.trusts };
}

/**
 * Write a connection's keys and stamp `updatedAt`, only while its keys column still holds what `read` saw. False
 * when it no longer does: another write, a revocation among them, landed in between and nothing was written.
 */
export async function writeKeys(
  db: ControlPlaneDatabase,
  read: ConnectionForWrite,
  keys: readonly RegisteredKey[],
  now: Date,
): Promise<boolean> {
  const result = await db
    .updateTable(CONTROL_PLANE_CONNECTIONS_TABLE)
    .set({
      keys: ControlPlaneConnection.shape.keys.encode([...keys]),
      updatedAt: ControlPlaneConnection.shape.updatedAt.encode(now),
    })
    .where("id", "=", read.connection.id)
    .where(sql<boolean>`${sql.ref("keys")} = ${read.storedKeys}`)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

/** The credential columns a {@link writeCredentials} call replaces. A column left out is not written. */
export interface CredentialColumns {
  readonly keys?: readonly RegisteredKey[] | undefined;
  readonly trusts?: readonly OidcTrust[] | undefined;
}

/**
 * Write the given credential columns and stamp `updatedAt`, only while both the keys and the trusts columns still hold
 * what `read` saw. False when either changed in between, and nothing was written.
 */
export async function writeCredentials(
  db: ControlPlaneDatabase,
  read: ConnectionForWrite,
  columns: CredentialColumns,
  now: Date,
): Promise<boolean> {
  const result = await db
    .updateTable(CONTROL_PLANE_CONNECTIONS_TABLE)
    .set({
      ...(columns.keys === undefined ? {} : { keys: ControlPlaneConnection.shape.keys.encode([...columns.keys]) }),
      ...(columns.trusts === undefined
        ? {}
        : { trusts: ControlPlaneConnection.shape.trusts.encode([...columns.trusts]) }),
      updatedAt: ControlPlaneConnection.shape.updatedAt.encode(now),
    })
    .where("id", "=", read.connection.id)
    .where(sql<boolean>`${sql.ref("keys")} = ${read.storedKeys}`)
    .where(sql<boolean>`${sql.ref("trusts")} = ${read.storedTrusts}`)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

/** How many times {@link revokeConnection} reads again after a write landed between its read and its own. */
const REVOKE_ATTEMPTS = 5;

/**
 * Revoke every key and trust of one connection not yet revoked, or answer null when no connection has that id. With
 * `environment`, a connection bound to another environment answers null too.
 *
 * Writes the two credential columns and the stamp and nothing else on the row, and only while both columns still
 * hold what it read; when another write landed in between, it reads again.
 */
export async function revokeConnection(
  db: ControlPlaneDatabase,
  id: string,
  now: Date,
  options: { readonly environment?: string | undefined } = {},
): Promise<RevokedCredentials | null> {
  for (let attempt = 0; attempt < REVOKE_ATTEMPTS; attempt++) {
    const read = await readConnectionForWrite(db, id, options);
    if (read === null) return null;
    const revoked = revokeCredentials(read.connection, now);
    if (revoked.revokedKeyIds.length + revoked.revokedTrustIds.length === 0) return revoked;
    const columns = { keys: revoked.connection.keys, trusts: revoked.connection.trusts ?? [] };
    if (await writeCredentials(db, read, columns, now)) return revoked;
  }
  throw new ConflictError({
    message: "The connection kept changing while it was being revoked.",
    action: "Revoke it again.",
    detail: `connection ${id} changed between read and write ${REVOKE_ATTEMPTS} times`,
  });
}

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Context } from "hono";
import type { PithyHonoEnv } from "../../capability/capability";
import { personDecision } from "../../cli/command";
import { ConflictError, NotFoundError } from "../../error/pithyError";
import { ControlPlaneAuditActions, safeEmit } from "../audit/actions";
import type { ControlPlaneConnection } from "../data/connection";
import {
  connectionCredentialKind,
  connectionLive,
  connectionRevokedAt,
  listConnections,
  revokeConnection,
} from "../data/connections";
import { type ControlPlaneHandlerDeps, caller } from "./handlers";
import type { ConnectionView, ControlPlaneConnectionsResponse, RevokeConnectionResponse } from "./responses";
import type { ConnectionListQuery, ConnectionParams, RevokeConnectionRequest } from "./schemas";

/** A connection as the listing shows it at `now`: who, what for, which credentials, never key material. */
export function connectionView(connection: ControlPlaneConnection, now: Date): ConnectionView {
  return {
    id: connection.id,
    environment: connection.environment,
    actorKind: connection.actorKind,
    purpose: connection.purpose,
    authorizedBy: connection.authorizedBy,
    credentialKind: connectionCredentialKind(connection),
    scopes: [...connection.scopes],
    trusts: (connection.trusts ?? []).map((trust) => ({
      trustId: trust.trustId,
      issuer: trust.issuer,
      claims: { ...trust.claims },
      revokedAt: trust.revokedAt?.toISOString() ?? null,
    })),
    live: connectionLive(connection, now),
    registeredAt: connection.createdAt.toISOString(),
    revokedAt: connectionRevokedAt(connection, now)?.toISOString() ?? null,
  };
}

/**
 * `GET /control-plane/connections` — every connection bound to this Worker's environment, the caller's own among
 * them. A database shared with another environment holds that environment's rows too, and they are never listed.
 * Read-only.
 */
export function listConnectionsHandler(deps: ControlPlaneHandlerDeps) {
  return async (c: Context<PithyHonoEnv>, query: ConnectionListQuery) => {
    const context = caller(c);
    const now = deps.now();
    const listing = await listConnections(deps.database(c), {
      principal: query.principal,
      environment: context.environment,
    });
    return c.json({
      connections: listing.connections.map((connection) => connectionView(connection, now)),
      unattributed: listing.unattributed.map((connection) => connectionView(connection, now)),
    } satisfies ControlPlaneConnectionsResponse);
  };
}

/**
 * The refusal of a connection asking to revoke itself. The action names the environment it is bound to, since
 * `dashboard disconnect` would otherwise end the connection of the environment its `--env` defaults to.
 */
export function selfRevokeRefusal(connectionId: string, environment: string): ConflictError {
  return new ConflictError({
    message: "A connection cannot revoke itself here.",
    action: `End this connection from the CLI instead. ${personDecision("dashboard disconnect", { flags: { "--env": environment } }, { runtime: true })}`,
    detail: `connection ${connectionId} asked to revoke itself`,
  });
}

/**
 * `POST /control-plane/connections/:connectionId/revoke` — revoke every key and trust another connection in this
 * Worker's environment holds that is not yet revoked. A connection bound to another environment is answered as
 * though it did not exist.
 *
 * Refused on the caller's own connection: a client ending its own access does it through `disconnect`, which also
 * removes what it holds locally.
 */
export function revokeConnectionHandler(deps: ControlPlaneHandlerDeps) {
  return async (c: Context<PithyHonoEnv>, params: ConnectionParams, body: RevokeConnectionRequest) => {
    const context = caller(c);
    if (params.connectionId === context.connectionId)
      throw selfRevokeRefusal(context.connectionId, context.environment);
    const db = deps.database(c);
    const now = deps.now();
    const revoked = await revokeConnection(db, params.connectionId, now, { environment: context.environment });
    if (revoked === null) {
      throw new NotFoundError({
        message: "No connection in this environment has that id.",
        detail: `connection ${params.connectionId} not found in ${context.environment}`,
      });
    }
    const target = revoked.connection;
    await safeEmit(
      c.var.emit,
      {
        action: ControlPlaneAuditActions.connectionRevoked,
        outcome: "success",
        severity: "warning",
        actorType: "control-plane",
        actorId: context.subject,
        resourceType: "controlplane_connection",
        resourceId: target.id,
        requestId: c.req.header("cf-ray"),
        ip: c.req.header("cf-connecting-ip"),
        userAgent: c.req.header("user-agent"),
        metadata: {
          callerConnectionId: context.connectionId,
          connectionId: target.id,
          connectionEnvironment: target.environment,
          authorizedBy: target.authorizedBy,
          reason: body.reason,
          revokedKeyIds: [...revoked.revokedKeyIds],
          revokedTrustIds: [...revoked.revokedTrustIds],
        },
      },
      c.var.log,
    );
    return c.json({
      connection: connectionView(target, now),
      revokedKeyIds: [...revoked.revokedKeyIds],
      revokedTrustIds: [...revoked.revokedTrustIds],
    } satisfies RevokeConnectionResponse);
  };
}

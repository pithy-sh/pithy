// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PurgeExportEntry } from "@pithy-sh/core/src/capability/purge";
import type { Account, Session, User } from "../data/betterAuth";
import type { Device } from "../data/device";
import type { UserLifecycleEvent } from "../data/userLifecycle";
import type {
  DeleteTransition,
  DeletionMode,
  LifecycleTransition,
  RestoreTransition,
  SuspendTransition,
} from "../lifecycle/transitions";
import type {
  AccountDeleteResponse,
  AdminDeviceView,
  AdminSessionView,
  AdminUserDeleteResponse,
  AdminUserExportResponse,
  AdminUserReinstateResponse,
  AdminUserRestoreResponse,
  AdminUserSuspendResponse,
  AdminUserView,
  AuthUserExport,
} from "./responses";

/**
 * The admin projections — what a management client is shown of a user, a session, and a device.
 *
 * **No handler returns a row.** Each function below states what leaves the Worker, and each return
 * type is `z.output` of the matching object in `responses.ts`, so the shape a client validates
 * against and the shape this produces are one declaration. Adding a field to one and not the other
 * does not compile.
 *
 * Separated from `adminRoutes.ts` so they can be exercised without a request, a scope, or a
 * credential: `responses.test.ts` runs each against a fully populated row and compares the result
 * with its schema. A leak here is a leak in every pane, and it should not need a Workers pool to
 * catch.
 */

/**
 * The user projection.
 *
 * Email and display name are personal data and they are here on purpose: identifying the right person
 * is the entire job of a support pane, and `auth:users:read` is precisely the grant an adopter makes
 * when they accept that. Nothing else on `pithy_auth_users` is withheld because nothing else on it is
 * sensitive — the table holds no credential at all, which is what passwordless-only buys.
 *
 * `locale` is projected for the same reason: a support pane answering "why is this person getting
 * English emails" needs to see whether they ever chose, and null — never chosen — is the answer half
 * the time. It is a preference, not a credential.
 */
export function userView(user: User): AdminUserView {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: user.emailVerified,
    image: user.image,
    locale: user.locale,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

/**
 * The session projection — **without the token**.
 *
 * The token *is* the credential: a bearer of it is the user, everywhere, until it expires. Projecting
 * it would turn a read scope into silent impersonation and would leave no trace distinguishable from
 * the person's own activity, which is exactly the capability this surface refuses to offer. The `id` is
 * the handle instead, and it is what `POST /admin/sessions/revoke` accepts.
 *
 * `familyId` is dropped too — it is internal rotation bookkeeping, and a pane that rendered it would
 * invite somebody to act on a correlation the model does not promise to keep stable.
 *
 * The IP and user-agent stay: "where is this person signed in from" is the question the pane exists to
 * answer, and it is the one that catches a stolen session.
 */
export function sessionView(session: Session): AdminSessionView {
  return {
    id: session.id,
    deviceId: session.deviceId,
    ipAddress: session.ipAddress,
    userAgent: session.userAgent,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
  };
}

/**
 * The device projection — **without the push token**.
 *
 * An APNs/FCM token is the capability to put a notification on somebody's lock screen. It is a
 * credential, it is useless to a dashboard, and a management client that held one could message an
 * adopter's users under the adopter's own app identity. It never leaves the Worker.
 */
export function deviceView(device: Device): AdminDeviceView {
  return {
    id: device.id,
    userId: device.userId,
    platform: device.platform,
    name: device.name,
    model: device.model,
    osVersion: device.osVersion,
    appVersion: device.appVersion,
    lastIp: device.lastIp,
    lastSeenAt: device.lastSeenAt.toISOString(),
    createdAt: device.createdAt.toISOString(),
  };
}

/**
 * The suspension projection (#621): the suspension the transition left in force, and the sessions the route
 * revoked after it. Dates cross as ISO-8601, like every other response here.
 */
export function suspensionView(
  userId: string,
  result: SuspendTransition,
  sessionsRevoked: number,
): AdminUserSuspendResponse {
  return {
    userId,
    state: "suspended",
    outcome: result.updated ? "updated" : "suspended",
    suspendedAt: result.suspendedAt.toISOString(),
    suspendedUntil: result.suspendedUntil?.toISOString() ?? null,
    sessionsRevoked,
    mailed: result.mailed,
  };
}

/** The reinstatement projection (#621). A call that found no suspension in force is `unchanged`. */
export function reinstatementView(userId: string, result: LifecycleTransition): AdminUserReinstateResponse {
  return {
    userId,
    state: "active",
    outcome: result.changed ? "reinstated" : "unchanged",
    mailed: result.mailed,
  };
}

/** What became of a deletion's purge: due later, started by the call, or due with nothing bound to start it. */
export type PurgeDisposition = AdminUserDeleteResponse["purge"];

/**
 * The deletion projection (#622): the deletion the transition left in force, the sessions the route revoked
 * after it, and what became of the purge.
 */
export function deletionView(
  userId: string,
  mode: DeletionMode,
  result: DeleteTransition,
  purge: PurgeDisposition,
  sessionsRevoked: number,
): AdminUserDeleteResponse {
  return {
    userId,
    state: "deleted",
    mode,
    outcome: result.outcome,
    deletedAt: result.deletedAt.toISOString(),
    purgeAfter: result.purgeAfter.toISOString(),
    purge,
    sessionsRevoked,
    mailed: result.mailed,
  };
}

/** The restoration projection (#622). A call that found the account not deleted is `unchanged`. */
export function restorationView(userId: string, result: RestoreTransition): AdminUserRestoreResponse {
  return { userId, state: result.state, outcome: result.changed ? "restored" : "unchanged" };
}

/** The self-service deletion projection (#622). */
export function accountDeletionView(result: DeleteTransition): AccountDeleteResponse {
  return { state: "deleted", purgeAfter: result.purgeAfter.toISOString(), mailed: result.mailed };
}

/** A date as the wire carries it, or null. */
function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

/**
 * What auth holds about one account, as its export carries it (#622) — the person's own data, projected through
 * the same views a support pane sees, so a session token, a provider token and a push token are absent here by
 * the same construction that keeps them out of every other response. The operator who made a transition is
 * theirs to disclose, not the person's, so the history carries the kind of actor and not its id.
 */
export function authUserExportView(input: {
  user: User;
  sessions: readonly Session[];
  accounts: readonly Pick<Account, "providerId" | "createdAt">[];
  devices: readonly Device[];
  history: readonly UserLifecycleEvent[];
  plugins?: Record<string, Record<string, unknown>[]>;
}): AuthUserExport {
  const { user } = input;
  return {
    user: {
      ...userView(user),
      suspendedAt: iso(user.suspendedAt),
      suspendedUntil: iso(user.suspendedUntil),
      deletedAt: iso(user.deletedAt),
      purgeAfter: iso(user.purgeAfter),
    },
    sessions: input.sessions.map(sessionView),
    providers: input.accounts.map((account) => ({
      providerId: account.providerId,
      createdAt: account.createdAt.toISOString(),
    })),
    devices: input.devices.map(deviceView),
    history: input.history.map((event) => ({
      action: event.action,
      actorType: event.actorType,
      reason: event.reason,
      suspendedUntil: iso(event.suspendedUntil),
      createdAt: event.createdAt.toISOString(),
    })),
    plugins: input.plugins ?? {},
  };
}

/** The export document (#622): who it is about, when it was read, and every capability's part. */
export function exportView(
  userId: string,
  exportedAt: Date,
  entries: readonly PurgeExportEntry[],
): AdminUserExportResponse {
  return {
    subject: { type: "user", id: userId },
    exportedAt: exportedAt.toISOString(),
    capabilities: entries.map((entry) => ({ ...entry })),
  };
}

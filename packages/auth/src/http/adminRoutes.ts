// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { zValidator } from "@hono/zod-validator";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { ControlPlaneContext } from "@pithy-sh/core/src/controlPlane/context";
import { requireControlPlane } from "@pithy-sh/core/src/controlPlane/http/guard";
import { MAX_PAGE_SIZE } from "@pithy-sh/core/src/data/cursor";
import { InternalError, NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import { validationHook } from "@pithy-sh/core/src/http/validation";
import type { Context, Hono } from "hono";
import {
  findSessionById,
  getUser,
  listDeviceRegistry,
  listUserDevices,
  listUserSessions,
  listUsers,
  userProviders,
  userSessionTokens,
} from "../admin/users";
import { AuthAuditActions } from "../audit/actions";
import { correlation, emitControlPlaneAction } from "../audit/emit";
import type { AuthWiring } from "../capability";
import type { Session, User } from "../data/betterAuth";
import type { Device } from "../data/device";
import { authDatabase } from "../data/tables";
import { deleteDevice, deviceSessionTokens } from "../device/registry";
import {
  AUTH_DEVICES_READ_SCOPE,
  AUTH_DEVICES_REVOKE_SCOPE,
  AUTH_SESSIONS_REVOKE_SCOPE,
  AUTH_USERS_LOGOUT_SCOPE,
  AUTH_USERS_READ_SCOPE,
} from "./guards";
import { getAuthInstance, resolveDb } from "./resolve";
import { ListDevicesQuery, ListUsersQuery, RevokeDeviceBody, RevokeSessionBody, UserIdParam } from "./schemas";

type Ctx = Context<PithyHonoEnv>;

/**
 * The control-plane admin surface: the reads a management dashboard's user panes resolve to, and the
 * revocations an incident costs.
 *
 *   GET  {base}/admin/users                          auth:users:read       query: ListUsersQuery
 *   GET  {base}/admin/users/:userId                  auth:users:read       param: UserIdParam
 *   GET  {base}/admin/devices                        auth:devices:read     query: ListDevicesQuery
 *   POST {base}/admin/sessions/revoke                auth:sessions:revoke  json:  RevokeSessionBody
 *   POST {base}/admin/users/:userId/sessions/revoke  auth:users:logout     param: UserIdParam
 *   POST {base}/admin/users/:userId/devices/revoke   auth:devices:revoke   param + json
 *
 * ## Registered before the catch-all, or dead
 *
 * `createAuthRoutes` ends with `app.all(`${base}/*`, handleBetterAuth)`, and `handleBetterAuth` returns
 * a Response — which ends the chain. **Anything registered after that line is silently unreachable**,
 * and a route-inspection test would still pass because the route is genuinely mounted; it just never
 * runs. So these are registered from inside `createAuthRoutes` before the catch-all, and
 * `routeContract.test.ts` proves it with a real request rather than by reading `app.routes`.
 *
 * ## `requireControlPlane` only, never `requireAuth`
 *
 * See `guards.ts` for the whole argument. The short version: the seam deliberately leaves `c.var.auth`
 * null, so an auth gate here would deny every legitimate management call forever, and there is no user
 * to sign in as that would fix it.
 *
 * ## Validators after the gate, on every line
 *
 * A validator ahead of the gate turns a 403 into a 400 and tells an unverified caller which requests
 * were well-formed. On this surface that is a live oracle for an adopter's identity model, so the
 * ordering is asserted in `routeContract.test.ts` rather than trusted to the order somebody typed the
 * arguments in.
 *
 * ## Every response is a deliberate projection
 *
 * No handler returns a row. `sessionView` drops the session **token** — projecting it would hand a
 * management client the ability to act *as* the user, which is the impersonation this surface
 * deliberately does not offer. `deviceView` drops the **push token** — a credential for sending
 * notifications to somebody's phone, which no dashboard pane needs. And the account link is read as a
 * list of provider slugs by a query that selects only `providerId`, so the OAuth `accessToken`,
 * `refreshToken` and `idToken` are never loaded at all.
 */

/** The auth Kysely for this request. */
function db(c: Ctx, wiring: AuthWiring) {
  return authDatabase(resolveDb(c.env, wiring.config.database));
}

/**
 * The verified management client behind a control-plane call.
 *
 * `requireControlPlane()` has run on every route below, so a null context is a wiring mistake rather
 * than an unverified request — hence `InternalError`, not a 401. Deliberately not read off `c.var.auth`:
 * a management client has no user row and no session, and keeping the two accessors apart is what stops
 * a control-plane caller from being recorded as, or mistaken for, a user of this app.
 */
function controlPlaneCaller(c: Ctx): ControlPlaneContext {
  const caller = c.var.controlPlane;
  if (!caller) {
    throw new InternalError({
      message: "Authentication is misconfigured.",
      detail: "requireControlPlane() must run before an auth admin handler reads the management caller.",
    });
  }
  return caller;
}

/** The request correlation every admin audit event carries. */
function context(c: Ctx): { ip?: string; userAgent?: string; requestId?: string } {
  return { ...correlation(c.req.raw.headers), requestId: c.req.header("cf-ray") };
}

/** A user as a management client may see them. */
interface AdminUserView {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The user projection.
 *
 * Email and display name are personal data and they are here on purpose: identifying the right person
 * is the entire job of a support pane, and `auth:users:read` is precisely the grant an adopter makes
 * when they accept that. Nothing else on `pithy_auth_users` is withheld because nothing else on it is
 * sensitive — the table holds no credential at all, which is what passwordless-only buys.
 */
function userView(user: User): AdminUserView {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: user.emailVerified,
    image: user.image,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

/** A session as a management client may see it. */
interface AdminSessionView {
  id: string;
  deviceId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
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
function sessionView(session: Session): AdminSessionView {
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

/** A registered device as a management client may see it. */
interface AdminDeviceView {
  id: string;
  userId: string;
  platform: string;
  name: string | null;
  model: string | null;
  osVersion: string | null;
  appVersion: string | null;
  lastIp: string | null;
  lastSeenAt: string;
  createdAt: string;
}

/**
 * The device projection — **without the push token**.
 *
 * An APNs/FCM token is the capability to put a notification on somebody's lock screen. It is a
 * credential, it is useless to a dashboard, and a management client that held one could message an
 * adopter's users under the adopter's own app identity. It never leaves the Worker.
 */
function deviceView(device: Device): AdminDeviceView {
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

/** Delete sessions through Better Auth's own adapter, so its bookkeeping stays consistent. */
async function revokeTokens(c: Ctx, wiring: AuthWiring, tokens: readonly string[]): Promise<number> {
  if (tokens.length === 0) return 0;
  // `internalAdapter.deleteSession`, never a raw DELETE — the same path `revokeMyDevice` and the
  // reuse-detection family revoke take. A direct delete would leave whatever Better Auth keeps beside
  // the row (secondary storage, its own caches) pointing at a session that no longer exists.
  const ctx = await (await getAuthInstance(c, wiring)).$context;
  for (const token of tokens) {
    await ctx.internalAdapter.deleteSession(token);
  }
  return tokens.length;
}

/**
 * Register the control-plane admin routes. Called by `createAuthRoutes` **before** the Better Auth
 * catch-all; see the file header for why that ordering is load-bearing.
 */
export function registerAuthAdminRoutes(wiring: AuthWiring): (app: Hono<PithyHonoEnv>) => void {
  return (app) => {
    const base = wiring.config.basePath;

    app.get(
      `${base}/admin/users`,
      requireControlPlane(AUTH_USERS_READ_SCOPE),
      zValidator("query", ListUsersQuery, validationHook),
      async (c) => {
        const query = c.req.valid("query");
        const caller = controlPlaneCaller(c);
        const page = await listUsers(db(c, wiring), query);
        await emitControlPlaneAction(c.var.emit, {
          action: AuthAuditActions.adminUsersListed,
          subject: caller.subject,
          connectionId: caller.connectionId,
          resourceType: "user",
          ...context(c),
          // `searched`, not the term. A search term on this route is usually somebody's email address,
          // and the audit trail is queryable and kept far longer than the pane that displayed it — so
          // recording the term would copy the personal data the caller already saw into a second store
          // with a different retention policy. That it was a search, and how much came back, is what
          // makes an exfiltration pattern visible; the string itself adds nothing to that.
          metadata: { searched: query.search !== undefined, returned: page.items.length },
        });
        return c.json({ users: page.items.map(userView), nextCursor: page.nextCursor });
      },
    );

    app.get(
      `${base}/admin/users/:userId`,
      requireControlPlane(AUTH_USERS_READ_SCOPE),
      zValidator("param", UserIdParam, validationHook),
      async (c) => {
        const { userId } = c.req.valid("param");
        const caller = controlPlaneCaller(c);
        const database = db(c, wiring);

        const user = await getUser(database, userId);
        if (!user)
          throw new NotFoundError({ message: "No such user.", detail: `no pithy_auth_users row for ${userId}` });

        // Bounded, because a device id is client-generated: a user can mint as many device rows as they
        // like, so an unbounded sub-list would let any end user decide how much work this pane does.
        const [sessions, devices, providers] = await Promise.all([
          listUserSessions(database, userId, MAX_PAGE_SIZE),
          listUserDevices(database, userId, MAX_PAGE_SIZE),
          userProviders(database, userId),
        ]);

        await emitControlPlaneAction(c.var.emit, {
          action: AuthAuditActions.adminUserRead,
          subject: caller.subject,
          connectionId: caller.connectionId,
          resourceType: "user",
          resourceId: userId,
          ...context(c),
          metadata: { sessions: sessions.items.length, devices: devices.items.length },
        });

        return c.json({
          user: userView(user),
          providers,
          sessions: sessions.items.map(sessionView),
          sessionsTruncated: sessions.truncated,
          devices: devices.items.map(deviceView),
          devicesTruncated: devices.truncated,
        });
      },
    );

    app.get(
      `${base}/admin/devices`,
      requireControlPlane(AUTH_DEVICES_READ_SCOPE),
      zValidator("query", ListDevicesQuery, validationHook),
      async (c) => {
        const query = c.req.valid("query");
        const caller = controlPlaneCaller(c);
        const page = await listDeviceRegistry(db(c, wiring), query);
        await emitControlPlaneAction(c.var.emit, {
          action: AuthAuditActions.adminDevicesListed,
          subject: caller.subject,
          connectionId: caller.connectionId,
          resourceType: "device",
          resourceId: query.userId ?? null,
          ...context(c),
          metadata: { returned: page.items.length, filteredByUser: query.userId !== undefined },
        });
        return c.json({ devices: page.items.map(deviceView), nextCursor: page.nextCursor });
      },
    );

    app.post(
      `${base}/admin/sessions/revoke`,
      requireControlPlane(AUTH_SESSIONS_REVOKE_SCOPE),
      zValidator("json", RevokeSessionBody, validationHook),
      async (c) => {
        const { sessionId } = c.req.valid("json");
        const caller = controlPlaneCaller(c);
        const session = await findSessionById(db(c, wiring), sessionId);

        // Idempotent rather than a 404, so a retried job — the normal shape of automated incident
        // response — lands on the state the caller meant instead of failing the second time. It also
        // keeps this scope from answering "does this session exist" any more precisely than "did I
        // revoke one", which matters because holding it confers no right to read the session at all.
        const revoked = session ? await revokeTokens(c, wiring, [session.token]) : 0;

        await emitControlPlaneAction(c.var.emit, {
          action: AuthAuditActions.adminSessionRevoked,
          subject: caller.subject,
          connectionId: caller.connectionId,
          resourceType: "session",
          resourceId: sessionId,
          ...context(c),
          // The owning user reaches the trail, where it belongs, and not the response — the caller holds
          // a revoke scope, which is not a licence to learn whose session it was.
          metadata: { revoked, userId: session?.userId ?? null },
        });

        return c.json({ revoked });
      },
    );

    app.post(
      `${base}/admin/users/:userId/sessions/revoke`,
      requireControlPlane(AUTH_USERS_LOGOUT_SCOPE),
      zValidator("param", UserIdParam, validationHook),
      async (c) => {
        const { userId } = c.req.valid("param");
        const caller = controlPlaneCaller(c);
        const tokens = await userSessionTokens(db(c, wiring), userId);
        const revoked = await revokeTokens(c, wiring, tokens);

        await emitControlPlaneAction(c.var.emit, {
          action: AuthAuditActions.adminUserSessionsRevoked,
          subject: caller.subject,
          connectionId: caller.connectionId,
          resourceType: "user",
          resourceId: userId,
          ...context(c),
          metadata: { revoked },
        });

        // No 404 for an unknown user, for the same two reasons as the single-session revoke: signing out
        // somebody who is already signed out everywhere is a success, and this scope is not a read scope.
        return c.json({ revoked });
      },
    );

    app.post(
      `${base}/admin/users/:userId/devices/revoke`,
      requireControlPlane(AUTH_DEVICES_REVOKE_SCOPE),
      zValidator("param", UserIdParam, validationHook),
      zValidator("json", RevokeDeviceBody, validationHook),
      async (c) => {
        const { userId } = c.req.valid("param");
        const { deviceId } = c.req.valid("json");
        const caller = controlPlaneCaller(c);
        const database = db(c, wiring);

        // Both halves are scoped to the named user, which is what the devices table's composite primary
        // key exists for: a device id belonging to somebody else matches nothing here rather than
        // revoking a stranger's phone.
        const tokens = await deviceSessionTokens(database, userId, deviceId);
        const revoked = await revokeTokens(c, wiring, tokens);
        const removed = await deleteDevice(database, userId, deviceId);

        await emitControlPlaneAction(c.var.emit, {
          action: AuthAuditActions.adminDeviceRevoked,
          subject: caller.subject,
          connectionId: caller.connectionId,
          resourceType: "device",
          resourceId: deviceId,
          ...context(c),
          metadata: { userId, revoked, removed },
        });

        return c.json({ revoked, removed });
      },
    );
  };
}

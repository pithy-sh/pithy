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
  type AdminSubList,
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
import type {
  AdminDeviceRevokeResponse,
  AdminDevicesResponse,
  AdminRevokeResponse,
  AdminUserResponse,
  AdminUsersResponse,
} from "./responses";
import { ListDevicesQuery, ListUsersQuery, RevokeDeviceBody, RevokeSessionBody, UserIdParam } from "./schemas";
import { deviceView, sessionView, userView } from "./views";

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
 * ## Every response is a deliberate projection, and every projection has a schema
 *
 * No handler returns a row. The projections live in `views.ts` and the objects a client validates
 * against live in `responses.ts`, each view typed as `z.output` of its own schema — so what this
 * Worker sends and what a management client is told to expect are one declaration rather than two
 * that drift. `sessionView` drops the session **token**; `deviceView` drops the **push token**; and
 * the account link is read as a list of provider slugs by a query that selects only `providerId`, so
 * the OAuth `accessToken`, `refreshToken` and `idToken` are never loaded at all.
 *
 * Each `c.json` below is `satisfies`-checked against its envelope. The check belongs at compile time:
 * parsing every response would spend a validation pass on data this Worker just built from its own
 * rows, and it would turn a shape mistake into a 500 in production rather than a red build.
 */

/** The auth Kysely for this request. */
function db(c: Ctx, wiring: AuthWiring) {
  return authDatabase(resolveDb(c.env, wiring.config.database));
}

/**
 * One of the user pane's sub-reads, guarded and projected in one step (#380).
 *
 * **`try`/`catch` inside an `async` function, never `.catch()`.** The read is *called* inside the `try`,
 * so a seam that throws before it returns a promise is caught too — a rejected promise is not the only
 * way a D1 read fails, and a `.catch()` guard has been escaped by exactly that before (#371).
 *
 * **The guard takes no binding.** The state is the whole of what travels; what the read threw names a
 * query and a table, and this response goes to a management client across a trust boundary.
 *
 * It projects while it is here, because the alternative is a second helper mapping a union it just
 * built, and a projection that runs outside the guard is a second place a row can throw.
 */
async function readBounded<T, V>(
  read: () => Promise<AdminSubList<T>>,
  project: (row: T) => V,
): Promise<{ state: "read"; items: V[]; truncated: boolean } | { state: "unavailable" }> {
  try {
    const list = await read();
    return { state: "read", items: list.items.map(project), truncated: list.truncated };
  } catch {
    return { state: "unavailable" };
  }
}

/** The same guard for a read with no bound to exceed — the provider slugs, which carry no truncation. */
async function readWhole<T>(
  read: () => Promise<T[]>,
): Promise<{ state: "read"; items: T[] } | { state: "unavailable" }> {
  try {
    return { state: "read", items: await read() };
  } catch {
    return { state: "unavailable" };
  }
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
        return c.json({ users: page.items.map(userView), nextCursor: page.nextCursor } satisfies AdminUsersResponse);
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
        //
        // Each read is guarded on its own (#380). They are three independent tables and this was a
        // `Promise.all`, so one of them failing 500'd the whole page — the user, their sessions and
        // their devices all lost to whichever list would not read, on the pane a support agent opens
        // when an account is already in trouble. Still concurrent: the guard is inside each arm.
        const [sessions, devices, providers] = await Promise.all([
          readBounded(() => listUserSessions(database, userId, MAX_PAGE_SIZE), sessionView),
          readBounded(() => listUserDevices(database, userId, MAX_PAGE_SIZE), deviceView),
          readWhole(() => userProviders(database, userId)),
        ]);

        await emitControlPlaneAction(c.var.emit, {
          action: AuthAuditActions.adminUserRead,
          subject: caller.subject,
          connectionId: caller.connectionId,
          resourceType: "user",
          resourceId: userId,
          ...context(c),
          // `null` where a list did not read, never `0`. The trail is what answers "how much did this
          // caller see", and a zero there is a claim that the user had none.
          metadata: {
            sessions: sessions.state === "read" ? sessions.items.length : null,
            devices: devices.state === "read" ? devices.items.length : null,
          },
        });

        return c.json({
          user: userView(user),
          providers,
          sessions,
          devices,
        } satisfies AdminUserResponse);
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
        return c.json({
          devices: page.items.map(deviceView),
          nextCursor: page.nextCursor,
        } satisfies AdminDevicesResponse);
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
          // a revoke scope, which is not a license to learn whose session it was.
          metadata: { revoked, userId: session?.userId ?? null },
        });

        return c.json({ revoked } satisfies AdminRevokeResponse);
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
        return c.json({ revoked } satisfies AdminRevokeResponse);
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

        return c.json({ revoked, removed } satisfies AdminDeviceRevokeResponse);
      },
    );
  };
}

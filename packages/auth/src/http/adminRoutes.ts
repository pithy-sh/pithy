// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { purgeExports } from "@pithy-sh/core/src/capability/purge";
import type { ControlPlaneContext } from "@pithy-sh/core/src/controlPlane/context";
import { requireControlPlane } from "@pithy-sh/core/src/controlPlane/http/guard";
import { MAX_PAGE_SIZE } from "@pithy-sh/core/src/data/cursor";
import { InternalError, NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import { describeRoute } from "@pithy-sh/core/src/http/routeSpec";
import { validate } from "@pithy-sh/core/src/http/validation";
import { workflowBindingFor } from "@pithy-sh/core/src/workflow/dispatch";
import type { Context, Hono } from "hono";
import type { z } from "zod";
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
import { auditedLifecycleCall, recordLifecycleRefusal } from "../lifecycle/audited";
import { MAX_REASON } from "../lifecycle/reason";
import { lifecycleDeps } from "../lifecycle/request";
import {
  type DeleteTransition,
  deleteUser,
  type LifecycleActor,
  reinstateUser,
  requirePresent,
  restoreUser,
  suspendUser,
} from "../lifecycle/transitions";
import { AUTH_PURGE_BINDING } from "../purge/specs";
import { startPurgeInstance } from "../purge/start";
import {
  AUTH_DEVICES_READ_SCOPE,
  AUTH_DEVICES_REVOKE_SCOPE,
  AUTH_SESSIONS_REVOKE_SCOPE,
  AUTH_USERS_DELETE_SCOPE,
  AUTH_USERS_EXPORT_SCOPE,
  AUTH_USERS_LOGOUT_SCOPE,
  AUTH_USERS_READ_SCOPE,
  AUTH_USERS_SUSPEND_SCOPE,
} from "./guards";
import { getAuthInstance, resolveDb } from "./resolve";
import {
  AdminDeviceRevokeResponse,
  AdminDevicesResponse,
  AdminRevokeResponse,
  AdminUserDeleteResponse,
  AdminUserExportResponse,
  AdminUserReinstateResponse,
  AdminUserResponse,
  AdminUserRestoreResponse,
  AdminUserSuspendResponse,
  AdminUsersResponse,
} from "./responses";
import {
  DeleteUserBody,
  ExportUserQuery,
  ListDevicesQuery,
  ListUsersQuery,
  ReinstateUserBody,
  RestoreUserBody,
  RevokeDeviceBody,
  RevokeSessionBody,
  SuspendUserBody,
  UserIdParam,
} from "./schemas";
import {
  deletionView,
  deviceView,
  exportView,
  type PurgeDisposition,
  reinstatementView,
  restorationView,
  sessionView,
  suspensionView,
  userView,
} from "./views";

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
 *   POST {base}/admin/users/:userId/suspend          auth:users:suspend    param + json: SuspendUserBody
 *   POST {base}/admin/users/:userId/reinstate        auth:users:suspend    param + json: ReinstateUserBody
 *   DELETE {base}/admin/users/:userId                auth:users:delete     param + json: DeleteUserBody
 *   POST {base}/admin/users/:userId/restore          auth:users:delete     param + json: RestoreUserBody
 *   GET  {base}/admin/users/:userId/export           auth:users:export     param + query: ExportUserQuery
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
 * What a lifecycle route hands `../lifecycle/`: the transitions' dependencies, with the request's correlation
 * and the connection on every audit event they write, and the operator as the actor.
 *
 * The actor is the token's verified `sub` — which person at the dashboard — the same id every other admin
 * event records, so the trail and the history table name the same somebody.
 */
function lifecycleCall(c: Ctx, wiring: AuthWiring, caller: ControlPlaneContext, userId: string, reason: string) {
  const correlated = context(c);
  return {
    deps: lifecycleDeps(c, wiring, { ...correlated, metadata: { connectionId: caller.connectionId } }),
    actor: { type: "control-plane", id: caller.subject } satisfies LifecycleActor,
    // Named so the refusal for a deleted account says which route comes first.
    restoreRoute: `POST ${wiring.config.basePath}/admin/users/${userId}/restore`,
    audit: { subject: caller.subject, connectionId: caller.connectionId, userId, reason, ...correlated },
  };
}

/**
 * A lifecycle route's body validator, which audits the bodies it refuses (#621). Every call is on the trail,
 * a refusal included, and a body the validator turns away never reaches `auditedLifecycleCall`. So it is
 * recorded here, as `denied` under the route's own action, with whatever reason the body carried — cut to the
 * reason's own limit, so a refused essay is not stored whole — and the 400 is thrown as before.
 */
function lifecycleBody<Schema extends z.ZodType>(schema: Schema, action: string | ((body: unknown) => string)) {
  return validate("json", schema, async (raw, error, body) => {
    // The route validated its `:userId` before its body, so it is readable here.
    const c = raw as Context<PithyHonoEnv, string, { out: { param: z.output<typeof UserIdParam> } }>;
    const caller = controlPlaneCaller(c);
    const reason = body && typeof body === "object" ? (body as { reason?: unknown }).reason : undefined;
    await recordLifecycleRefusal(
      c.var.emit,
      {
        action: typeof action === "string" ? action : action(body),
        subject: caller.subject,
        connectionId: caller.connectionId,
        userId: c.req.valid("param").userId,
        reason: typeof reason === "string" ? reason.slice(0, MAX_REASON) : null,
        ...context(c),
      },
      error,
      // Hono's own refusal of a body that is not JSON carries no code; the client sees this one.
      { code: "validation/invalid_input", outcome: "denied" },
    );
  });
}

/**
 * End every session an account holds, after its columns are written — never before, for the reason the suspend
 * route gives: enforcement refuses the account the moment the columns land, and revoking first would leave a
 * window for a sign-in the revocation never saw. Through Better Auth's adapter, so `onSessionRevoked` hears
 * each, and recorded under `auth/admin_user_sessions_revoked` with the cause.
 */
async function endSessions(
  c: Ctx,
  wiring: AuthWiring,
  caller: ControlPlaneContext,
  userId: string,
  cause: string,
): Promise<number> {
  const revoked = await revokeTokens(c, wiring, await userSessionTokens(db(c, wiring), userId));
  await emitControlPlaneAction(c.var.emit, {
    action: AuthAuditActions.adminUserSessionsRevoked,
    subject: caller.subject,
    connectionId: caller.connectionId,
    resourceType: "user",
    resourceId: userId,
    ...context(c),
    metadata: { revoked, cause },
  });
  return revoked;
}

/**
 * Start the purge of one account now (#622): `started` when this Worker binds the purge Workflow and it took the
 * instance — or already held it — and `pending` when it binds none or the start failed; the account is due
 * either way, and the daily pass starts it. A failed start is not this call's failure: the deletion is already
 * written, and a 500 over it would invite a retry that finds the account deleted and says nothing new.
 *
 * Under the instance id the deletion names (`../purge/start.ts`), so a hard deletion repeated, or one the daily
 * pass also finds due, is the one purge and never a second.
 */
async function startPurge(
  c: Ctx,
  result: DeleteTransition,
  userId: string,
  notify: boolean | undefined,
): Promise<PurgeDisposition> {
  const log = c.var.log.child("auth");
  const binding = workflowBindingFor(c.env as Record<string, unknown>, AUTH_PURGE_BINDING);
  if (!binding) {
    log.warn("a deletion found no purge Workflow bound; the purge is pending", { userId });
    return "pending";
  }
  try {
    await startPurgeInstance(binding, {
      userId,
      deletedAt: result.deletedAt.getTime(),
      ...(notify === undefined ? {} : { notify }),
      at: new Date(),
    });
    return "started";
  } catch (error) {
    log.warn("the purge could not be started; the daily pass will start it", {
      userId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return "pending";
  }
}

/** What becomes of a soft deletion's purge: due later, or — when its window has already closed — due now. */
function scheduledOrDue(result: DeleteTransition): PurgeDisposition | "due" {
  return result.purgeAfter.getTime() > Date.now() ? "scheduled" : "due";
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
      describeRoute({
        summary: "Page through the users, newest first, optionally searching by email or name.",
        verification: "control-plane",
        scopes: [AUTH_USERS_READ_SCOPE],
        responses: { 200: AdminUsersResponse },
      }),
      requireControlPlane(AUTH_USERS_READ_SCOPE),
      validate("query", ListUsersQuery),
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
        // One instant for the page, so every user on it is judged at the same moment.
        const now = new Date();
        return c.json({
          users: page.items.map((user) => userView(user, now)),
          nextCursor: page.nextCursor,
        } satisfies AdminUsersResponse);
      },
    );

    app.get(
      `${base}/admin/users/:userId`,
      describeRoute({
        summary: "Read one user with their sessions, devices and linked providers.",
        verification: "control-plane",
        scopes: [AUTH_USERS_READ_SCOPE],
        responses: { 200: AdminUserResponse },
      }),
      requireControlPlane(AUTH_USERS_READ_SCOPE),
      validate("param", UserIdParam),
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
          user: userView(user, new Date()),
          providers,
          sessions,
          devices,
        } satisfies AdminUserResponse);
      },
    );

    app.get(
      `${base}/admin/devices`,
      describeRoute({
        summary: "Page through the device registry, most recently seen first.",
        verification: "control-plane",
        scopes: [AUTH_DEVICES_READ_SCOPE],
        responses: { 200: AdminDevicesResponse },
      }),
      requireControlPlane(AUTH_DEVICES_READ_SCOPE),
      validate("query", ListDevicesQuery),
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
      describeRoute({
        summary: "Revoke one session by its id.",
        verification: "control-plane",
        scopes: [AUTH_SESSIONS_REVOKE_SCOPE],
        responses: { 200: AdminRevokeResponse },
      }),
      requireControlPlane(AUTH_SESSIONS_REVOKE_SCOPE),
      validate("json", RevokeSessionBody),
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
      describeRoute({
        summary: "Sign one user out everywhere.",
        verification: "control-plane",
        scopes: [AUTH_USERS_LOGOUT_SCOPE],
        responses: { 200: AdminRevokeResponse },
      }),
      requireControlPlane(AUTH_USERS_LOGOUT_SCOPE),
      validate("param", UserIdParam),
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
      describeRoute({
        summary: "Sign out one of a user's devices and remove it from the registry.",
        verification: "control-plane",
        scopes: [AUTH_DEVICES_REVOKE_SCOPE],
        responses: { 200: AdminDeviceRevokeResponse },
      }),
      requireControlPlane(AUTH_DEVICES_REVOKE_SCOPE),
      validate("param", UserIdParam),
      validate("json", RevokeDeviceBody),
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

    app.post(
      `${base}/admin/users/:userId/suspend`,
      describeRoute({
        summary: "Suspend one user, with a reason: their sessions end and every sign-in is refused.",
        verification: "control-plane",
        scopes: [AUTH_USERS_SUSPEND_SCOPE],
        responses: { 200: AdminUserSuspendResponse },
      }),
      requireControlPlane(AUTH_USERS_SUSPEND_SCOPE),
      validate("param", UserIdParam),
      lifecycleBody(SuspendUserBody, AuthAuditActions.adminUserSuspended),
      async (c) => {
        const { userId } = c.req.valid("param");
        const { reason, until, notify } = c.req.valid("json");
        const caller = controlPlaneCaller(c);
        const call = lifecycleCall(c, wiring, caller, userId, reason);

        // Every call is audited: the transition audits a suspension it writes, and this records the refusals.
        // A suspension always writes — a fresh one or a restatement — so there is no no-op to record.
        const result = await auditedLifecycleCall(
          c.var.emit,
          { action: AuthAuditActions.adminUserSuspended, ...call.audit },
          () =>
            suspendUser(call.deps, {
              userId,
              actor: call.actor,
              reason,
              until: until ?? null,
              ...(notify === undefined ? {} : { notify }),
              restoreRoute: call.restoreRoute,
            }),
          () => false,
        );

        // After the columns, never before. Enforcement refuses the account the moment they are written, so a
        // session alive in between meets `auth/account_suspended`; revoking first would leave a window where a
        // sign-in could mint one the revocation never saw. Every call revokes, a restatement included, so a
        // credential that slipped past an earlier one does not outlive this one. Through Better Auth's adapter,
        // so `onSessionRevoked` hears each. A refresh token is a session token here, so this ends both.
        const revoked = await revokeTokens(c, wiring, await userSessionTokens(db(c, wiring), userId));
        await emitControlPlaneAction(c.var.emit, {
          action: AuthAuditActions.adminUserSessionsRevoked,
          subject: caller.subject,
          connectionId: caller.connectionId,
          resourceType: "user",
          resourceId: userId,
          ...context(c),
          metadata: { revoked, cause: "suspended" },
        });

        return c.json(suspensionView(userId, result, revoked) satisfies AdminUserSuspendResponse);
      },
    );

    app.post(
      `${base}/admin/users/:userId/reinstate`,
      describeRoute({
        summary: "Lift one user's suspension, with a reason. They sign in again; no session is restored.",
        verification: "control-plane",
        scopes: [AUTH_USERS_SUSPEND_SCOPE],
        responses: { 200: AdminUserReinstateResponse },
      }),
      requireControlPlane(AUTH_USERS_SUSPEND_SCOPE),
      validate("param", UserIdParam),
      lifecycleBody(ReinstateUserBody, AuthAuditActions.adminUserReinstated),
      async (c) => {
        const { userId } = c.req.valid("param");
        const { reason, notify } = c.req.valid("json");
        const caller = controlPlaneCaller(c);
        const call = lifecycleCall(c, wiring, caller, userId, reason);

        // An account with no suspension in force is a 200 that changed nothing — the state the caller asked
        // for already holds — and is audited as exactly that.
        const result = await auditedLifecycleCall(
          c.var.emit,
          { action: AuthAuditActions.adminUserReinstated, ...call.audit },
          () =>
            reinstateUser(call.deps, {
              userId,
              actor: call.actor,
              reason,
              ...(notify === undefined ? {} : { notify }),
              restoreRoute: call.restoreRoute,
            }),
          (outcome) => !outcome.changed,
        );

        return c.json(reinstatementView(userId, result) satisfies AdminUserReinstateResponse);
      },
    );

    app.delete(
      `${base}/admin/users/:userId`,
      describeRoute({
        summary:
          "Delete one user, with a reason: soft by default, restorable until the purge window closes; hard when named, purged now.",
        verification: "control-plane",
        scopes: [AUTH_USERS_DELETE_SCOPE],
        responses: { 200: AdminUserDeleteResponse },
      }),
      requireControlPlane(AUTH_USERS_DELETE_SCOPE),
      validate("param", UserIdParam),
      // A refused body is recorded under the mode it asked for, so a malformed hard deletion is on the trail as
      // an attempt at one. Only the exact `"hard"` reads as hard, as only it parses as hard.
      lifecycleBody(DeleteUserBody, (body) =>
        (body as { mode?: unknown } | null)?.mode === "hard"
          ? AuthAuditActions.adminUserHardDeleted
          : AuthAuditActions.adminUserSoftDeleted,
      ),
      async (c) => {
        const { userId } = c.req.valid("param");
        const { mode, reason, notify } = c.req.valid("json");
        const caller = controlPlaneCaller(c);
        const call = lifecycleCall(c, wiring, caller, userId, reason);
        const action = mode === "hard" ? AuthAuditActions.adminUserHardDeleted : AuthAuditActions.adminUserSoftDeleted;

        // Every call is audited: the transition audits a deletion it writes, this records the refusals and the
        // call that found the account already deleted.
        const result = await auditedLifecycleCall(
          c.var.emit,
          { action, ...call.audit },
          () =>
            deleteUser(call.deps, {
              userId,
              actor: call.actor,
              reason,
              mode,
              ...(notify === undefined ? {} : { notify }),
            }),
          (outcome) => outcome.outcome === "unchanged",
        );

        const sessionsRevoked = await endSessions(c, wiring, caller, userId, "deleted");
        // A hard deletion starts its purge here. A soft one waits for the daily pass — unless its window has
        // already closed, in which case it is due now and is started like a hard one.
        const disposition = mode === "hard" ? "due" : scheduledOrDue(result);
        const purge =
          disposition === "due"
            ? await startPurge(c, result, userId, mode === "hard" ? notify : undefined)
            : disposition;
        return c.json(deletionView(userId, mode, result, purge, sessionsRevoked) satisfies AdminUserDeleteResponse);
      },
    );

    app.post(
      `${base}/admin/users/:userId/restore`,
      describeRoute({
        summary:
          "Restore one deleted user inside the purge window, with a reason. They sign in again; no session is restored.",
        verification: "control-plane",
        scopes: [AUTH_USERS_DELETE_SCOPE],
        responses: { 200: AdminUserRestoreResponse },
      }),
      requireControlPlane(AUTH_USERS_DELETE_SCOPE),
      validate("param", UserIdParam),
      lifecycleBody(RestoreUserBody, AuthAuditActions.adminUserRestored),
      async (c) => {
        const { userId } = c.req.valid("param");
        const { reason } = c.req.valid("json");
        const caller = controlPlaneCaller(c);
        const call = lifecycleCall(c, wiring, caller, userId, reason);

        // After the purge there is no account, and the transition's 404 says the data is gone. A window that has
        // closed is a conflict naming when. Both are refusals, and both are on the trail.
        const result = await auditedLifecycleCall(
          c.var.emit,
          { action: AuthAuditActions.adminUserRestored, ...call.audit },
          () => restoreUser(call.deps, { userId, actor: call.actor, reason }),
          (outcome) => !outcome.changed,
        );

        return c.json(restorationView(userId, result) satisfies AdminUserRestoreResponse);
      },
    );

    app.get(
      `${base}/admin/users/:userId/export`,
      describeRoute({
        summary: "Export everything the kit holds about one user, from every composed capability, as one document.",
        description:
          "The answer to an access request. One entry per composed capability that declares a purge contribution, in the order the purge erases them. Audited as a disclosure, with the reason.",
        verification: "control-plane",
        scopes: [AUTH_USERS_EXPORT_SCOPE],
        responses: { 200: AdminUserExportResponse },
      }),
      requireControlPlane(AUTH_USERS_EXPORT_SCOPE),
      validate("param", UserIdParam),
      validate("query", ExportUserQuery),
      async (c) => {
        const { userId } = c.req.valid("param");
        const { reason } = c.req.valid("query");
        const caller = controlPlaneCaller(c);
        const call = lifecycleCall(c, wiring, caller, userId, reason);
        const exportedAt = new Date();

        // The account first, so an unknown or purged one is a 404 — the purged one saying its data is gone —
        // and never a document of empty parts. Then every composed capability's part, each guarded on its own.
        const entries = await auditedLifecycleCall(
          c.var.emit,
          { action: AuthAuditActions.adminUserExported, ...call.audit },
          async () => {
            await requirePresent(db(c, wiring), userId);
            return purgeExports(wiring.purgeSteps ?? [], {
              subject: { type: "user", id: userId },
              env: c.env as Record<string, unknown>,
            });
          },
          () => false,
        );

        // A disclosure, recorded with who asked, why, and which parts answered — never with any of the data.
        await emitControlPlaneAction(c.var.emit, {
          action: AuthAuditActions.adminUserExported,
          subject: caller.subject,
          connectionId: caller.connectionId,
          resourceType: "user",
          resourceId: userId,
          ...context(c),
          metadata: {
            reason,
            disclosure: true,
            capabilities: entries.map((entry) => `${entry.capability}:${entry.state}`),
          },
        });

        return c.json(exportView(userId, exportedAt, entries) satisfies AdminUserExportResponse);
      },
    );
  };
}

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { zValidator } from "@hono/zod-validator";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { UnauthorizedError } from "@pithy-sh/core/src/error/pithyError";
import { requireSameOrigin } from "@pithy-sh/core/src/http/sameOrigin";
import { validationHook } from "@pithy-sh/core/src/http/validation";
import { TURNSTILE_LOGIN_ACTION } from "@pithy-sh/turnstile/src/config/config";
import { turnstile } from "@pithy-sh/turnstile/src/http/middleware";
import type { Context, Hono } from "hono";
import { correlation, emitDenied, emitDeviceRevoked, emitTokenRefresh, emitTokenReuseDetected } from "../audit/emit";
import type { AuthWiring } from "../capability";
import { authDatabase } from "../data/tables";
import { deleteDevice, deviceSessionTokens, listDevices } from "../device/registry";
import {
  consumeSession,
  findConsumedToken,
  pruneConsumedTokens,
  recordConsumedToken,
  revokeFamily,
} from "../token/rotation";
import { registerAuthAdminRoutes } from "./adminRoutes";
import { apiErrorToPithy } from "./errors";
import { requireAuth } from "./middleware";
import { getAuthInstance, resolveDb } from "./resolve";
import { RevokeDeviceBody } from "./schemas";

type Ctx = Context<PithyHonoEnv>;

function db(c: Ctx, wiring: AuthWiring) {
  return authDatabase(resolveDb(c.env, wiring.config.database));
}

/**
 * Register the auth routes onto the backend's Hono app.
 *
 * Order matters: turnstile gates the human-initiated send routes (only when composed), Pithy's own
 * routes are registered before the catch-all so they win, and Better Auth owns everything else under
 * `basePath`. A handler that returns a Response ends the chain, so the specific routes never fall
 * through to the catch-all. (The tier-1 edge rate limiter is contributed as capability *middleware*, so
 * it runs before session resolution — see `capability.ts`.)
 *
 * What each Pithy-owned route accepts, declared on its route line (schemas in `./schemas`):
 *
 * | Route                      | Verification    | Input                       |
 * | -------------------------- | --------------- | --------------------------- |
 * | `POST /token/rotate`       | bearer/session  | none — the credential only  |
 * | `GET  /devices`            | bearer/session  | none                        |
 * | `POST /devices/revoke`     | bearer/session  | json `RevokeDeviceBody`     |
 * | `*    /admin/*`            | control-plane   | see `./adminRoutes`         |
 *
 * The catch-all takes NO validator, deliberately: `handleBetterAuth` hands Better Auth `c.req.raw`,
 * and reading the body first would consume the stream. Better Auth validates its own endpoints and
 * answers its own refusals; what it rejects reaches a caller in its shape, not ours.
 *
 * **The admin routes must be registered before the catch-all, and it is not a style preference.**
 * `handleBetterAuth` returns a Response, which ends the chain — so a route registered after
 * `app.all(`${base}/*`)` is mounted, is visible in `app.routes`, and never runs. A management call to
 * `/auth/admin/users` would instead reach Better Auth, which knows no such endpoint, and the failure
 * would look like a 404 from the wrong layer. `routeContract.test.ts` proves the ordering with a real
 * request rather than by inspecting the route table, because the route table cannot see this.
 */
export function createAuthRoutes(wiring: AuthWiring): (app: Hono<PithyHonoEnv>) => void {
  return (app) => {
    const base = wiring.config.basePath;
    // The CSRF origin guard for our own mutating routes (Better Auth guards its own endpoints). The
    // same gate an adopter's routes wear: this capability publishes it bound to the origins it
    // resolved, and reads it back here rather than binding a second copy of the same decision.
    const csrf = requireSameOrigin();

    // Auto-gate the magic-link and OTP send routes with the humanity check, when turnstile is composed.
    // The action is `@pithy-sh/turnstile`'s constant, never a literal: the widget is solved for the same
    // string through the client projection, and a second copy of it could only be caught in production —
    // where the two disagreeing refuses every sign-in. #377, and `TURNSTILE_LOGIN_ACTION`'s docblock.
    if (wiring.turnstile) {
      const guard = turnstile({ mode: wiring.turnstile.mode, action: TURNSTILE_LOGIN_ACTION });
      app.use(`${base}/sign-in/magic-link`, guard);
      app.use(`${base}/email-otp/send-verification-otp`, guard);
    }

    // Rotate the refresh credential: mint a new session, revoke the presented one, return a fresh JWT.
    app.post(`${base}/token/rotate`, csrf, (c) => rotateToken(c, wiring));
    // Device management (bearer/session gated; the revoke is CSRF-guarded as a mutating route).
    app.get(`${base}/devices`, requireAuth(), (c) => listMyDevices(c, wiring));
    app.post(`${base}/devices/revoke`, requireAuth(), csrf, zValidator("json", RevokeDeviceBody, validationHook), (c) =>
      revokeMyDevice(c, wiring, c.req.valid("json")),
    );

    // The control-plane management surface. Registered here, before the catch-all below, or it is dead.
    registerAuthAdminRoutes(wiring)(app);

    // Better Auth owns the rest (sign-in, verify, callback, sign-out, /token, /jwks, revoke-sessions…).
    app.all(`${base}/*`, (c) => handleBetterAuth(c, wiring));
  };
}

/** The statuses that mean somebody was turned away, rather than that something is broken. */
const DENIED_STATUSES = new Set([400, 401, 403]);

/**
 * Whether a refused request on this path was an attempt to authenticate.
 *
 * **The audit action is `auth/signin`, so the path has to earn it.** `emitDenied` records
 * `auth/signin outcome=denied actorType=anonymous`, which is the row a brute-force alert counts — and
 * the catch-all under `basePath` carries far more than sign-in. Recording every 4xx there would write
 * a *failed sign-in* for a logged-out tab polling `/update-user` with a stale cookie, and would let an
 * unauthenticated loop against `/list-sessions` bury real credential-stuffing under noise wearing the
 * same anonymous shape.
 *
 * So: the routes where presenting something and being refused *is* the failed attempt — starting a
 * sign-in, completing one at an OAuth callback, and asking for the credential that starts one.
 */
function isSignInAttempt(path: string): boolean {
  return (
    path.includes("/sign-in/") ||
    path.includes("/callback/") ||
    path.includes("/magic-link/") ||
    path.includes("/email-otp/")
  );
}

/**
 * Record a Better Auth refusal on the audit trail.
 *
 * **Read off the Response, because a refusal never arrives as a throw.** `onAPIError: { throw: true }`
 * reads as though an endpoint's `APIError` reaches this module, and it does not: better-auth's
 * `onError` re-raises it (`better-auth/dist/api/index.mjs:193`) directly into better-call's own catch
 * (`better-call@1.4.0`, `dist/router.mjs:83-89`), which renders an `APIError` as a Response and returns
 * it. The throw is swallowed one frame later by the library that asked for it.
 *
 * So the `emitDenied` call this replaces — gated on catching an `APIError` — had never run once. No
 * failed one-time code, no bad magic link, no refused OAuth callback has ever reached
 * `pithy_audit_events`, which is the largest class of security event this capability has (#449).
 *
 * **The body is cloned, never consumed.** The Response is handed back to the caller untouched: Better
 * Auth's own flat shape is a contract adopters read through `createAuthClient`, and the browser client
 * reads it too, so nothing here rewrites it.
 */
async function auditRefusal(c: Ctx, response: Response): Promise<void> {
  if (!DENIED_STATUSES.has(response.status)) return;
  if (!isSignInAttempt(new URL(c.req.raw.url).pathname)) return;

  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    // A body that will not parse still refused somebody, but names no reason worth a row.
    return;
  }
  const code = (body as { code?: unknown } | null)?.code;

  // Record only the Better-Auth error *code* (e.g. INVALID_OTP) — never the message, which can
  // carry the submitted email or other request context (no PII in the audit trail).
  await emitDenied(c.var.emit, {
    ...correlation(c.req.raw.headers),
    detail: typeof code === "string" ? code : undefined,
  });
}

/**
 * Delegate to Better Auth's fetch handler, and record what it refused.
 *
 * **The answer is returned exactly as Better Auth wrote it.** Re-homing its flat `{ message, code }`
 * into the kit envelope was tried and taken back out: `packages/auth/README.md` documents
 * `createAuthClient` from `better-auth/client` as a first-class client surface (#271), and
 * `@better-fetch/fetch` builds its error as `{ ...parsedBody, status }` — so rewriting the body would
 * make `error.code` `undefined` for every adopter on the documented path. The wire is Better Auth's
 * contract. `readFailure` in `../client/api` learns to read it instead (#449).
 *
 * The `catch` covers what better-call genuinely hands on: a non-`APIError` throw from an endpoint
 * (`router.mjs:88`), and a throw from a plugin's `onRequest` hook, which runs outside the router's own
 * try. A failure building the instance does **not** come this way — `getAuthInstance` is called before
 * it, and what that throws is already a `PithyError` for `pithyErrorHandler` to render.
 */
async function handleBetterAuth(c: Ctx, wiring: AuthWiring): Promise<Response> {
  const instance = await getAuthInstance(c, wiring);
  let response: Response;
  try {
    response = await instance.handler(c.req.raw);
  } catch (error) {
    throw apiErrorToPithy(error);
  }
  await auditRefusal(c, response);
  return response;
}

/** The raw bearer token presented on the Authorization header, or undefined when none/malformed. */
function bearerToken(headers: Headers): string | undefined {
  const match = headers.get("authorization")?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

/**
 * Grace window after a token is consumed during which a replay is treated as a benign concurrent or
 * retried rotation — denied, but WITHOUT revoking the family — rather than compromise. It absorbs a
 * client that fires or retries the same rotation twice (a network race) so a legitimate double-submit
 * never signs the user out everywhere. A replay past the window is a genuine reuse and revokes.
 */
const ROTATION_REUSE_GRACE_MS = 30_000;

/**
 * Rotate the refresh credential. Validates the presented session, mints a fresh one (preserving the
 * device binding and refresh-token family), atomically revokes the old one, and returns a new access
 * token + refresh token. This is the "refresh credential rotates on use" primitive Better Auth does not
 * provide natively.
 *
 * Two hardenings over a naive rotate (#59):
 *  - **Reuse detection.** A presented token that no longer resolves to a live session but was previously
 *    consumed is a replayed refresh token — the compromise signal for rotated refresh tokens
 *    (RFC 6819 §5.2.2.3). The whole family is revoked and the attempt denied. (Covers the bearer refresh
 *    flow — the mobile refresh credential; a cookie session presented after rotation already fails closed.)
 *  - **Race safety.** The old session is consumed by a conditional delete that exactly one concurrent
 *    rotation wins; the loser rolls back its freshly-minted successor. One presented token, one successor.
 */
async function rotateToken(c: Ctx, wiring: AuthWiring): Promise<Response> {
  const instance = await getAuthInstance(c, wiring);
  const headers = c.req.raw.headers;
  const database = db(c, wiring);
  const ctx = await instance.$context;
  const current = await instance.api.getSession({ headers });

  if (!current) {
    // The presented token resolves to no live session. If it was consumed by an earlier rotation, it is
    // a replay: compromise past the grace window (revoke the family), or a benign concurrent/retried
    // rotation within it (deny only). Otherwise the token is simply invalid or expired.
    const presented = bearerToken(headers);
    const consumed = presented ? await findConsumedToken(database, presented) : null;
    if (consumed) {
      if (Date.now() - consumed.rotatedAt.getTime() >= ROTATION_REUSE_GRACE_MS) {
        await revokeFamily(database, consumed.familyId, (token) => ctx.internalAdapter.deleteSession(token));
        await emitTokenReuseDetected(c.var.emit, {
          userId: consumed.userId,
          familyId: consumed.familyId,
          ...correlation(headers),
        });
        throw new UnauthorizedError({
          message: "This credential has been revoked.",
          action: "Sign in again to obtain a new session.",
        });
      }
      // Within the grace window: a superseded token from a race/retry. Deny, but leave the family — the
      // successor the winning rotation issued must keep working.
      throw new UnauthorizedError({
        message: "Authentication required.",
        action: "Retry with your current session or bearer token.",
      });
    }
    throw new UnauthorizedError({
      message: "Authentication required.",
      action: "Present a valid session or bearer token to rotate.",
    });
  }

  const ip = headers.get("cf-connecting-ip") ?? undefined;
  const userAgent = headers.get("user-agent") ?? undefined;
  const session = current.session as { token: string; deviceId?: string | null; familyId?: string | null };
  const deviceId = session.deviceId ?? undefined;
  // Carry the family forward across the rotation; a session that never had one starts a family now.
  const familyId = session.familyId ?? crypto.randomUUID();

  // Mint the successor session and its access token BEFORE consuming the old one, so a transient signing
  // failure leaves the presented refresh token still valid (the successor simply expires unused) rather
  // than stranding the caller with no working credential.
  const next = await ctx.internalAdapter.createSession(current.user.id, undefined, {
    ipAddress: ip,
    userAgent,
    familyId,
    ...(deviceId ? { deviceId } : {}),
  });
  const access = await instance.api.getToken({ headers: new Headers({ authorization: `Bearer ${next.token}` }) });

  // Atomically consume the presented session. Of N concurrent rotations, exactly one wins the delete;
  // the losers roll back the successor they minted, so one presented token never yields two successors.
  const consumed = await consumeSession(database, session.token);
  if (!consumed.won) {
    await ctx.internalAdapter.deleteSession(next.token);
    throw new UnauthorizedError({
      message: "Authentication required.",
      action: "Retry with your current session or bearer token.",
    });
  }

  // Record the consumed token so a later replay is caught as reuse (the family is already carried forward).
  await recordConsumedToken(database, {
    token: session.token,
    familyId,
    userId: current.user.id,
    rotatedAt: new Date(),
  });
  await emitTokenRefresh(c.var.emit, { userId: current.user.id, sessionId: next.id, ip, userAgent });

  // Bound the ledger: a token consumed longer ago than a full session lifetime can no longer match any
  // live session. Best-effort — a cleanup failure must never fail the rotation it rode in on.
  try {
    await pruneConsumedTokens(database, new Date(Date.now() - wiring.config.sessionExpiresIn * 1000));
  } catch {
    // Retention pruning is non-critical maintenance.
  }

  return c.json({ accessToken: access.token, refreshToken: next.token, expiresAt: next.expiresAt });
}

/** List the authenticated user's registered devices. */
async function listMyDevices(c: Ctx, wiring: AuthWiring): Promise<Response> {
  const userId = c.var.auth?.userId;
  if (!userId) throw new UnauthorizedError({ message: "Authentication required." });
  return c.json({ devices: await listDevices(db(c, wiring), userId) });
}

/** Revoke one of the authenticated user's devices: sign out its sessions, then drop the device row. */
async function revokeMyDevice(c: Ctx, wiring: AuthWiring, body: RevokeDeviceBody): Promise<Response> {
  const userId = c.var.auth?.userId;
  if (!userId) throw new UnauthorizedError({ message: "Authentication required." });
  const deviceId = body.deviceId;
  const database = db(c, wiring);
  const tokens = await deviceSessionTokens(database, userId, deviceId);
  const ctx = await (await getAuthInstance(c, wiring)).$context;
  for (const token of tokens) {
    await ctx.internalAdapter.deleteSession(token);
  }
  await deleteDevice(database, userId, deviceId);
  await emitDeviceRevoked(c.var.emit, { userId, ...correlation(c.req.raw.headers) });
  return c.json({ revoked: tokens.length });
}

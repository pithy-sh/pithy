import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { UnauthorizedError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { turnstile } from "@pithy-sh/turnstile/src/http/middleware";
import { isAPIError } from "better-auth/api";
import type { Context, Hono } from "hono";
import { correlation, emitDenied, emitDeviceRevoked, emitTokenRefresh } from "../audit/emit";
import type { AuthWiring } from "../capability";
import { authDatabase } from "../data/tables";
import { deleteDevice, deviceSessionTokens, listDevices } from "../device/registry";
import { allowedOrigins, requireSameOrigin } from "./csrf";
import { apiErrorToPithy } from "./errors";
import { requireAuth } from "./middleware";
import { getAuthInstance, resolveDb } from "./resolve";

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
 */
export function createAuthRoutes(wiring: AuthWiring): (app: Hono<PithyHonoEnv>) => void {
  return (app) => {
    const base = wiring.config.basePath;
    // The CSRF origin guard for our own mutating routes (Better Auth guards its own endpoints).
    const csrf = requireSameOrigin(allowedOrigins(wiring.config.baseURL, wiring.config.trustedOrigins));

    // Auto-gate the magic-link and OTP send routes with the humanity check, when turnstile is composed.
    if (wiring.turnstile) {
      const guard = turnstile({ mode: wiring.turnstile.mode, action: "login" });
      app.use(`${base}/sign-in/magic-link`, guard);
      app.use(`${base}/email-otp/send-verification-otp`, guard);
    }

    // Rotate the refresh credential: mint a new session, revoke the presented one, return a fresh JWT.
    app.post(`${base}/token/rotate`, csrf, (c) => rotateToken(c, wiring));
    // Device management (bearer/session gated; the revoke is CSRF-guarded as a mutating route).
    app.get(`${base}/devices`, requireAuth(), (c) => listMyDevices(c, wiring));
    app.post(`${base}/devices/revoke`, requireAuth(), csrf, (c) => revokeMyDevice(c, wiring));

    // Better Auth owns the rest (sign-in, verify, callback, sign-out, /token, /jwks, revoke-sessions…).
    app.all(`${base}/*`, (c) => handleBetterAuth(c, wiring));
  };
}

/** Delegate to Better Auth's fetch handler; record denied attempts and re-home errors as PithyError. */
async function handleBetterAuth(c: Ctx, wiring: AuthWiring): Promise<Response> {
  const instance = await getAuthInstance(c, wiring);
  try {
    return await instance.handler(c.req.raw);
  } catch (error) {
    if (isAPIError(error)) {
      const status = (error as { statusCode?: number }).statusCode ?? 500;
      if (status === 400 || status === 401 || status === 403) {
        // Record only the Better-Auth error *code* (e.g. INVALID_OTP) — never the message, which can
        // carry the submitted email or other request context (no PII in the audit trail).
        await emitDenied(c.var.emit, {
          ...correlation(c.req.raw.headers),
          detail: (error as { body?: { code?: string } }).body?.code,
        });
      }
    }
    throw apiErrorToPithy(error);
  }
}

/**
 * Rotate the refresh credential. Validates the presented session, mints a fresh one (preserving the
 * device binding), revokes the old one, and returns a new access token + refresh token. This is the
 * "refresh credential rotates on use" primitive Better Auth does not provide natively.
 */
async function rotateToken(c: Ctx, wiring: AuthWiring): Promise<Response> {
  const instance = await getAuthInstance(c, wiring);
  const headers = c.req.raw.headers;
  const current = await instance.api.getSession({ headers });
  if (!current) {
    throw new UnauthorizedError({
      message: "Authentication required.",
      action: "Present a valid session or bearer token to rotate.",
    });
  }
  const ctx = await instance.$context;
  const ip = headers.get("cf-connecting-ip") ?? undefined;
  const userAgent = headers.get("user-agent") ?? undefined;
  const deviceId = (current.session as { deviceId?: string | null }).deviceId ?? undefined;

  const next = await ctx.internalAdapter.createSession(current.user.id, undefined, {
    ipAddress: ip,
    userAgent,
    ...(deviceId ? { deviceId } : {}),
  });
  // Mint the access token for the new session BEFORE revoking the old one, so a transient signing
  // failure leaves the presented refresh token still valid (the new session simply expires unused)
  // rather than stranding the caller with no working credential.
  const access = await instance.api.getToken({ headers: new Headers({ authorization: `Bearer ${next.token}` }) });
  await ctx.internalAdapter.deleteSession(current.session.token);
  await emitTokenRefresh(c.var.emit, { userId: current.user.id, sessionId: next.id, ip, userAgent });

  return c.json({ accessToken: access.token, refreshToken: next.token, expiresAt: next.expiresAt });
}

/** List the authenticated user's registered devices. */
async function listMyDevices(c: Ctx, wiring: AuthWiring): Promise<Response> {
  const userId = c.var.auth?.userId;
  if (!userId) throw new UnauthorizedError({ message: "Authentication required." });
  return c.json({ devices: await listDevices(db(c, wiring), userId) });
}

/** Revoke one of the authenticated user's devices: sign out its sessions, then drop the device row. */
async function revokeMyDevice(c: Ctx, wiring: AuthWiring): Promise<Response> {
  const userId = c.var.auth?.userId;
  if (!userId) throw new UnauthorizedError({ message: "Authentication required." });
  const body = (await c.req.json().catch(() => ({}))) as { deviceId?: unknown };
  if (typeof body.deviceId !== "string" || body.deviceId.length === 0) {
    throw new ValidationError({
      message: "A deviceId is required.",
      action: "Pass the device's id in the request body.",
    });
  }
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

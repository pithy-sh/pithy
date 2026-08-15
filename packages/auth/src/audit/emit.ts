// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import { AuthAuditActions } from "./actions";

/**
 * Audit emission helpers, kept out of the instance so the hook wiring stays legible. Every helper goes
 * through core's `emit` seam (a no-op when audit is absent) and swallows its own failure — an audit
 * write must never break the auth action it records.
 *
 * Sign-in is emitted from the endpoint `after` hook (where `newSession` is set), not the DB hook — so
 * the internal `createSession` a token rotation performs never looks like a fresh sign-in.
 */

/** Pull request correlation from hook headers (no PII beyond ip/user-agent). */
export function correlation(headers: Headers | undefined): { ip?: string; userAgent?: string } {
  return {
    ip: headers?.get("cf-connecting-ip") ?? undefined,
    userAgent: headers?.get("user-agent") ?? undefined,
  };
}

async function safeEmit(emit: AuditEmit, event: Parameters<AuditEmit>[0]): Promise<void> {
  try {
    await emit(event);
  } catch {
    // An audit write is non-fatal by contract.
  }
}

/** The session just created on a sign-in endpoint, plus the (already-authenticated) caller, if any. */
export interface AfterRequest {
  path: string;
  headers: Headers | undefined;
  newSession: { userId: string; sessionId: string; deviceId: string | null } | null;
  currentUserId: string | null;
}

function pathAction(path: string): string | undefined {
  if (path === "/sign-in/magic-link") return AuthAuditActions.magicLinkSent;
  if (path === "/email-otp/send-verification-otp") return AuthAuditActions.otpSent;
  if (path === "/sign-out") return AuthAuditActions.signout;
  if (path === "/token") return AuthAuditActions.tokenRefresh;
  // Only an explicit `/link-social` is a linking event. A `/callback/*` is an OAuth *sign-in* (already
  // recorded as `auth/signin` from the new session) — mapping it here would mislabel every first
  // sign-up as a link.
  if (path === "/link-social") return AuthAuditActions.oauthLinked;
  return undefined;
}

/** Emit the audit events for a completed auth request: sign-in (+device) from a new session, then any path event. */
export async function emitAfterRequest(emit: AuditEmit, req: AfterRequest): Promise<void> {
  const corr = correlation(req.headers);
  if (req.newSession) {
    await safeEmit(emit, {
      action: AuthAuditActions.signin,
      outcome: "success",
      actorType: "user",
      actorId: req.newSession.userId,
      sessionId: req.newSession.sessionId,
      ...corr,
    });
    if (req.newSession.deviceId) {
      await safeEmit(emit, {
        action: AuthAuditActions.deviceRegistered,
        outcome: "success",
        actorType: "user",
        actorId: req.newSession.userId,
        sessionId: req.newSession.sessionId,
        ...corr,
      });
    }
  }
  const action = pathAction(req.path);
  if (action) {
    const actorId = req.newSession?.userId ?? req.currentUserId ?? undefined;
    await safeEmit(emit, {
      action,
      outcome: "success",
      actorType: actorId ? "user" : "anonymous",
      actorId,
      ...corr,
    });
  }
}

/** Emit a `token_refresh` event for a session rotation (the custom rotate route). */
export async function emitTokenRefresh(
  emit: AuditEmit,
  context: { userId: string; sessionId: string; ip?: string; userAgent?: string },
): Promise<void> {
  await safeEmit(emit, {
    action: AuthAuditActions.tokenRefresh,
    outcome: "success",
    actorType: "user",
    actorId: context.userId,
    sessionId: context.sessionId,
    ip: context.ip,
    userAgent: context.userAgent,
  });
}

/**
 * Emit a `token_reuse_detected` event — a replayed refresh token was caught and its family revoked.
 * Recorded as `denied` and attributed to the compromised account (the family's owner), so the security
 * trail names whose family was revoked, not the anonymous replayer.
 */
export async function emitTokenReuseDetected(
  emit: AuditEmit,
  context: { userId: string; familyId: string; ip?: string; userAgent?: string },
): Promise<void> {
  await safeEmit(emit, {
    action: AuthAuditActions.tokenReuseDetected,
    outcome: "denied",
    severity: "critical",
    actorType: "user",
    actorId: context.userId,
    ip: context.ip,
    userAgent: context.userAgent,
    metadata: { familyId: context.familyId },
  });
}

/** Emit a `device_revoked` event. */
export async function emitDeviceRevoked(
  emit: AuditEmit,
  context: { userId: string; ip?: string; userAgent?: string },
): Promise<void> {
  await safeEmit(emit, {
    action: AuthAuditActions.deviceRevoked,
    outcome: "success",
    actorType: "user",
    actorId: context.userId,
    ip: context.ip,
    userAgent: context.userAgent,
  });
}

/**
 * Emit one control-plane admin action.
 *
 * `actorType` is `control-plane` and never `user`: the caller holds no session and owns no user row, so
 * recording it as a user would make "what did the management client do" unanswerable from the trail —
 * and would put a dashboard operator's id in the same column as the adopter's own customers.
 *
 * `actorId` is the token's verified `sub` — *which person at the dashboard*, not merely which
 * dashboard. `resourceId` is the user or session acted on, so the trail reads from both ends: every
 * action one operator took, and everything ever done to one customer.
 *
 * No email address, no session token, no device push token reaches `metadata`. The trail is queryable
 * and long-lived, and a management client that already saw the address does not need it copied into a
 * second store with a different retention policy.
 */
export async function emitControlPlaneAction(
  emit: AuditEmit,
  event: {
    action: string;
    subject: string;
    connectionId: string;
    resourceType: string;
    resourceId?: string | null;
    ip?: string;
    userAgent?: string;
    requestId?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await safeEmit(emit, {
    action: event.action,
    outcome: "success",
    actorType: "control-plane",
    actorId: event.subject,
    resourceType: event.resourceType,
    resourceId: event.resourceId ?? null,
    ip: event.ip,
    userAgent: event.userAgent,
    requestId: event.requestId,
    metadata: { connectionId: event.connectionId, ...event.metadata },
  });
}

/**
 * Emit a `provider_unavailable` event — somebody asked for a sign-in method this deployment enables and
 * could not serve.
 *
 * `anonymous`, because the caller has no session yet by definition. `denied` rather than `failure`: the
 * request was refused deliberately by a rule this Worker holds, not lost to a fault. `warning` rather
 * than `critical` — the other sign-in methods are working, which is the entire point of #381, so this is
 * notable rather than alert-worthy.
 *
 * `metadata.provider` is the provider id and nothing else. The secret name is derivable from it and is
 * still not written: an audit row is long-lived and queryable, and naming a store entry in one is a map
 * for whoever reads the trail later.
 */
export async function emitProviderUnavailable(
  emit: AuditEmit,
  context: { provider: string; headers: Headers | undefined },
): Promise<void> {
  await safeEmit(emit, {
    action: AuthAuditActions.providerUnavailable,
    outcome: "denied",
    severity: "warning",
    actorType: "anonymous",
    metadata: { provider: context.provider },
    ...correlation(context.headers),
  });
}

/** A blocked/failed auth attempt — recorded as `denied` (first-class). */
export async function emitDenied(
  emit: AuditEmit,
  context: { ip?: string; userAgent?: string; detail?: string },
): Promise<void> {
  await safeEmit(emit, {
    action: AuthAuditActions.signin,
    outcome: "denied",
    actorType: "anonymous",
    ip: context.ip,
    userAgent: context.userAgent,
    metadata: context.detail ? { reason: context.detail } : undefined,
  });
}

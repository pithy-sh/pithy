// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import { z } from "zod";
import { type AuthAuditAction, AuthAuditActions } from "./actions";

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
  // **No path maps to `oauth_linked`, and that is the correction #627 made.** `/link-social` mints a
  // redirect, which is a request rather than an outcome; `/callback/:id` completes a sign-in *or* a
  // link and cannot be told apart by its path. The event that means "this provider can sign in as this
  // user" is the account row, so it is emitted from the row — see `emitProviderAccountChanged`.
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

/** Which direction the provider change went — the two read very differently in a trail. */
export type ProviderChange = "link" | "unlink";

/**
 * The account-row columns the provider-change events are built from, and **only** those.
 *
 * **A Zod object rather than a cast, for the strip rather than for the types.** The row Better Auth
 * hands a database hook carries `accessToken`, `refreshToken`, `idToken` and `scope` alongside these
 * three. Parsing it into a named shape means the emitter below is holding a value that never contained
 * a provider token, so no later edit spreading "the account" into `metadata` can leak one — the guard
 * is structural instead of a rule somebody has to remember. The provider-asserted email is not here
 * either, and is not stored on this row to begin with: #627 does not widen what is retained.
 */
export const ProviderAccount = z
  .object({
    id: z.string().describe("The account row's primary key — which link was made or broken."),
    userId: z.string().describe("The user this provider can, or could, sign in as."),
    providerId: z.string().describe("The provider slug (`google`, `apple`, `facebook`, `github`)."),
  })
  .describe("The account-row columns `auth/oauth_linked` and `auth/oauth_unlinked` are built from.");
export type ProviderAccount = z.output<typeof ProviderAccount>;

/**
 * Better Auth's provider id for a password row. Pithy is passwordless, so one should never exist here —
 * but `oauth_linked` claims *a provider can now sign this person in*, and a credential row is a
 * different claim. A plugin that created one must not show up in the trail as an OAuth link.
 */
const CREDENTIAL_PROVIDER_ID = "credential";

const PROVIDER_CHANGE_ACTIONS: Record<ProviderChange, AuthAuditAction> = {
  link: AuthAuditActions.oauthLinked,
  unlink: AuthAuditActions.oauthUnlinked,
};

/**
 * Emit `oauth_linked` / `oauth_unlinked` for an account row that was just created or just removed.
 *
 * **Called from the `account` database hooks, and the row is the point.** An operator's question is
 * "which providers can sign in as this account today, and when did that change"; the account table is
 * the answer to the first half, so the second half has to be recorded where that table changes. Wiring
 * this to an endpoint instead is what #627 was: `/link-social` recorded an intention as an outcome, and
 * `/unlink-account` recorded nothing. From the row, an abandoned consent screen emits nothing because
 * nothing happened, and every path that ends a link — the unlink endpoint, and the cascade when a user
 * is deleted — is covered without naming any of them.
 *
 * One emitter for both directions so the two rows are structurally identical: a timeline that alternates
 * between them is read by diffing, and a field one carries and the other does not is a field nobody can
 * filter on.
 *
 * Unparseable input is dropped rather than thrown. The write it describes has already happened, and an
 * audit failure must never break the action it records — the same contract `safeEmit` holds.
 */
export async function emitProviderAccountChanged(
  emit: AuditEmit,
  context: { change: ProviderChange; account: unknown; headers: Headers | undefined },
): Promise<void> {
  const parsed = ProviderAccount.safeParse(context.account);
  if (!parsed.success) return;
  const account = parsed.data;
  if (account.providerId === CREDENTIAL_PROVIDER_ID) return;
  await safeEmit(emit, {
    action: PROVIDER_CHANGE_ACTIONS[context.change],
    outcome: "success",
    actorType: "user",
    actorId: account.userId,
    // First-class columns, so "everything ever done to this link" is a query rather than a JSON scan.
    resourceType: "account",
    resourceId: account.id,
    metadata: { provider: account.providerId },
    ...correlation(context.headers),
  });
}

/**
 * Emit a `session_not_fresh` event — an attempt to change connected accounts on an authentic but stale
 * credential.
 *
 * `actorType: "user"` rather than `anonymous`, unlike `emitProviderUnavailable`: this caller is
 * authenticated, and the user id is the whole value of the row. Counting these per user is how a stolen
 * credential being walked toward an account change becomes visible.
 */
export async function emitProviderChangeNotFresh(
  emit: AuditEmit,
  context: { change: ProviderChange; userId: string; sessionId: string; headers: Headers | undefined },
): Promise<void> {
  await safeEmit(emit, {
    action: AuthAuditActions.sessionNotFresh,
    outcome: "denied",
    severity: "warning",
    actorType: "user",
    actorId: context.userId,
    // The first-class column, not `metadata`. Counting these per user is the whole value of the row, and
    // an id buried in a JSON blob is one this action alone cannot be correlated by.
    sessionId: context.sessionId,
    // Attaching an identity and stripping one are the same refusal and very different intentions.
    metadata: { change: context.change },
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

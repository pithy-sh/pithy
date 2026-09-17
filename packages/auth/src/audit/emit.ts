// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import { APIError } from "better-auth/api";
import { z } from "zod";
import { type AuthAuditAction, AuthAuditActions } from "./actions";
import type { EndedSession } from "./evidence";

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

/**
 * What an endpoint must have *done* for its path event to be a success, beyond answering without an
 * error. `null` means the response is its own evidence: a magic link either went to the queue or the
 * endpoint refused, and there is no third state.
 *
 * **`"session-ended"` exists because `/sign-out` has one.** It answers `200 {"success":true}` whether or
 * not it found a session to delete, so a caller with no session — an expired cookie, a bearer token
 * (which `/sign-out` does not read), a bare `curl` — got a success response and a success row for a
 * sign-out that signed nobody out. The endpoint is not lying; `auth/signout` was. The evidence is the
 * session row disappearing, which `session.delete.after` observes.
 */
export type PathEvidence = "session-ended" | null;

/** One audited endpoint: the action its path means, and what must have happened for that to be true. */
export interface PathEvent {
  /** The action code this path writes. */
  action: AuthAuditAction;
  /** What must be observably true for the action to have happened; `null` when a completed response says it. */
  evidence: PathEvidence;
}

/**
 * The endpoints whose *path* names an audit action, and what "success" means for each.
 *
 * **A table rather than a chain of `if`s so the rule can be asserted over all of it.** #627's second
 * half was that every entry here wrote `outcome: "success"` for a request the endpoint had refused:
 * Better Auth catches an endpoint's `APIError` into a result and runs the `after` hooks over it anyway
 * (`better-auth/dist/api/dispatch.mjs`), so a 401 `/token` and a 400 `/email-otp/send-verification-otp`
 * both looked, from here, exactly like a request that worked. Naming the two paths somebody happened to
 * probe would have fixed those two; the exposure was every entry, including ones added later. So the
 * rule is `emitAfterRequest` reading the outcome, and the gate walks this table.
 *
 * **No path maps to `oauth_linked`, and that is the correction #627 made first.** `/link-social` mints
 * a redirect, which is a request rather than an outcome; `/callback/:id` completes a sign-in *or* a link
 * and cannot be told apart by its path. The event that means "this provider can sign in as this user" is
 * the account row, so it is emitted from the row — see `emitProviderAccountChanged`.
 */
export const PATH_EVENTS: Readonly<Record<string, PathEvent>> = {
  "/sign-in/magic-link": { action: AuthAuditActions.magicLinkSent, evidence: null },
  "/email-otp/send-verification-otp": { action: AuthAuditActions.otpSent, evidence: null },
  "/sign-out": { action: AuthAuditActions.signout, evidence: "session-ended" },
  "/token": { action: AuthAuditActions.tokenRefresh, evidence: null },
};

/** The session just created on a sign-in endpoint, plus the (already-authenticated) caller, if any. */
export interface AfterRequest {
  path: string;
  headers: Headers | undefined;
  newSession: { userId: string; sessionId: string; deviceId: string | null } | null;
  currentUserId: string | null;
  /**
   * What the endpoint handed back — `ctx.context.returned`. An `APIError` here means the request was
   * refused; the `after` hook runs over it regardless, so this is the only thing that tells the two
   * apart. Passed raw rather than pre-judged so the judgment is `wasRefused`'s, where it is asserted.
   */
  returned: unknown;
  /**
   * The session row that actually disappeared during this request — the evidence `/sign-out` needs, and
   * the only actor it can name, since it declares no session middleware and reads the cookie itself.
   */
  endedSession: EndedSession | null;
}

/**
 * Whether the endpoint refused this request.
 *
 * `instanceof` first, then the shape. Better Auth is a single instance in this bundle so the class
 * identity holds today, but an audit rule that silently degrades to "everything succeeded" when a
 * duplicated module breaks `instanceof` is the defect this function exists to end — so a numeric
 * `statusCode` at or above 400 is refusal too, whoever constructed it.
 */
export function wasRefused(returned: unknown): boolean {
  if (returned instanceof APIError) return true;
  if (typeof returned !== "object" || returned === null) return false;
  const status = (returned as { statusCode?: unknown }).statusCode;
  return typeof status === "number" && status >= 400;
}

/**
 * Emit the audit events for an auth request: sign-in (+device) from a new session, then the path event.
 *
 * **Outcome first, because the hook runs either way.** A refused request writes its path event as
 * `denied` rather than `success` — the attempt is still worth a row (counting refused OTP sends per IP
 * is how abuse becomes visible), and `denied` is first-class in core's schema for exactly this. It never
 * writes the sign-in pair: a refusal created no session, and `newSession` being set at all would be a
 * contradiction rather than something to record.
 */
export async function emitAfterRequest(emit: AuditEmit, req: AfterRequest): Promise<void> {
  const corr = correlation(req.headers);
  const refused = wasRefused(req.returned);
  if (req.newSession && !refused) {
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
  const event = PATH_EVENTS[req.path];
  if (!event) return;
  // Nothing happened and nothing was refused: no row, because there is no event to record.
  if (!refused && event.evidence === "session-ended" && !req.endedSession) return;
  const actorId = req.newSession?.userId ?? req.currentUserId ?? req.endedSession?.userId ?? undefined;
  await safeEmit(emit, {
    action: event.action,
    outcome: refused ? "denied" : "success",
    actorType: actorId ? "user" : "anonymous",
    actorId,
    ...corr,
  });
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
 * **The actor is whoever caused the change, never the account it concerns.** The row's `userId` says
 * *whose* link it was, which is not the same question and is carried in `metadata.userId` instead. The
 * first cut of #627 conflated them: `delete.after` fires on every removal, the user-deletion cascade
 * included, so an operator deleting somebody's account wrote rows saying that person had detached their
 * own providers — from the operator's IP. A trail that misattributes an actor is worse than one that is
 * silent, because it reads as evidence. Three cases, and only three:
 *
 * - An authenticated caller — `/unlink-account`, a link from a signed-in session — is `user`, named.
 * - A request with no session (a first social sign-up completing at `/callback/:id`) is `anonymous`.
 * - No request at all (the user-deletion cascade, an admin path calling `internalAdapter` directly) is
 *   `system`, with no actor id and no ip: there is no caller to name and nothing to borrow one from.
 *
 * Unparseable input is dropped rather than thrown. The write it describes has already happened, and an
 * audit failure must never break the action it records — the same contract `safeEmit` holds.
 */
export async function emitProviderAccountChanged(
  emit: AuditEmit,
  context: {
    change: ProviderChange;
    account: unknown;
    /** The authenticated caller's user id, when the change came from a request holding a session. */
    callerId: string | null;
    /** Whether a request drove this change at all; false for the cascade and other internal callers. */
    fromRequest: boolean;
    headers: Headers | undefined;
  },
): Promise<void> {
  const parsed = ProviderAccount.safeParse(context.account);
  if (!parsed.success) return;
  const account = parsed.data;
  if (account.providerId === CREDENTIAL_PROVIDER_ID) return;
  const actor = context.callerId
    ? { actorType: "user" as const, actorId: context.callerId }
    : context.fromRequest
      ? { actorType: "anonymous" as const, actorId: undefined }
      : { actorType: "system" as const, actorId: undefined };
  await safeEmit(emit, {
    action: PROVIDER_CHANGE_ACTIONS[context.change],
    outcome: "success",
    ...actor,
    // First-class columns, so "everything ever done to this link" is a query rather than a JSON scan.
    resourceType: "account",
    resourceId: account.id,
    // `userId` is whose link changed. It stays out of `actorId` precisely so the two can disagree.
    metadata: { provider: account.providerId, userId: account.userId },
    // Only when a request drove it. A cascade has no client, and stamping the deleting operator's
    // address onto a row about somebody else's account is the misattribution in its second form.
    ...(context.fromRequest ? correlation(context.headers) : {}),
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

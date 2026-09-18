// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import { APIError } from "better-auth/api";
import { z } from "zod";
import { type AuthAuditAction, AuthAuditActions } from "./actions";
import type { AuthEmailDelivery, EndedSession } from "./evidence";

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
 * What an endpoint must have *done* for its path event to be a success.
 *
 * **There is no "the response is its own evidence" member, and its removal is #627's last half.** A
 * non-2xx is sufficient evidence of a refusal and is nowhere near necessary: `/sign-out` answers
 * `200 {"success":true}` having deleted nothing, and `/email-otp/send-verification-otp` answers
 * `200 {"success":true}` having declined to send — Better Auth drops the verification row and returns
 * success rather than confirm that an address is registered (`plugins/email-otp/routes.mjs`), and the
 * kit's own `sendVerificationOTP` returns without queuing for any `type` but `sign-in`. Both are
 * deliberate; neither is visible from the status or the body. So every entry names something that must
 * have *happened*, and `emitAfterRequest` writes `success` only when it did.
 *
 * Each member is observed by {@link EVIDENCE_OBSERVERS}, and a member added here does not compile until
 * that record names how to see it.
 *
 * - `"session-ended"` — a session row disappeared, which `session.delete.after` observes. `/sign-out`
 *   reads no session of its own, so this is also the only actor it can name.
 * - `"message-queued"` — the email seam answered that a message reached the queue, which the send callback
 *   in `../instance/plugins.ts` observes. Its *absence* is two different facts and the observer reports
 *   which: a message the capability withheld is a decline, a send that threw is a fault.
 * - `"token-minted"` — the response actually carries a token, which is readable from `returned` because
 *   an endpoint's own payload is what it claims to have made.
 */
export type PathEvidence = "session-ended" | "message-queued" | "token-minted";

/**
 * What a *completed* response with no evidence behind it means, and therefore what to record for it.
 *
 * `"denied"` where a rule this deployment holds declined to act — the enumeration guard, a send the kit
 * will not make. Those are the rows an abuse count is made of, and `denied` is core's word for "an
 * authorization gate blocked it".
 *
 * `"silent"` where nothing was attempted and nothing refused: `/sign-out` with no session confirms a
 * state that already held. There is no event, because nothing happened. (A *refused* request still
 * writes `denied` on every path, silent ones included — the attempt was made and turned away.)
 */
export type WithoutEvidence = "denied" | "silent";

/** One audited endpoint: the action its path means, and what must have happened for that to be true. */
export interface PathEvent {
  /** The action code this path writes. */
  action: AuthAuditAction;
  /** What must be observably true for the action to have happened. Required: there is no unevidenced claim. */
  evidence: PathEvidence;
  /** What a completed response with that evidence absent is, and therefore what is recorded for it. */
  withoutEvidence: WithoutEvidence;
}

/**
 * The endpoints whose *path* names an audit action, what "success" means for each, and what a completed
 * response without it means instead.
 *
 * **A table rather than a chain of `if`s so the rule can be asserted over all of it.** #627's second
 * half was that every entry here wrote `outcome: "success"` for a request the endpoint had refused:
 * Better Auth catches an endpoint's `APIError` into a result and runs the `after` hooks over it anyway
 * (`better-auth/dist/api/dispatch.mjs`), so a 401 `/token` and a 400 `/email-otp/send-verification-otp`
 * both looked, from here, exactly like a request that worked. Naming the two paths somebody happened to
 * probe would have fixed those two; the exposure was every entry, including ones added later. So the
 * rule is `emitAfterRequest` reading the outcome, and the gate walks this table.
 *
 * **Its third half was that a refusal can answer 200**, which the first fix could not see, and the
 * correction is the same shape: not a fifth branch for the endpoint somebody probed, but a column every
 * entry must fill. `evidence` has no "the response says so" member, so an entry that claims an outcome
 * it cannot evidence does not compile, and `emit.test.ts` walks the table asserting that an entry whose
 * evidence is absent never writes `success`.
 *
 * **No path maps to `oauth_linked`, and that is the correction #627 made first.** `/link-social` mints
 * a redirect, which is a request rather than an outcome; `/callback/:id` completes a sign-in *or* a link
 * and cannot be told apart by its path. The event that means "this provider can sign in as this user" is
 * the account row, so it is emitted from the row — see `emitProviderAccountChanged`.
 */
export const PATH_EVENTS: Readonly<Record<string, PathEvent>> = {
  "/sign-in/magic-link": {
    action: AuthAuditActions.magicLinkSent,
    evidence: "message-queued",
    withoutEvidence: "denied",
  },
  "/email-otp/send-verification-otp": {
    action: AuthAuditActions.otpSent,
    evidence: "message-queued",
    withoutEvidence: "denied",
  },
  "/sign-out": { action: AuthAuditActions.signout, evidence: "session-ended", withoutEvidence: "silent" },
  "/token": { action: AuthAuditActions.tokenRefresh, evidence: "token-minted", withoutEvidence: "denied" },
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
  /**
   * What the email seam did with this request's magic link or OTP, or null where it was never reached —
   * the evidence the two send paths need, since both answer `200 {"success":true}` whether or not a
   * message exists. The answer rather than the attempt: see `./evidence.ts`.
   */
  messageDelivery: AuthEmailDelivery | null;
}

/**
 * Whether the response actually carries a token. `/token`'s evidence, read from the endpoint's own
 * payload — `dispatchAuthEndpoint` forces `asResponse: false` before calling the handler, so
 * `ctx.context.returned` is the object `ctx.json()` was given rather than a `Response`.
 */
function mintedAToken(returned: unknown): boolean {
  if (typeof returned !== "object" || returned === null) return false;
  const token = (returned as { token?: unknown }).token;
  return typeof token === "string" && token.length > 0;
}

/**
 * What one observer saw, and — where it knows — what the absence of it was.
 *
 * Most observers know only "it did not happen", and for those the path entry's {@link PathEvent.withoutEvidence}
 * is the whole answer. The send paths know more, because the email capability told them: a **withheld**
 * message is a rule declining to act, a **failed** enqueue is a fault, and recording the two alike would
 * wake somebody looking for an abuser when a binding is missing, or bury a broken seam among the rows an
 * abuse count is made of.
 */
export interface EvidenceReading {
  /** Whether the thing the action claims was actually observed. */
  observed: boolean;
  /** What the absence was, where the observer knows more than "not seen". Null leaves it to the entry. */
  absence: { outcome: "denied" | "failure"; reason: string } | null;
}

/** What the email seam's answer says about the two send paths' claim. Null means it was never reached. */
function readDelivery(delivery: AuthEmailDelivery | null): EvidenceReading {
  // Never reached: Better Auth's enumeration guard returned before the callback, or the kit's own
  // `type` check did. Nothing underneath has an opinion, so the path entry decides.
  if (delivery === null) return { observed: false, absence: null };
  if (delivery.delivery === "queued") return { observed: true, absence: null };
  return {
    observed: false,
    absence: {
      // A withheld message is the email capability working; a failed one is this deployment not.
      outcome: delivery.delivery === "failed" ? "failure" : "denied",
      reason: delivery.reason,
    },
  };
}

/**
 * How each kind of evidence is seen, one observer per {@link PathEvidence} member.
 *
 * **A total record, so the union cannot outgrow it.** A new kind of evidence added to the type without
 * a way to observe it is a compile error here, and a new entry in {@link PATH_EVENTS} cannot name a kind
 * that is not in the union. That is the whole gate: an entry that claims an outcome it cannot evidence
 * does not exist.
 */
export const EVIDENCE_OBSERVERS: Readonly<Record<PathEvidence, (req: AfterRequest) => EvidenceReading>> = {
  "session-ended": (req) => ({ observed: req.endedSession !== null, absence: null }),
  "message-queued": (req) => readDelivery(req.messageDelivery),
  "token-minted": (req) => ({ observed: mintedAToken(req.returned), absence: null }),
};

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
 *
 * **Then evidence, because a completed response is not the same as a completed action.** A path event is
 * `success` only when its declared evidence is there; without it the entry's `withoutEvidence` says what
 * a completed-but-empty response is, and `denied` or nothing is written instead.
 *
 * **An observer that knows why outranks both.** The email seam answers whether it queued a message, and
 * where it did not, whether it *withheld* one or *failed* to make one. A withheld message is that
 * capability working correctly, so the row is `denied` and carries the reason; a failed enqueue is
 * `failure`, `warning`, and the same reason column. It outranks the refusal branch on purpose:
 * `/sign-in/magic-link` answers 500 when the enqueue throws, and "the request was denied" is not what
 * happened there.
 *
 * **`metadata.reason` is a closed vocabulary and never an address.** A suppression reason from
 * `@pithy-sh/email`, or `SEND_FAULT`. The row still names an action, an outcome, an actor and a
 * correlation, and nothing about who was being mailed.
 *
 * **Nothing here changes what the caller is told, and on one path that is load-bearing.**
 * `/email-otp/send-verification-otp` answers 200 for an address it declined precisely so that a caller
 * cannot tell a registered address from an unregistered one; this function is an `after` hook that
 * writes an audit row and returns, so the status, the body and the headers are whatever the endpoint
 * decided. The row names no address either — action, outcome, actor and correlation, as every other path
 * event does. The trail may know; the response does not say.
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
  const reading = EVIDENCE_OBSERVERS[event.evidence](req);
  // A refusal is never evidence of the action, whatever else is lying around from earlier in the request.
  const happened = !refused && reading.observed;
  // Nothing happened, nothing was refused and nobody underneath has anything to report: no row, because
  // there is no event to record.
  if (!happened && !refused && !reading.absence && event.withoutEvidence === "silent") return;
  const outcome = happened ? "success" : (reading.absence?.outcome ?? "denied");
  const actorId = req.newSession?.userId ?? req.currentUserId ?? req.endedSession?.userId ?? undefined;
  await safeEmit(emit, {
    action: event.action,
    outcome,
    // A send seam that broke is the one of these an operator has to act on, and `info` is where a row
    // goes to be counted rather than seen.
    ...(outcome === "failure" ? { severity: "warning" as const } : {}),
    actorType: actorId ? "user" : "anonymous",
    actorId,
    ...corr,
    ...(happened || !reading.absence ? {} : { metadata: { reason: reading.absence.reason } }),
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
 * - An authenticated caller — `/unlink-account`, a link from a signed-in session, an operator's console
 *   endpoint — is `user`, named.
 * - A request with no session — a first social sign-up completing at `/callback/:id`, a server-to-server
 *   call holding no credential — is `anonymous`: an address, and no identity.
 * - No request at all is `system`, with no actor id and no ip: there is no caller to name and nothing to
 *   borrow one from.
 *
 * **A cascade is not a fourth case, and an earlier revision of this list said it was.** `deleteWithHooks`
 * resolves its context from `getCurrentAuthContext()`, which is async-scoped to the dispatch, so the
 * cascade `internalAdapter.deleteUser` runs carries whatever context reached it: an operator deleting
 * somebody through an endpoint is named as the actor of every row it writes, with their address, because
 * they caused every one of them. `system` is what *no request* looks like — a queue consumer, a script,
 * a migration — not what a cascade looks like, and the two were written down here as the same thing. The
 * rule that does hold everywhere is the one above it: the account's owner is never the actor merely for
 * owning the row. Both shapes are driven in `emit.workers.test.ts` rather than asserted here.
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

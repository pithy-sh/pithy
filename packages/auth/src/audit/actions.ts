// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The audit action codes `@pithy-sh/auth` emits, as `domain/reason` strings under the `auth` domain.
 *
 * Auth emits through core's `emit` seam (`c.var.emit`), so it never imports `@pithy-sh/audit` — audit
 * is an optional capability (principle 4: depend on core seams, not other capabilities). When audit is
 * absent the seam is a no-op; when present these land in `pithy_audit_events`. Every code matches core's
 * `AuditAction` pattern; `actions.test.ts` asserts it.
 */
export const AuthAuditActions = {
  /** A sign-in completed (magic link, OTP, or OAuth). Outcome `denied` for a blocked attempt. */
  signin: "auth/signin",
  /**
   * A sign-out / session revocation completed — and **completed** is the load-bearing word.
   *
   * `/sign-out` answers `200 {"success":true}` whether or not it found a session to delete: an expired
   * cookie, a bearer token (which it does not read) or a bare `curl` all get the same body. Recorded off
   * the path, every one of them wrote a sign-out that signed nobody out. The evidence is a session row
   * disappearing, which `../instance/auth.ts`'s `session.delete.after` observes and `../audit/evidence.ts`
   * carries to the emitter; with no session gone there is no event, because nothing happened.
   */
  signout: "auth/signout",
  /** A session was exchanged for a fresh access token, rotating the refresh credential. */
  tokenRefresh: "auth/token_refresh",
  /** A consumed (already-rotated) refresh token was replayed — reuse detected, the family revoked. Outcome `denied`. */
  tokenReuseDetected: "auth/token_reuse_detected",
  /** A magic link was requested and enqueued for delivery. */
  magicLinkSent: "auth/magic_link_sent",
  /** An email OTP was requested and enqueued for delivery. */
  otpSent: "auth/otp_sent",
  /**
   * A social account row was created — from here on that provider can sign in as this user.
   *
   * **Emitted from the row, not from `/link-social`, and that is the whole of #627.** Minting the
   * provider redirect is a request; the account row is created later at `/callback/:id` and may never be
   * created at all — the person abandons the consent screen, the provider refuses, the linking gate
   * rejects it. Recorded at the request, every one of those wrote a success row for a link that never
   * happened, which makes "which providers can sign in as this account today" unanswerable from the
   * trail that exists to answer it.
   *
   * **A first social sign-up writes this too, deliberately.** The endpoint wiring this replaced refused
   * to map `/callback/:id` because doing so "would mislabel every first sign-up as a link" — true of a
   * *path*, which cannot tell a sign-up from a link. From the row it stops mattering: this event claims a
   * provider can now sign in as this user, and a first social sign-up is exactly when that becomes true.
   * Pinned by `emit.workers.test.ts`, so the decision is asserted rather than inferred from the absence
   * of a branch.
   */
  oauthLinked: "auth/oauth_linked",
  /**
   * A social account row was removed — that provider can no longer sign in as this user.
   *
   * The other half of the same question, and it emitted nothing at all until #627: a provider was
   * detached and the trail was silent. Emitted from the row for the same reason its twin is, which also
   * means it covers every way a link ends — `/unlink-account`, and the cascade when a user is deleted —
   * rather than the one endpoint somebody remembered to wire. Both are driven in `emit.workers.test.ts`:
   * a sentence claiming a class is covered is not the same as a test that reddens when it stops being.
   *
   * **The actor is whoever caused it, which on a cascade is nobody.** `delete.after` fires for the
   * cascade as readily as for an unlink, so attributing the row to the account's owner would say that
   * person detached their own providers when an operator deleted them — from the operator's address. The
   * owner is the *subject* and rides in `metadata.userId`; `actorId` is the caller or nothing.
   */
  oauthUnlinked: "auth/oauth_unlinked",
  /** A device was registered or updated from sign-in metadata. */
  deviceRegistered: "auth/device_registered",
  /** A device was revoked (its session(s) signed out). */
  deviceRevoked: "auth/device_revoked",
  /**
   * Somebody tried to sign in with a provider this deployment enables and cannot serve — its credential
   * would not resolve, so the instance was built without it (#381). Outcome `denied`, severity
   * `warning`.
   *
   * **This is the operator's channel, and it is why degrading is not the same as degrading silently.**
   * The refusal the caller gets names the provider, but a caller is not who fixes this; nobody at the
   * adopter learns a sign-in method is down from a browser somebody else is holding. The trail carries
   * one row per attempt, naming the provider, so the question "since when, and how many people has it
   * cost" is answerable from the same place every other auth question is.
   */
  providerUnavailable: "auth/provider_unavailable",
  /**
   * Somebody signed in tried to attach a social provider without having authenticated recently enough.
   * Outcome `denied`, severity `warning`.
   *
   * Attaching an identity grants permanent access — after it, sign-in resolves by account id and the email
   * stops mattering — so this is the row that answers "was somebody walking a stolen credential at the
   * account-takeover step". One is a person who left a tab open; a run of them against one user id is the
   * incident, and without the row there is nothing to count.
   *
   * Mirrors the error code, which is this file's one precedent for doing so.
   */
  sessionNotFresh: "auth/session_not_fresh",

  /**
   * The admin actions, emitted only from the control-plane surface (`http/adminRoutes.ts`) and always
   * with `actorType: "control-plane"` — a management client is not a user of the adopter's app, so its
   * actions must be answerable separately from their users'.
   *
   * **The reads are audited too, and that is not padding.** Listing the user table hands a management
   * client every customer's email address; reading one user hands over where they signed in from and on
   * what. If only the writes were recorded, the trail would show a compromised dashboard credential
   * revoking one session and say nothing at all about the customer list it walked on the way there —
   * and the exfiltration is the larger incident.
   */

  /** The user table was listed or searched from the management surface. A read of other people's data. */
  adminUsersListed: "auth/admin_users_listed",
  /** One user was read from the management surface, with their sessions and devices. */
  adminUserRead: "auth/admin_user_read",
  /** The device registry was walked from the management surface. */
  adminDevicesListed: "auth/admin_devices_listed",
  /** One named session was revoked from the management surface. */
  adminSessionRevoked: "auth/admin_session_revoked",
  /** Every session a user held was revoked from the management surface — signed out everywhere. */
  adminUserSessionsRevoked: "auth/admin_user_sessions_revoked",
  /** One of a user's devices was signed out and its registration dropped, from the management surface. */
  adminDeviceRevoked: "auth/admin_device_revoked",
} as const;

/** One of the auth audit action codes. */
export type AuthAuditAction = (typeof AuthAuditActions)[keyof typeof AuthAuditActions];

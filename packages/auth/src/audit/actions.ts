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
  /** A sign-out / session revocation completed. */
  signout: "auth/signout",
  /** A session was exchanged for a fresh access token, rotating the refresh credential. */
  tokenRefresh: "auth/token_refresh",
  /** A consumed (already-rotated) refresh token was replayed — reuse detected, the family revoked. Outcome `denied`. */
  tokenReuseDetected: "auth/token_reuse_detected",
  /** A magic link was requested and enqueued for delivery. */
  magicLinkSent: "auth/magic_link_sent",
  /** An email OTP was requested and enqueued for delivery. */
  otpSent: "auth/otp_sent",
  /** A social account (Google) was linked to a user. */
  oauthLinked: "auth/oauth_linked",
  /** A device was registered or updated from sign-in metadata. */
  deviceRegistered: "auth/device_registered",
  /** A device was revoked (its session(s) signed out). */
  deviceRevoked: "auth/device_revoked",

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

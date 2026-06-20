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
} as const;

/** One of the auth audit action codes. */
export type AuthAuditAction = (typeof AuthAuditActions)[keyof typeof AuthAuditActions];

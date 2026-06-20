# @pithy-sh/auth

Passwordless auth for Cloudflare. Magic link, email OTP, Google, Apple. Mobile and web, both first-class. Built on Better Auth. No email/password, ever.

This capability fills core's identity seams. It mints sessions, issues short-lived JWT access tokens, registers devices, and validates every request — so other capabilities just call `requireAuth()`.

## Passwordless, permanently

There is no password. There never will be. `emailAndPassword` is never enabled, and that is a security stance, not a missing feature. A user proves identity with a magic link, a one-time code, Google, or Apple. No password database to leak, phish, or reset.

The provider set: **magic link**, **email OTP**, **Google OAuth**, and **Apple Sign-In** (PKCE). Built on `better-auth@1.6.19` with Pithy's plugin set wired in.

## The token model

A successful sign-in mints a Better Auth **session** — the long-lived refresh credential. On mobile it lives in secure device storage. On web it is a CSRF-protected cookie.

The session is not what you put on every request. The app exchanges it for a short-lived **JWT access token** — 15 minutes, EdDSA — by calling `GET <basePath>/token`. Send that token as `Authorization: Bearer <jwt>`. The Worker verifies it locally against the published JWKS at `<basePath>/jwks`. No per-request database hit.

When the access token expires, mint a fresh one from the session. When the session expires, sign in again.

Mobile reads the session token from the `set-auth-token` response header on sign-in, then stores it. Web gets the session as a cookie automatically.

## Mobile vs web

**Mobile** uses bearer. `Authorization: Bearer <sessionToken>`. CSRF-exempt — there is no ambient credential to forge.

**Web** has two options. The same bearer flow as mobile, for SPAs that hold the token in memory. Or a cookie session — CSRF-protected via `Origin`/`trustedOrigins` checks and a `SameSite=lax` cookie. When cookie/session mode is on, CSRF protection is on with it. That pairing is not configurable apart.

## Enable it

```
pithy add auth
```

Then configure the mount in `pithy.config.ts`:

```ts
auth({
  basePath: "/auth",
  baseURL: "https://api.example.com",
  trustedOrigins: ["https://app.example.com", "myapp://"],
});
```

`basePath` defaults to `/auth`. `baseURL` is the public origin of this environment's auth worker. `trustedOrigins` lists every web origin and mobile deep-link scheme allowed as a redirect target and CSRF origin.

No handler code lands in your repo. The logic lives in the package and upgrades on a minor release.

## Dependencies

**Required.** `secrets` and `email`. Magic-link and OTP delivery never sends inline — the route enqueues an `@pithy-sh/email` job (`magicLink` or `otp` template) that a Workflow delivers.

**Optional.** `turnstile` auto-gates the magic-link and OTP send routes with zero config when it is present — a humanity check stacked on the public send routes. `audit` records `auth/*` events (sign-in, token refresh, device revoke) when composed.

## Secrets

Through `@pithy-sh/secrets`, never an env literal.

- `auth-session-secret` — the Better Auth signing and encryption secret. Create it:
  ```
  pithy secrets create auth-session-secret
  ```
- `auth-google-credentials` — only when Google is enabled. A typed JSON secret holding the `clientId` and `clientSecret` together. See [Google sign-in](#google-sign-in).
- `auth-apple-credentials` — only when Apple is enabled. A typed JSON secret holding the `clientId`, `clientSecret`, and optional `appBundleIdentifier`. See [Apple sign-in](#apple-sign-in).

## The device registry

Optional, opt-in per request. Pass device metadata at sign-in via headers:

| Header | Meaning |
| --- | --- |
| `x-pithy-device-id` | Client-generated stable id. The same physical device maps to one row across re-logins. |
| `x-pithy-platform` | `ios`, `android`, or `web`. |
| `x-pithy-device-name` | A human label for the device. |
| `x-pithy-push-token` | The APNs/FCM push token, stored for later push routing. |

When present, the device is registered or updated and the session is bound to it (`pithy_auth_sessions.device_id`). Two routes follow from that binding: list my devices, and revoke a device — sign out everywhere or just one.

## Tables

All `pithy_auth_*`, all run by `pithy migrate`:

`users`, `sessions`, `accounts`, `verifications`, `jwks`, `rate_limit`, `devices`.

The first six are Better Auth's. `devices` is Pithy's own.

## Rate limiting

Two limiters, two jobs.

**Tier 1 — the edge guard.** Cloudflare's native Workers Rate Limiting binding (`AUTH_RATE_LIMITER`) caps requests per client IP at the edge, with no storage round-trip. It runs in front of every auth route and blunts floods and credential-stuffing before they reach anything else. Set its limit and window on the binding in `wrangler.jsonc`; it is a required binding.

**Tier 2 — the per-action cap.** Better Auth's own limiter, D1-backed (`pithy_auth_rate_limit`), keyed per action and identity — the 5/min magic-link and 3/min OTP caps. D1-backed because in-memory limiting is per-isolate on Workers and so useless. Built in, no setup.

## Verification strategies

This package implements core's `bearer` and `session` strategies — it is the only capability that does. Every other capability gates routes with `requireAuth()` and reads identity off the `AuthContext` seam: `userId`, plus the session and device ids. No capability validates a token itself.

## Google sign-in

Google OAuth needs credentials you create by hand in Google Cloud Console — Pithy cannot mint them — and one exact redirect URI per environment. The full setup, including mobile deep links and account linking, is in [docs/google-oauth.md](./docs/google-oauth.md).

## Apple sign-in

Sign in with Apple is supported and mobile-first — Apple's App Store guidelines require it once you offer Google. Credentials are created by hand in the Apple Developer portal: a Services ID (`clientId`), a signed ES256 JWT (`clientSecret`, expires within six months — rotate it), and an optional `appBundleIdentifier` for the native iOS flow. All three travel as one typed JSON secret, `auth-apple-credentials`. Enable Apple in config with `apple: { enabled: true }`. The full setup, including the client-secret JWT, return URLs, and account linking, is in [docs/apple-signin.md](./docs/apple-signin.md).

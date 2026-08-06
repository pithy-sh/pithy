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

- `auth-session-secret` — the Better Auth signing and encryption secret. `pithy add auth` mints this project's **dev** value into `.dev.vars`, because nothing else names it: it is not a required binding, so without it the app boots healthy and fails at the first sign-in. Written only when absent — a new value signs out every live session. Deployed environments need their own:
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

## Signing in locally

Passwordless is right in production and a tax in development: every local sign-in is a magic link, and nothing automated can read a mailbox.

So auth ships a `dev-session` seed set. `pithy seed` mints a **real** session for a seeded user and writes `logs/dev-login.json`; `pithy dev` prints, on its ready banner, the line you paste into the browser console to be signed in.

Opt in per machine, never per repo — create `~/.config/pithy/<project>/dev.json` (`%APPDATA%\pithy\<project>\dev.json` on Windows):

```json
{ "user": "jim@acme.dev" }
```

Name any user the seed run creates — one of your own, or one of the example cast with `seed.includeExamples` on. Naming a user nothing seeds fails, listing who was seeded.

No file, no session. The set is `dev`-only, so it can never compose into staging or production, and the file it writes lives under the gitignored `logs/` because a seeded cookie is a live credential. The cookie's token is derived from a fingerprint of `auth-session-secret`: deterministic across reseeds, and invalidated by a rotation. Full detail in `docs/SEED.md`.

## Rate limiting

Two limiters, two jobs.

**Tier 1 — the edge guard.** Cloudflare's native Workers Rate Limiting binding (`AUTH_RATE_LIMITER`) caps requests per client IP at the edge, with no storage round-trip. It runs in front of every auth route and blunts floods and credential-stuffing before they reach anything else. Set its limit and window on the binding in `wrangler.jsonc`; it is a required binding.

**Tier 2 — the per-action cap.** Better Auth's own limiter, D1-backed (`pithy_auth_rate_limit`), keyed per action and identity — the 5/min magic-link and 3/min OTP caps. D1-backed because in-memory limiting is per-isolate on Workers and so useless. Built in, no setup.

## Verification strategies

This package implements core's `bearer` and `session` strategies — it is the only capability that does. Every other capability gates routes with `requireAuth()` and reads identity off the `AuthContext` seam: `userId`, plus the session and device ids. No capability validates a token itself.

It also contributes a `control-plane` surface under `/auth/admin`, which is a different thing entirely — see below.

## The management surface

A dashboard's user panes reach these. Every one is `control-plane` and **default-denied**: with `controlplane()` not composed, all of them answer `controlplane/not_connected`, and no app session opens any of them whatever it carries. `requireAuth()` never appears on one — the seam leaves `c.var.auth` null on purpose, so an auth gate here would deny every legitimate management call forever, and there would be no user to sign in as that could fix it.

| Method | Path | Scope |
|---|---|---|
| GET | `/auth/admin/users` | `auth:users:read` |
| GET | `/auth/admin/users/:userId` | `auth:users:read` |
| GET | `/auth/admin/devices` | `auth:devices:read` |
| POST | `/auth/admin/sessions/revoke` | `auth:sessions:revoke` |
| POST | `/auth/admin/users/:userId/sessions/revoke` | `auth:users:logout` |
| POST | `/auth/admin/users/:userId/devices/revoke` | `auth:devices:revoke` |

Five scopes, not one admin flag. Reading a user is a privacy operation; revoking their sessions is an availability one. A support tool that looks people up should never be able to sign the whole customer base out, and an incident-response tool that kills a stolen session has no business reading every address in the user table. Scope matching is exact — no prefix rule — so `auth:users` grants none of them.

**Nothing here is impersonation.** "Sign in as this user" mints a credential indistinguishable from the person's own, so every action taken with it reads in the audit trail as theirs. It is excluded on purpose and is not reachable by composing what is here: no route mints a session, and no read projects a session token. If it is ever built it gets its own design and its own security review.

Both listings are cursor-paginated, never offset — users on `(createdAt, id)`, devices on `(lastSeenAt, userId, id)`. People sign up while somebody is paging through, and offset would shift rows under them.

Every call is audited, reads included, as `actorType: "control-plane"` with the token's verified subject as the actor. Reading the user table hands a management client every customer's email address; if only the writes were recorded, the trail would show one revoked session and say nothing about the customer list walked on the way there.

Responses are projections, never rows. A session's **token** never leaves the Worker (it is the credential), a device's **push token** never leaves (it is a capability to reach somebody's phone), and provider OAuth tokens are never even loaded — the account read selects `providerId` and nothing else.

## Google sign-in

Google OAuth needs credentials you create by hand in Google Cloud Console — Pithy cannot mint them — and one exact redirect URI per environment. The full setup, including mobile deep links and account linking, is in [docs/google-oauth.md](./docs/google-oauth.md).

## Apple sign-in

Sign in with Apple is supported and mobile-first — Apple's App Store guidelines require it once you offer Google. Credentials are created by hand in the Apple Developer portal: a Services ID (`clientId`), a signed ES256 JWT (`clientSecret`, expires within six months — rotate it), and an optional `appBundleIdentifier` for the native iOS flow. All three travel as one typed JSON secret, `auth-apple-credentials`. Enable Apple in config with `apple: { enabled: true }`. The full setup, including the client-secret JWT, return URLs, and account linking, is in [docs/apple-signin.md](./docs/apple-signin.md).

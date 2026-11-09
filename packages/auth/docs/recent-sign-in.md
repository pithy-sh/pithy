# A recent sign-in for an app route

_This copy ships in the package because `README.md` sends an adopter to it by name._

Some routes should not be reachable on a session that has been open all week. Revealing a stored account number. Changing who can see something. Exporting a person's data. `requireRecentSignIn` gates one such route on a sign-in within the window the route names, and refuses everything else with one code every client handles the same way.

## When to use it

Use it on a route where a stolen or unattended session would do lasting harm the account holder cannot undo: a secret shown once, a change of who has access, an action that sends money or data out. Leave it off ordinary reads and writes. A gate a person meets on every screen trains them to sign in without thinking, and it costs them a sign-in for nothing.

It is not a permission check. It stacks after the route's own gates and adds one question: did this caller sign in recently? Who may call the route is still `requireAuth()`, a role or a scope.

## Using it

```ts
import { requireRecentSignIn } from "@pithy-sh/auth/src/http/recentSignIn";

app.post(
  "/things/:id/secret",
  describeRoute({ … }),
  requireRecentSignIn({ maxAgeSeconds: 300, purpose: "things/secret_revealed" }),
  validate("param", ThingParams),
  handler,
);
```

- **`maxAgeSeconds`** is the window, a whole number above zero. Five minutes suits a secret shown once; fifteen suits a settings change. It is the route's own, so two routes can hold two windows.
- **`purpose`** names what the route protects as `<domain>/<reason>`, in your app's own domain. It is recorded on every refusal.

Both are checked when the route is declared. A `maxAgeSeconds` of `0`, `2.5` or `"300"`, or a `purpose` that is not `<domain>/<reason>`, throws at startup rather than on a request.

## What it checks

Each session carries `authenticatedAt`, the instant its holder signed in. A sign-in stamps it, and nothing else does: `/token/rotate` carries it forward to the successor unchanged. The gate passes a session whose `authenticatedAt` is no older than `maxAgeSeconds`, boundary included.

It refuses a session whose `authenticatedAt` is older, absent, unreadable, or in the future. None of those is evidence of a recent sign-in.

A bearer session and a cookie session are judged by the same rule. There is no exemption by client kind, and none can be configured: an on-device biometric check is not proof the Worker can verify, so an exemption for phones would pass any stolen bearer token.

## The refusal

| Caller | Status | Code |
|---|---|---|
| No credential, or one that does not resolve | 401 | `auth/invalid_token`, exactly as `requireAuth()` answers |
| Signed in, but not within `maxAgeSeconds` | 403 | `auth/recent_sign_in_required` |

The 403 body is the kit's error envelope:

```json
{ "error": { "code": "auth/recent_sign_in_required", "status": 403, "message": "Sign in again to continue. Nothing was changed." } }
```

The handler never ran, so nothing was changed, and the message says so. The code is the same on every gated route in every app, so a client writes its handling once. `@pithy-sh/i18n` carries the message in Spanish, keyed by the code.

Before it throws, the gate records `auth/recent_sign_in_refused` on the audit trail, with the user, the session, and your `purpose` as `metadata.purpose`. An operator can read how often a route turned callers away, and for what.

## A web client

A browser holds a cookie session. On a 403 with `auth/recent_sign_in_required`:

1. Keep what the person was doing: the route, its body, the screen they were on.
2. Send them through a sign-in: a magic link, a code, or a provider button. Each one sets a new session cookie with a new `authenticatedAt`.
3. Retry the request once.

Do not sign the person out first. The old session still works for every ungated route, and a fresh sign-in replaces it. Do not retry without a sign-in: the answer will be the same.

## A phone client

A native app holds a bearer session through `createBearerSession`, and its credential rotates through `/token/rotate` before it expires. **A rotation never passes the gate.** The successor keeps the original `authenticatedAt`, so a phone signed in last month is still signed in last month after a thousand rotations. An app that answers the refusal by rotating, or by retrying, loops forever.

On a 403 with `auth/recent_sign_in_required`:

1. Keep what the person was doing.
2. Run a sign-in: an email code, or a provider through the handoff in [`apple-signin.md`](apple-signin.md) §6. It answers with a new raw session token.
3. Hand that token to `session.adopt(token)`. It is held and stored before `adopt` resolves, and every request after it carries the new session, with a new `authenticatedAt`.
4. Retry the request once.

An on-device biometric prompt may come before step 2, to decide whether to offer the sign-in at all. It never replaces it.

## The provider-change gate

Connecting and disconnecting a sign-in provider (`POST /auth/link-social`, `POST /auth/unlink-account`) holds its own gate on the same check, with a fixed fifteen-minute window. It refuses with `auth/session_not_fresh` and records the provider-change audit event, not these. A client meets that code only on those two routes and handles it the same way: sign in again, then retry.

For a check outside a route, import the same test the gates use:

```ts
import { authenticationIsFresh } from "@pithy-sh/auth/src/http/providerFreshness";
```

`authenticationIsFresh(authenticatedAt, now)` reads that fifteen-minute window. `authenticationIsFresh(authenticatedAt, now, seconds)` reads the window given.

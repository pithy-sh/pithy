---
"@pithy-sh/auth": minor
---

A refused sign-in is recorded, and a refusal a screen can read.

**No Better Auth denial had ever reached the audit trail.** `onAPIError: { throw: true }` reads as though an endpoint's `APIError` reaches the Hono boundary, and none of them do: better-auth re-raises it straight into better-call's own catch, which renders it as a Response and returns it. The throw is swallowed one frame later by the library that asked for it. So the `emitDenied` call gated on catching one had never run — not for a failed one-time code, not for a bad magic link, not for a refused OAuth callback, which between them are the largest class of security event this capability has. It reads the refusal off the Response now.

**And it is recorded only where a denial is a sign-in attempt.** `emitDenied` writes `auth/signin outcome=denied actorType=anonymous`, which is the row a brute-force alert counts, and the catch-all carries far more than sign-in. A logged-out tab polling `/update-user` with a stale cookie is not a failed sign-in, and recording it as one would let an unauthenticated loop bury real credential-stuffing under noise wearing the same shape.

**Every Better-Auth-owned route was unreadable to the browser client.** `readFailure` read `body.error` and nothing else, so a refusal in Better Auth's own flat `{ message, code }` — the one-time code, the magic link, sign-out, `get-session`, the social handoff — became `client/unreadable`, and a person who mistyped their code was told the app was broken rather than that the code was wrong. In a screen `pithy ui add` copies into a repository Pithy cannot reach. It reads both shapes now, and `code` arrives in whichever vocabulary produced it: `auth/invalid_token` is ours, `INVALID_OTP` is Better Auth's.

**The wire is unchanged, deliberately.** Re-homing Better Auth's body into the kit envelope was tried and taken back out. `packages/auth/README.md` documents `createAuthClient` from `better-auth/client` as a first-class client surface, and its fetch layer builds an error as `{ ...parsedBody, status }` — so rewriting the body would make `error.code` `undefined` for every adopter on the documented path. The flat shape is a contract we do not own. This side learns to read it.

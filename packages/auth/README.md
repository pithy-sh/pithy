# @pithy-sh/auth

Passwordless auth for Cloudflare. Magic link, email OTP, Google, Apple, Facebook, GitHub, Microsoft. Mobile and web, both first-class. Built on Better Auth. No email and password, ever.

This capability fills core's identity seams. It mints sessions, issues short-lived JWT access tokens, registers devices, and validates every request — so other capabilities just call `requireAuth()`.

```sh
pithy add auth
```

**Documentation: [pithy.sh/docs/capabilities/auth](https://pithy.sh/docs/capabilities/auth).** Overview, adding it, using it, and the reference: the token model, sessions and devices, JWKS.

_Everything else is on the site. `pithy.sh/docs` is canonical — new prose goes there, not here._

## The client surface

Better Auth builds a client from its **own** plugin list. The server's type never crosses into a browser bundle, so composing `organization()` on the server is half of it — add `organizationClient()` beside it and `authClient.organization` is fully typed, with no cast:

```ts
import { createAuthClient } from "better-auth/client";
import { emailOTPClient, magicLinkClient, organizationClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL: "https://api.example.com",
  basePath: "/auth",
  plugins: [magicLinkClient(), emailOTPClient(), organizationClient()],
});
```

The kit's own sign-in plugins have client halves too, and they go in the same list — nothing about the client is inherited from the server.

The one thing that does need the server's type is `inferAdditionalFields`, which teaches the client about extra user and session fields. `AuthInstance` is parameterized in the plugin tuple for exactly that:

```ts
import type { AuthInstance } from "@pithy-sh/auth/src/instance/auth";
import type { organization } from "better-auth/plugins/organization";

type AppAuth = AuthInstance<[ReturnType<typeof organization>]>;
// …then `inferAdditionalFields<AppAuth>()` in the plugins list above.
```

**This section stays here.** `src/http/routes.ts` and `src/client/api.ts` both explain a design decision by pointing a reader at it by name — the flat response shape is read rather than rewritten precisely because `createAuthClient` is a first-class surface, and that argument is only checkable against the client this documents.

## Provider sign-in is identity-based, by design

Pressing a provider button while signed out is not a claim on an address. It is a claim on an identity. Four outcomes, and they are the whole of it:

| # | Situation | Outcome |
|---|---|---|
| 1 | The provider identity is already attached to an account | Signs in |
| 2 | Not attached, and the provider's **verified** address matches an account | Links and signs in |
| 3 | Not attached, address unverified at the provider, an account exists there | Refused |
| 4 | Not attached, no account at that address | Refused |

**Rows 3 and 4 answer identically**, and that is a security property rather than a rough edge. They differ only in whether an account exists at an address the caller chose, and telling a stranger which one they hit is an account-enumeration oracle: one provider account, none on the target, unlimited queries. The decision is made in `src/instance/providerSignInGate.ts`, before Better Auth branches, so the two codes that used to answer it are never produced. The true reason goes to the audit trail, where an operator can read it and a browser cannot.

So: **do not "improve" this by matching more addresses, and do not make the refusal more helpful.** An address is not a credential — a provider hands over whatever primary happens to be set, chosen years ago for unrelated reasons — and every sentence that separates "you have no account here" from "you have one and this provider is not attached to it" is the oracle back. The remedy for a refused sign-in is the same either way: sign in with a magic link, then connect the provider from the account. Linking from inside the account is a different flow with both sides already proven, and it may attach a provider whose address differs from the account's. It may not attach one whose address that provider never verified: outside the trusted providers, Better Auth refuses the link. For Microsoft an address that matches the account's counts as verified, so only a different, unverified one is refused.

**Microsoft reaches row 3 more than any other provider, on purpose.** Entra ID cannot vouch for an email it did not verify: its `email` is a directory attribute a tenant admin sets to anything. So a Microsoft address is verified only by the `xms_edov` claim, the personal-accounts tenant, or — connecting from inside the account — matching the address the account already holds. `src/instance/microsoftEmail.ts` is the rule and `docs/microsoft-oauth.md` is the setup.

## Account lifecycle

An account can be suspended or deleted, and the kit refuses it at every door. An operator suspends and reinstates one through `POST /auth/admin/users/:userId/suspend` and `/reinstate`, under `auth:users:suspend`, with a reason the trail keeps. They delete one through `DELETE /auth/admin/users/:userId` — soft by default, restorable through `POST …/restore` until the purge window closes, or `mode: "hard"` to purge now — under `auth:users:delete`, and export everything the kit holds about one person through `GET …/export`, under `auth:users:export`. A person deletes their own account with `DELETE /auth/account { confirm: true }`, which is what the App Store and Google Play require of an app with accounts. A purge Workflow, hosted by your own Worker, erases a deleted account from every capability that holds it, one step per capability. Auth's own routes, sign-in and token refresh answer `auth/account_suspended` or `auth/account_deleted` (403); another capability's `requireAuth()` answers 401, and the client's next refresh gets the code. The admin user reads say where each account stands — `state`, `suspendedUntil` and `purgeAfter` — read the way enforcement reads them. [`docs/account-lifecycle.md`](docs/account-lifecycle.md) has the two states, the record, the scopes, the routes, the purge and the Workflow classes to export for it, the mail, the hooks, the screens, and the purge contribution a capability declares for its own rows.

## Verification ledger

Every sign-in link and code auth sends is recorded in `pithy_auth_verification_outcomes`: its type (`magic_link` or `otp`), the verification row that carries it, the account it signs in to, the `pithy_email_jobs` id of the mail that carried it, and when it was issued, expires and was used. Never the token, never the address. Better Auth deletes a verification on its first use, so without this a used link leaves nothing behind and an unused one looks like one still waiting. A sign-up has no account when its link is sent: its row joins to its mail by the job id, and gains the account when the link is used. The row is written when the email seam answers, so a withheld mail is recorded with its suppressed job and a failed one with none, and it is stamped when the link or code creates a session. A wrong code moves the row with it, so the right one entered next still stamps it. A management client reads it through `GET /auth/admin/verifications`, under `auth:verifications:read`: over `since`/`until` (the last 30 days by default), the counts by type of issued, used, expired unused and still pending, and the rows, newest first and paged, narrowed by `type` or `state` if asked. Join `emailJobId` to `email:jobs:read` and `email:suppressions:read` to see which sign-ins failed because the mail did not land. The purge erases an account's rows with the rest of it, and the export carries them.

## Server-authoritative writes

The leaderboard, rating and ledger gates open only for a caller your `resolveScopes` vouches for. A scope is an attestation about the caller, not a permission granted to the user. [`docs/server-authoritative.md`](docs/server-authoritative.md) ranks the three ways to prove it: a service binding, mTLS, and a short-lived token bound to this origin.

## License

MIT — adopter-side app value. The root `LICENSE` covers it.

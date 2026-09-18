# @pithy-sh/auth

Passwordless auth for Cloudflare. Magic link, email OTP, Google, Apple. Mobile and web, both first-class. Built on Better Auth. No email and password, ever.

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

So: **do not "improve" this by matching more addresses, and do not make the refusal more helpful.** An address is not a credential — a provider hands over whatever primary happens to be set, chosen years ago for unrelated reasons — and every sentence that separates "you have no account here" from "you have one and this provider is not attached to it" is the oracle back. The remedy for a refused sign-in is the same either way: sign in with a magic link, then connect the provider from the account. Linking from inside the account is a different flow with both sides already proven, and it is deliberately unconstrained by the address.

## License

MIT — adopter-side app value. The root `LICENSE` covers it.

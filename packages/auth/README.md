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

## License

MIT — adopter-side app value. The root `LICENSE` covers it.

# Server-authoritative writes

_This copy ships in the package because `src/capability.ts` sends an adopter to it by name._

Some writes belong to your backend and never to a device. A score, a match result, a balance. `@pithy-sh/auth` decides, per request, whether the caller is your backend. This page is how.

## What a scope is

Four routes in the kit check a scope on `AuthContext`:

| Scope | Capability | What it opens | Off switch |
|---|---|---|---|
| `leaderboard:submit` | `@pithy-sh/leaderboard` | `POST /leaderboard/:board` | `serverAuthoritative: false` |
| `leaderboard:admin` | `@pithy-sh/leaderboard` | hide and remove another player's entry | none |
| `rating:record` | `@pithy-sh/rating` | `POST /rating/games/:game/outcomes` | `serverAuthoritative: false` |
| `ledger:admin` | `@pithy-sh/ledger` | credit and debit another player's balance | none |

**A scope is an attestation about the caller, not a permission granted to the user.** It says *this write came from your trusted backend*. It is not a role. Tenancy roles live on `c.var.acting`, from `@pithy-sh/organization`. Management access is the control plane's, with its own credential.

Every gate fails closed. With nothing to fill the array, each one refuses every caller. `pithy doctor` names each gate in that state, per Worker, on its `scopes` line.

## The seam: `resolveScopes`

```ts
// apps/api/pithy.config.ts
auth({
  baseURL: PUBLIC_ORIGIN,
  resolveScopes: async (c) =>
    (await verifyCallerRequest(c, { audience: PUBLIC_ORIGIN })).trusted ? ["leaderboard:submit", "rating:record"] : [],
}),
```

The session middleware calls it on every authenticated request, after Better Auth resolves the session. What it returns becomes `c.var.auth.scopes`. It is handed the request context and the session, `{ userId, sessionId }`.

- **Per request, never cached.** A cached scope is a revocation that has not taken effect.
- **Closed on failure, never fatal.** A resolver that throws, or answers anything but a list of strings, leaves the request with no scopes. It logs at warn and the request goes on to its gate, which refuses it.
- **No default.** Without one the array is empty and nothing extra runs.
- **Never from what the request says.** Not a header like `x-scopes`, not a body field, not a query parameter. Only from what the request proves.

The trusted backend still holds a session of its own, on `Authorization`. The proof sits beside it.

## Three ways to prove the caller

In order. Use the first one you can.

### 1. A service binding. No credential at all.

If your trusted backend is a Worker, call over a service binding. There is no public network path, so there is nothing to steal, expire or rotate. **Where you can use this, the other two are unnecessary.**

A request that arrives over a binding carries no mark of it, so the boundary is the Worker itself. Compose the gated capabilities into a Worker with no public address — `workers_dev: false`, `preview_urls: false` and no `routes` in its `wrangler.jsonc` — and share the database by declaring the same `DB` binding. Nothing but a binding can reach that Worker, so its resolver answers for every request it receives:

```ts
// apps/internal/pithy.config.ts — reachable only over a service binding
auth({ baseURL: INTERNAL_ORIGIN, resolveScopes: () => ["leaderboard:submit", "rating:record", "ledger:admin"] }),
```

The caller declares `{ type: "service", name: "INTERNAL", service: "internal" }`. Give it a route later and the resolver above trusts the internet, so the two decisions stay together.

### 2. mTLS. Refused at the edge.

A client certificate is sender-constrained: a stolen token is useless without the private key. Cloudflare-managed client certificates are available on every plan. They need a proxied zone and a hostname that matches the certificate exactly. No wildcards, so not `workers.dev`.

**The zone rule is the gate.** Create a WAF custom rule on the hostname, action Block:

```
(http.host eq "api.example.com" and not cf.tls_client_auth.cert_verified)
```

It runs before the Worker, so a caller without a verified certificate never reaches your code. Scope it to the paths only your backend calls if devices share the hostname.

**The Worker helper is defense in depth, not the gate.** `readClientCertificate` reads `request.cf.tlsClientAuth`, and `isTrustedCertificate` checks it against pins. On its own it blocks nothing. A Worker with no zone rule in front of it receives every request, certificate or not.

```ts
import { isTrustedCertificate, readClientCertificate } from "@pithy-sh/auth/src/caller/certificate";

resolveScopes: (c) =>
  isTrustedCertificate(readClientCertificate(c.req.raw), { fingerprintsSHA256: [GAME_SERVER_CERT] })
    ? ["leaderboard:submit"]
    : [],
```

The helper answers four states: `absent`, `unverified`, `revoked` and `verified`. Only `verified` with `certVerified === "SUCCESS"` and no revocation is trusted, and only against a pin. With no pin it trusts nothing, because every certificate your zone's CA issued would pass.

### 3. A short-lived token bound to this origin. Works anywhere.

The portable default, `workers.dev` included. A token signed with a key from `@pithy-sh/secrets`, minted for this Worker's origin, alive for minutes.

Declare the key in the project registry, so `pithy secrets` mints and rotates it:

```ts
import { callerTokenRegistry } from "@pithy-sh/auth/src/caller/request";

secrets({ registry: { ...authSecretsRegistry, ...callerTokenRegistry } }),
```

Mint on the backend, one token per call or per few minutes, and send it on the `pithy-caller` header:

```ts
import { mintCallerToken } from "@pithy-sh/auth/src/caller/token";

const { currentVersion, versions } = (await secretsStore(env, callerTokenRegistry)).getVersions("auth-caller-token-key");
const token = await mintCallerToken({ key: versions[currentVersion], kid: currentVersion, audience: API_ORIGIN });
```

Verify in the resolver with `verifyCallerRequest`, as in the first example. It refuses, each on its own:

- an expired token,
- a token minted for another origin,
- a token signed by a key the store does not hold,
- anything that is not a well-formed HS256 compact JWS.

A token lives five minutes by default and fifteen at most. A token claiming longer is refused even when everything else checks out. The key rotates with an overlap, so a token minted a moment before a rotation still verifies.

**It is not sender-constrained.** A token lifted off the wire works for whoever lifted it, for the minutes it has left. The short lifetime is what bounds that. DPoP would bind it to the sender; the kit does not ship it yet.

## What not to do

**Do not compare a long-lived shared secret in a header.** It is the shape everyone reaches for, and it fails every control RFC 9700 names at once: it is not least-privilege, it is not bound to an audience, it does not expire and it is not bound to its sender. One leak is permanent until somebody notices.

**Do not mint a scope from the user.** A player's account is not a trusted backend because of who owns it. Decide from the request, every time.

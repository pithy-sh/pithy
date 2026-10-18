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

**The session is the player's, and the backend forwards it.** A gated write is still an authenticated request, and the route acts for the session's user. `POST /leaderboard/:board` files the score under that user and takes no player in its body. So the backend relays the player's own session on `Authorization` and adds its proof beside it. A backend that called with a session of its own would put every score under its own account. Rating outcomes, ledger credits and the admin routes name their target in the body or the path, so any session works for them.

**The proof is not bound to that session.** A caller token, a certificate or a binding says the request came from your backend. It does not say which player the backend meant. Whichever session arrives beside a valid proof is the one the write is credited to, so the backend must forward only the session of the player the write is for.

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
(http.host eq "api.example.com" and (not cf.tls_client_auth.cert_verified or cf.tls_client_auth.cert_revoked))
```

Both halves. A revoked certificate whose chain still verifies reports `cert_verified` true, so the first half alone lets it through. This is the shape of the rule Cloudflare generates for mTLS.

It runs before the Worker, so a caller without a verified, unrevoked certificate never reaches your code. Scope it to the paths only your backend calls if devices share the hostname.

**The Worker helper is defense in depth, not the gate.** `readClientCertificate` reads `request.cf.tlsClientAuth`, and `isTrustedCertificate` checks it against pins. On its own it blocks nothing. A Worker with no zone rule in front of it receives every request, certificate or not.

```ts
import { isTrustedCertificate, readClientCertificate } from "@pithy-sh/auth/src/caller/certificate";

resolveScopes: (c) =>
  isTrustedCertificate(readClientCertificate(c.req.raw), { fingerprintsSHA256: [GAME_SERVER_CERT] })
    ? ["leaderboard:submit"]
    : [],
```

The helper answers four states: `absent`, `unverified`, `revoked` and `verified`. Only `verified` with `certVerified === "SUCCESS"` and no revocation is trusted, and only against a fingerprint pin. Without one it trusts nothing, because every certificate your zone's CA issued would pass. An issuer pin is an extra check, never a substitute: on the Cloudflare-managed CA every certificate the zone verifies names the same issuer.

### 3. A short-lived token bound to this origin. For a backend off Cloudflare.

The option for a backend that is not a Worker, on `workers.dev` or any other host. A token signed with a shared key, minted for this Worker's origin, alive for minutes. A Worker of your own project does not need it: it calls over a service binding.

Declare the key in the project registry, so `pithy secrets` knows it:

```ts
import { callerTokenRegistry } from "@pithy-sh/auth/src/caller/request";

secrets({ registry: { ...authSecretsRegistry, ...callerTokenRegistry } }),
```

#### The signing key

Two parties hold one value: this Worker, which verifies, and your backend, which signs. **You make it, not the kit.** Nothing in the kit hands a stored value back out, so a key the kit minted is one your backend could never learn. `pithy secrets provision` therefore does not create it.

1. Generate 32 random bytes where your backend's secrets live: `openssl rand -base64 32`.
2. Store it in your backend's own secret manager.
3. Pipe the same value into each environment: `printf '%s' "$KEY" | pithy secrets create auth-caller-token-key --env prod`. In `dev`, write it into the dev secrets file with `pithy secrets edit`.

**Rotation is a cutover, and it is yours.** `pithy secrets update` replaces the value, and every value it writes is version `1`, so the backend signs with `kid: "1"`. A token signed with the old key is refused from the moment the Worker holds the new one. Generate the new value and change the Worker's copy and the backend's back to back. Writes between the two are refused, so the backend retries a refused write once it holds the new key. `pithy secrets rotate` does not invent a value here; it names this page.

Mint on the backend, one token per call or per few minutes, and send it on the `pithy-caller` header beside the player's session:

```ts
import { mintCallerToken } from "@pithy-sh/auth/src/caller/token";

const token = await mintCallerToken({ key: CALLER_TOKEN_KEY, kid: "1", audience: API_ORIGIN });
await fetch(`${API_ORIGIN}/leaderboard/weekly`, {
  method: "POST",
  headers: { authorization: `Bearer ${playerSession}`, "pithy-caller": token, "content-type": "application/json" },
  body: JSON.stringify({ score }),
});
```

Verify in the resolver with `verifyCallerRequest`, as in the first example. It refuses, each on its own:

- an expired token,
- a token minted for another origin,
- a token signed by a key the store does not hold,
- anything that is not a well-formed HS256 compact JWS.

A token lives five minutes by default and fifteen at most. A token claiming longer is refused even when everything else checks out.

**It is not sender-constrained.** A token lifted off the wire works for whoever lifted it, for the minutes it has left. The short lifetime is what bounds that. DPoP would bind it to the sender; the kit does not ship it yet.

## What not to do

**Do not compare a long-lived shared secret in a header.** It is the shape everyone reaches for, and it fails every control RFC 9700 names at once: it is not least-privilege, it is not bound to an audience, it does not expire and it is not bound to its sender. One leak is permanent until somebody notices.

**Do not mint a scope from the user.** A player's account is not a trusted backend because of who owns it. Decide from the request, every time.

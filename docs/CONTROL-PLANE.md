# The control-plane seam

How a management client reaches into your Worker, without Pithy operating a data plane.

---

## 1. Two things are called "control plane". This is the other one.

Read this section before anything else. The word is overloaded in this repo, and conflating the two meanings will lead you to the wrong file every time.

**Cloudflare's control plane** is outbound. It is the REST API that `@pithy-sh/cloudflare` calls to create a D1 database, manage a KV namespace, or deploy a Worker. It authenticates with *your* Cloudflare API token, runs from the CLI or CI, and never appears in a request handler. Its failures carry `cloudflare/*` error codes. See `packages/cli/src/feature/provision.ts` and `packages/cloudflare/`.

**This seam** is inbound. It is how a management client — the Pithy dashboard at `app.pithy.sh`, or one you write yourself — calls *your* Worker to read and administer *your* data. It authenticates with a key **you** registered, runs inside a request handler, and never talks to Cloudflare at all. Its failures carry `controlplane/*` error codes.

They share a name and nothing else. Outbound versus inbound, your CF token versus their signature, provisioning versus administration.

The strategy literal on a route stays `control-plane`, hyphenated, because that is what `VerificationStrategy` has always declared. Every namespace token is the single word `controlplane` — the capability name, the migration namespace, the `pithy_controlplane_*` table prefix, the `controlplane/*` error domain, the `controlplane/*` audit-action domain — because the namespace and action patterns forbid a hyphen. The audit *actor kind* is `control-plane`, hyphenated, because it names the strategy and an enum member may carry one.

---

## 2. What it is

`control-plane` is a verification strategy, like `bearer` or `session`. A route declaring it accepts calls from a registered management client and nobody else.

**It is present and denying by default.** A Worker that composes the capability and has never been connected answers every control-plane route with `controlplane/not_connected`. There is no flag to leave off, no backdoor, and nothing enabled silently. Connecting a client is a deliberate act, and until you perform it the seam's only behaviour is refusal.

**Your Worker is the authority.** The management client is a client. It holds a private key; you hold the public one, you decide what it may do, and you can revoke it without asking anyone.

---

## 3. The credential is asymmetric, and that is the whole design

The management client signs each call with an Ed25519 private key. You register the matching **public** key.

**Nothing secret of yours ever reaches us, and nothing we hold is worth stealing from you.** That is the property everything else follows from.

Three alternatives were considered and rejected.

**Not a shared HMAC secret.** Simpler, and strictly weaker: our breach becomes your breach. Holding a per-customer HMAC secret would mean a compromise on our side yields keys replayable against every customer's production Worker until each of them rotates. Under asymmetric, a full compromise of our infrastructure leaks private keys that are useless the moment you revoke the corresponding public one — and revoking is a row you delete.

**Not OAuth.** OAuth exists so a third party can act *on behalf of an end user* without seeing their credentials, and it needs an authorization server with consent and token endpoints. There is no user delegation on this leg — it is our server talking to your Worker — and turning every adopter's Worker into an OAuth provider is a large surface for a property nobody needs here. The `client_credentials` grant, the only part that would fit, is a shared secret with extra ceremony.

**Not Cloudflare Access service tokens or mTLS.** Both work, and both move the authorization decision out of your Worker into Cloudflare's edge configuration. That requires you to run Zero Trust and breaks the one sentence this design exists to keep true: your Worker is the authority.

---

## 4. The data path

A browser cannot hold a long-lived signing key. So the management client's server mints a **short-lived, single-scope, user-bound token** and hands it to the browser, which calls your Worker **directly**.

Response bodies never touch our origin on that path, and our private key never leaves our server.

Your Worker does not distinguish a browser call from a machine call, and deliberately so: both are the same 60-second, single-scope, body-bound token, verified by the same code. There is no second token class to get wrong, and no route whose auth model depends on which client made the call.

Some calls do transit our infrastructure — anything the dashboard aggregates or acts on server-side. For those, the commitment is a **zero-logging policy on your data**: we do not log, cache, or persist response bodies fetched from your Worker. We do not want your data, and the architecture is arranged so that wanting it would not help. What we store is our own: users, subscriptions, connection metadata, and our own private keys. Never your users, your purchases, your audit events, or your support mail.

---

## 5. Registration

One keypair per connection — per customer, per project, per environment. A leak exposes one connection rather than a fleet, and rotation and revocation are naturally scoped.

**We generate the keypair. The private key is born in our infrastructure and never leaves it.** The alternative — your CLI generating one and sending it to us — puts key material on the wire for no benefit.

```
pithy dashboard connect --env prod
```

1. The CLI starts a **device-code flow** against the management client's origin, prints a short user code, and opens your browser. Same shape as `wrangler login`. *This* leg is genuine user delegation, which is why a browser authorization flow belongs here and not on the machine-to-machine leg.
2. You approve in the browser. The CLI polls and receives a short-lived connect token.
3. The CLI requests a connection for this project, environment, the scopes you chose, and **the seam's address on this Worker** — its URL and its base path.
4. The dashboard generates an Ed25519 keypair, keeps the private half, and returns `{ connectionId, keyId, publicKeyJwk, issuer }`.
5. The CLI writes the registration into **your D1**. This is the one key the CLI ever writes — see §15.
6. **Nothing reports connected until a signed `ping` round-trip succeeds** against your Worker.

### The address, and which Worker it belongs to

**You do not pass the URL.** `connect` resolves it from the project: the Worker's `domains` declaration for that environment, else its first `routes` pattern, else a hand-set `vars.BASE_URL`. It prints what it found and where it came from before registering. `--worker-url` still overrides — a proxy in front of your Worker has an address no config knows — and it is the only way to say so.

**It also names the Worker.** The administrative surface is composed on one Worker per project, and a connection targets that one. In a project with several, `connect` refuses the ambiguity and asks for `--worker <name>` rather than guessing; a Worker that composes no `controlplane()` is refused outright, because there is nothing there to connect to.

**And it sends the base path.** The seam's mount point is configurable, defaulting to `/control-plane`, and it is the one address a client cannot discover — because it *is* the manifest's own address. Everything else is discoverable: `AdminRoute.path` carries the fully mounted path, so no client hardcodes a capability's mount point. Without this, a client has to assume the default, and if you mounted the seam at `/admin` you would register cleanly, pass the `ping` — called at that same assumed path — and then 404 on every call, with the operator diagnosing the wrong problem. It is stored beside the URL, and `--update` re-registers both.

The address changes: a custom domain, a renamed Worker, or a moved environment breaks the connection, so `pithy dashboard connect --update` re-points it. A connection whose ping fails surfaces as *needs reconnecting*, never as a silent dead link.

### One connection per project and environment

A customer may register **several projects**, each its own connection with its own keypair. The dashboard resolves how many a customer has and offers a picker when there is more than one; a single project needs no ceremony.

Sibling Workers are not separately addressable, and that is deliberate: the data being administered is shared through binding names rather than owned per Worker, so a second connection to a sibling would be a second credential onto the same rows.

### Without a dashboard

The seam is MIT and is not gated by anything. `--public-key <file>` registers a key you generated yourself, with no dashboard involved, so you can write your own management client and use every route on this page.

Rotating without one is your own call to make, literally: `POST /control-plane/keys` signed with the key you are replacing, exactly as §6 describes. `connect --public-key` registers a *first* key and refuses a successor while one is live, naming that call — it has no private half to sign with, and doing it for you would take the registration out of your own audit trail.

The contract that client is held to is a module you can import: `@pithy-sh/cli/src/dashboard/contract` carries the six calls, the six response shapes, and the hosted origin. It reaches for no timer, no `fetch`, and nothing from node, so it compiles in a Worker as readily as in a build script — implement `DashboardClient` against it and let the compiler tell you what you owe, rather than copying the field sets into a test that can drift.

---

## 6. Rotation: append, prove, then expire

Never replace. The order is the entire safety property.

1. **Append.** `POST /control-plane/keys`, signed with the **current** key, carries the new public key. Your Worker verifies with the key it already trusts and appends the new one. Trust flows forward from existing trust, exactly as a rotated refresh token does. Both keys are now valid.
2. **Prove.** A real call — `GET /control-plane/ping` — signed with the **new** key, and confirmed to succeed.
3. **Expire.** Only then does `POST /control-plane/keys/:keyId/expire` give the old key an end date, naming the proven successor — **and that call must itself be signed with the successor.** Naming a live key is not proof that you can sign with it; only signing with it is. A client still using the old key, naming a successor it has never actually used, would otherwise retire the one key that works.

Reverse those, or swap without proving the new key, and a bad rotation locks the client out permanently with no authenticated path back — you would have to re-run `pithy dashboard connect` by hand. **Two live keys is a normal state, not an exception**, which is what the versioned key array is for.

Registration and expiry are **separate calls on purpose.** Folding them into one would make append-and-expire atomic, and atomic is precisely wrong here: the point is that the old key survives until the new one has been proven.

The Worker refuses an expiry that names an unproven successor, and refuses one that would leave the connection with no live key at all. Lockout is the one failure mode with no recovery path, so it is rejected rather than trusted not to happen.

**Your infrastructure stays passive.** Storing a new key is one D1 write in a route handler. There is no Workflow to run and no cron to schedule on your side. The durable retrying orchestration that drives rotation across many Workers is the management client's problem, and it lives in their infrastructure.

**Rotation is a scope.** A client that was never granted `keys:rotate` cannot rotate, whatever it intends — better than a toggle somebody has to be trusted to honour.

### Who makes the calls

All three are made by the management client, because all three are signed and only it holds a private key. `pithy dashboard rotate` asks — it sends the seam's address from your own registration row, the client generates the successor and registers it at step 1, and the CLI reports what happened. **The CLI never writes a rotation into your D1** (§15).

That is why the second step is not decoration. The CLI reports a rotation as proven only when the `ping` comes back naming the *new* key, which is what that route's `keyId` echo is for. A ping answered by the key being replaced proves the connection and not the successor — and the successor is what the third step would retire the old key on the strength of.

An unreachable Worker fails the rotation and changes nothing on either side. Nothing is written anywhere until your Worker has accepted the registration, so there is no state in which your row and the client disagree about which keys exist.

---

## 7. Revocation

Delete the registration, or run `pithy dashboard disconnect --env <environment>`.

Immediate, unilateral, and requiring nothing from us. That is the property that makes granting this access defensible at all.

**One leaked key does not need the whole connection rebuilt.** `pithy dashboard revoke-key --env <environment> --key-id <id>` stamps that key revoked and leaves everything else in place. Revocation is checked before any validity window, so it takes effect on the next request.

It will take the last live key if you ask it to. Expiry is the orderly end of a rotation and is refused when it would leave nothing live; revocation is the disorderly one, and an adopter holding a leaked key must never be told they have to keep trusting it. The connection is then denying every call — the correct state for a credential you no longer trust — and `connect` is the way back.

---

## 8. Scopes

Scopes are **per management operation, not per credential-holder**. A credential that may read purchases cannot revoke an entitlement unless separately scoped, and anything unscoped is denied.

They are **stored and enforced on your side**. Enforced only by the caller, they would not be a limit.

Two checks, against different things. The connection row records what you granted. The token carries the **single** scope the current call needs — not the whole grant, so one call is never as dangerous as the most dangerous one you allowed. Both must agree.

Matching is exact. There is no prefix or wildcard rule: `payments:entitlements` does not confer `payments:entitlements:revoke`.

`GET /control-plane/ping` requires a verified caller and no scope at all. It is not modelled as a scope, because granting or withholding it would change nothing: ping must work for a connection granted nothing, since it is how a new key is proven before the old one is expired.

---

## 9. What a call must satisfy

Every step default-denies, and every failure raises the same `controlplane/invalid_credential`. One code for every step is deliberate — distinguishing "unknown key" from "bad signature" from "replayed token" would tell an attacker exactly how far they got. The failing step goes in the error's `detail`, which the HTTP codec strips before anything reaches the wire and which your logs keep.

1. Read `kid` from the token header and `aud` from its claims. **Untrusted at this point** — a parsed token is a well-formed shape, never an authentic one.
2. Load the connection named by `aud`. No connection registered for this environment: `controlplane/not_connected`.
3. The key named by `kid` must exist on that connection, not be revoked, and be inside its validity window.
4. Verify the EdDSA signature with that key, via WebCrypto. `alg` is pinned to the literal `EdDSA` at parse — the algorithm-confusion defence.
5. `aud` must equal the loaded connection's id, and its `environment` must equal this Worker's. **A staging credential cannot reach production.**
6. `iss` must equal the issuer that connection was registered against.
7. `exp` and `iat` are checked with a bounded clock skew, and a token claiming a lifetime longer than the configured maximum is rejected outright.
8. `jti` is claimed in the replay set, as a single-use insert. Already spent: denied.
9. The SHA-256 digest of the raw body is recomputed and compared. A signature over claims that do not bind the body would let an attacker swap the payload.
10. The scope check of §8.
11. An audit event is emitted — allowed or denied — and only then does the handler run.

### The replay guard, and why it now holds

A token is spendable exactly once, and that is a guarantee rather than a best effort.

The claim is a single-use insert into `pithy_controlplane_replays`, where `jti` is the primary key: `INSERT … ON CONFLICT DO NOTHING RETURNING`. The insert either wins the key or conflicts, so there is no window between deciding and recording, and of N concurrent presentations of one token SQLite admits exactly one — wherever those requests landed. It is the same move `@pithy-sh/auth` makes on the other side, consuming a refresh token with a conditional delete so that of N presentations exactly one wins.

The key is `jti` alone, not `(jti, connectionId)`. A composite would let a token captured from one connection be spent again against another, which is the property the guard exists to deny; the connection id is recorded beside it for the incident, never for the decision.

**This closes a hole earlier versions documented against themselves.** The set used to live in Workers KV, which has no compare-and-set and is eventually consistent across colocations — a `put` in one PoP is not immediately visible in another, so a replay arriving at a different colo inside the propagation window passed the guard. The exploitable action was narrow, since the token is bound to one connection, one scope, one body digest, and a 60-second expiry. Narrow is not harmless: a nudge sends real people a second email, a key registration appends, and anything that enqueues work enqueues it again.

The cost of closing it is one D1 write, and here that is close to free. **A control-plane hot path is an administrator clicking something** — low volume, high privilege — which is a different calculation from a per-request user path. The seam already owned a D1 namespace, so this is a second migration in an existing one rather than new infrastructure.

Rows carry an `expires_at` and are pruned after a successful claim, so the table cannot only grow — the one thing KV gave for nothing, since its entries expired themselves. Pruning deliberately does not run on a refused claim: otherwise replaying one token in a loop would drive an unbounded `DELETE` per attempt.

`replayBackend: "kv"` still selects the old implementation, behind the same `ReplayGuard` interface — which is what let the default move without touching a call site. It remains best-effort, with the race above as its stated price, and is a reasonable trade only where every management operation is idempotent. Choosing it also brings back the `CONTROL_PLANE` KV binding; the D1 default needs no KV namespace at all.

---

## 10. No session, no user row

**A control-plane call creates nothing in Better Auth.** That is precisely why `control-plane` is its own strategy rather than a flavour of `bearer`.

A dashboard user is not a user of your app. Minting a user or session row for one would put people who never signed up into your user table — inflating your counts, appearing in your DSAR exports, and creating a credential that might reach routes it was never scoped for.

The verified caller lands on `c.var.controlPlane`, never on `c.var.auth`. If it landed on `auth`, every `requireAuth()` in every capability would pass for a management client — a scope escalation across the whole tree from one convenient assignment. A test asserts the isolation, because it is the kind of property that regresses silently.

Statelessness is the feature: verify per request, expire in sixty seconds, leave nothing behind. Exactly two things outlive a call — the `jti` in the replay set, and the audit event.

---

## 11. Every call is audited

Through the `emit()` seam, under the `control-plane` actor kind, carrying the connection id and the dashboard user's own subject.

Your trail can then answer "what did the management client do" separately from "what did my users do", which is the question you will actually ask.

Denials are audited too. `denied` is a first-class outcome, and this is the surface where an unaudited blocked attempt is least acceptable. An audit write that fails never turns a correct denial into a 500 — the denial has already been decided by the time it is recorded.

---

## 12. The seam's own routes

| Route | Requires | Purpose |
|---|---|---|
| `GET /control-plane/ping` | any verified caller | Connectivity and key proof. Used at connect, and to prove a new key before the old one is expired |
| `GET /control-plane/manifest` | `manifest:read` | Which capabilities this Worker composes, **and how to call each one's admin routes** — path, method, and required scope. Discovery over configuration (§14) |
| `GET /control-plane/keys` | `keys:rotate` | The registration state — which keys are live, their ages, and their validity windows |
| `POST /control-plane/keys` | `keys:rotate` | Register a new public key. **Authenticated with the key it replaces** |
| `POST /control-plane/keys/:keyId/expire` | `keys:rotate` | Expire a superseded key, naming the proven successor |

---

## 13. Capabilities contribute their own admin routes

The same federation as migrations, error codes, and audit actions. A capability declares admin routes behind `requireControlPlane(scope)` and they compose into the tree with nothing to wire.

`@pithy-sh/payments` was the first: `POST /payments/entitlements/grant` and `/revoke`, the only way an entitlement appears without money moving. Five more followed, and between them they are what a dashboard's first panes read:

- **`@pithy-sh/payments`** — page the purchase log, the purchases that renew, and what accounts are entitled to; comp an entitlement or take one back. Scopes: `payments:purchases:read`, `payments:subscriptions:read`, `payments:entitlements:read`, `payments:entitlements:grant`, `payments:entitlements:revoke`. The reads landed late and the cost is worth stating: for a while this capability shipped the two writes with no read beside them, so a console could comp an entitlement and never list one, and three panes in the first adopter computed **absent** and dropped out of the rail. Not blocked, not refused — absent, which no grant and no seed can repair, because there was no route to grant a scope to. The reads never project a stored provider payload; the queries behind them do not select it.
- **`@pithy-sh/auth`** — find and read users with their sessions and devices; revoke a session, sign a user out everywhere, revoke a device. Scopes: `auth:users:read`, `auth:devices:read`, `auth:sessions:revoke`, `auth:users:logout`, `auth:devices:revoke`. **No impersonation** — the most dangerous administrative capability there is, and it gets its own design and security review rather than riding in on a batch.
- **`@pithy-sh/audit`** — page the trail by actor, action, resource, outcome, severity, origin, tenant, and time; read one event in full. `tenant` is the one filter over a dimension the recorder does not stamp — it is whose action it was, and in a multi-tenant app it is the only column that separates one customer's history from another's, since project, environment, and Worker are constant across every row. Scopes: `audit:events:read`, `audit:events:read_detail`. The detail route is separate because IP, user-agent, and metadata one event at a time is a forensic read, and the same fields across a hundred rows is bulk harvesting. Read-only by construction: a credential that could erase an audit row could erase the evidence of its own use.
- **`@pithy-sh/email`** — jobs by status and in detail, retry a failed one, read and amend the suppression list. Scopes: `email:jobs:read`, `email:jobs:retry`, `email:suppressions:read`, `email:suppressions:write`, `email:suppressions:delete`. Silent email failure costs a signup.
- **`@pithy-sh/ledger`** — balances and transaction history, **read-only**. Scopes: `ledger:accounts:read`, `ledger:transactions:read`. No adjustments: writing to a balance ledger from an admin console needs the same care as any other movement.
- **`@pithy-sh/secrets`** — every declared secret's status, and one secret's rotation history. Scope: `secrets:status:read`. **Metadata only, and structurally so**: the response types have no field for a value, a ciphertext, an IV, a metadata snapshot or a rotation's error message, so widening one is a compile error rather than a review miss. A failed rotation reports as a status, never as a message — an error message is free text written at a failure site, which is where a value gets pasted by accident. Its own scope because the list of which credentials a project holds, which are stale, and which no automation will ever rotate is a map of where to push; an adopter must be able to grant a users pane without also granting that. There is no route that reads a value and no scope that could grant one: the reason a secret is encrypted under a key only the customer's Worker holds is that no third party has a path to the plaintext, and a route here would be that path in every deployment whether or not anybody granted it.

That list is what a customer consents to at connect, so it is stated here rather than left to be read off a manifest.

A capability also **declares** those routes via `adminRoutes`, so a management client learns how to call them from the Worker itself rather than from a route table it ships with (§14).

```ts
app.post(
  `${base}/entitlements/grant`,
  requireControlPlane(PAYMENTS_ENTITLEMENT_GRANT_SCOPE),
  zValidator("json", EntitlementGrantRequest, validationHook),
  (c) => grantEntitlement(c, c.req.valid("json")),
);
```

Note that those are **two** scopes — `payments:entitlements:grant` and `payments:entitlements:revoke` — not one admin flag. Scopes name operations, not credential holders, and these two operations have different blast radii: grant mints paid product out of nothing, revoke takes paid access from a live customer. A refund tool needs revoke and never grant. One flag would make each of them the other.

**And a capability that can write a resource must be able to read it.** Payments shipped those two writes and no read, which is a subtler failure than a missing feature: a pane over a resource nothing declares computes `absent` and vanishes, so the surface reports *nothing is wrong*. A refusal an adopter can act on requires a route to refuse. `packages/payments/src/admin/coverage.ts` states the invariant for that capability and `coverage.test.ts` enforces it — every table decides, where it is defined, whether a management client may read it, and every resource the control-plane surface can write it can also read.

**Never put `requireAuth()` on a control-plane route.** A management client is not a user of the adopter's app, so `c.var.auth` is deliberately null on these calls — an auth gate would deny every legitimate management call, permanently, with no credential able to fix it.

Guards before validators, always. A validator ahead of the guard turns a 401 into a 400 and tells an unauthenticated caller which requests were well-formed — on this seam that is a live oracle.

Admin routes contributed by a capability inherit that capability's license. The seam itself is MIT, in `@pithy-sh/core`, and is never gated by tier: this is the code that runs in **your** Worker, and restricting it would make "you can build your own client against your own Worker" untrue.

---

## 14. Discovery over configuration

A management client composes its navigation **and its calls** from `GET /control-plane/manifest`, rather than from settings someone maintains or a route table it ships with.

```json
{
  "environment": "prod",
  "connectionId": "b6a1f0c2-3d4e-4f50-8a9b-0c1d2e3f4a5b",
  "version": "8f2a1c94-...",
  "capabilities": [
    { "name": "controlplane", "version": "1.4.0", "adminRoutes": [
      { "method": "GET",  "path": "/control-plane/ping", "scope": null,
        "summary": "Prove connectivity and which key answered. Always available to a verified caller." }
    ]},
    { "name": "payments", "version": "1.4.0", "adminRoutes": [
      { "method": "POST", "path": "/billing/entitlements/grant", "scope": "payments:entitlements:grant",
        "summary": "Comp an entitlement, or repair a purchase that verified but never projected." },
      { "method": "POST", "path": "/billing/entitlements/revoke", "scope": "payments:entitlements:revoke",
        "summary": "Take an entitlement back, effective immediately." }
    ]},
    { "name": "leaderboard", "version": "1.2.1", "adminRoutes": [] },
    { "name": "app", "version": null, "adminRoutes": [] }
  ],
  "grantedScopes": ["manifest:read", "payments:entitlements:grant"]
}
```

**Knowing a capability is installed is not enough to call it.** Note the paths above: this adopter mounted payments at `/billing`. `basePath` is configurable on every capability, so a client that hardcoded `/payments` would 404 against exactly the adopters who customised anything. Each capability builds its declaration from its *resolved* config, so the manifest names where things actually are.

Each route also names the scope it needs. Against `grantedScopes`, that is what lets a client grey out `revoke` — not granted here — instead of offering a button that answers 403.

A capability with no management surface reports an empty list rather than being absent. "Composed, but nothing to administer" and "not installed" are different facts, and a client that cannot tell them apart renders the wrong thing for both.

So a Worker that does not compose payments has no purchases pane, and that is a fact the client discovers. Run `pithy add support` and a **working** support pane appears on the next visit — panes *and* the calls behind them — with nothing for either side to configure.

**The declaration is checked, not trusted.** A hand-maintained list beside generated behaviour is a list that rots, and a manifest that has drifted is worse than none: a client believes it, calls a path nothing serves, and the adopter sees a management client broken for reasons inside somebody else's package. So `missingAdminRoutes` compares every declared route against the router that actually mounted, and each capability asserts it in its own `routeContract.test.ts`.

There is deliberately **no manifest schema version**. With the routes described here, a client dispatches on what this Worker declares right now; a schema version would be a second source of truth to keep in sync with the first.

What the manifest *does* carry is **identity**, which is a different thing, and it carries two because neither answers the other's question.

`version` at the top is Cloudflare's opaque per-deploy id, from the `CF_VERSION_METADATA` binding. It says *exactly which build* is running — the answer for forensics, for reproducing a report, and for pinning the code an audited action ran against. It carries no version semantics, so it says nothing about features. It is `null` on a Worker that does not declare the binding, which reads as "cannot say" rather than as a value to trust.

`capabilities[].version` is the npm version of each composed package. It says *which features*, which is what answers "should this customer upgrade", "which customers are exposed to what we just fixed", and "does this project predate the capability a pane needs". It is `null` for the adopter's own `app` capability, which has a name and no package.

**Per capability, never aggregated.** The package name is the join key against a release feed, and a project composes some capabilities and not others — so only the intersection of what it composes and what actually changed is worth reporting, and that intersection is computable only if both sides stay per-module. Aggregate them and a client tells someone they are "five versions behind" counting packages they never installed.

The same build id is also on **every control-plane response**, as a `pithy-worker-version` header — allowed and denied alike, and on every capability's admin routes rather than only the seam's. A client that captured the version at connect holds a stale value the moment the adopter deploys, which is precisely when it matters; per response, each recorded action pins the build it actually hit, and a client can notice the version changing mid-session — the moment a rendered pane has quietly gone out of date.

Beside it, **`pithy-worker-version-created`**: the timestamp the platform reports for that build, ISO-8601, exactly as Cloudflare issued it. Two headers rather than one richer value, because a client compares them separately and because a client already deployed compares the whole of the first — fold a second field into it and a kit upgrade reads as a version change that never happened.

**Read the pair with `workerBuildChanged`, from `@pithy-sh/core/src/controlPlane/wire`.** Compare field by field, only where both sides carried a value; anything that differs is a change. Four states, and the third is the one a rule keyed on the id alone cannot reach:

| What it sees | What it means |
| --- | --- |
| Nothing differs | The same build is still answering. Say nothing. |
| `version` differs | A different build is live. What is rendered came from one that no longer serves. |
| `version` same, `created` differs | **The same build was deployed again.** Same consequence. |
| Either side silent on a field | That field says nothing. |

**Either header absent, on either side of the comparison, is never a change.** A Worker that does not declare `version_metadata` sends neither; a call that failed before its headers were read has none; a client that has not looked yet holds nothing. All mean "cannot say", and a client that treats a missing value as a new one invalidates on a deploy nobody made.

### Versions and deployments are two objects

`created` is the moment the running **version was uploaded**, and it never moves again. That follows from how Cloudflare models a Worker, and the model is worth stating because it answers more than one question:

- A **version** is an immutable upload of code and config. It has an id, a created timestamp and a tag, fixed at upload.
- A **deployment** points at one or more versions with traffic percentages. It is its own object, with its own id and its own time.

**`CF_VERSION_METADATA` reports the version, and the runtime hands a Worker no binding for the deployment.** So a rollback — which creates a *new deployment* aimed at an *existing version* — moves neither header. The binding is not stale and not ambiguous; the object that changed is one a Worker cannot see. The same answer covers a traffic split, a gradual rollout, and "which deployment is serving": none of it is observable from inside.

Measured on a real account, 2026-08-10, which is what turned that from a reading of the docs into a fact. Version `A` uploaded at `22:28:56.762349Z`, `B` four seconds later, `wrangler rollback` to `A` at ~`22:29:20`; a reading at `22:31:37` returned `A`'s id and `A`'s original timestamp, unmoved, while wrangler's own output named the new deployment's version list. Two details from the same run that a client will meet:

- **Every `wrangler deploy` mints a new version**, even for a one-character change. An ordinary redeploy therefore always moves the id and is never invisible.
- **Propagation lags.** Twenty seconds after wrangler reported the rollback at 100%, the URL still answered from the older version. A client watching closely sees the pair flip and settle — the platform converging, not two deploys.

**So the third row above is not reachable on today's platform, and it stays anyway.** A total comparison is the correct shape: a rule that enumerates which fields are allowed to move is wrong the day the platform moves a different one, and it is wrong silently, as "nothing changed". It costs one branch. Do not read it as rollback detection.

**Nothing inside a Worker can observe a deployment.** That is a boundary of what the runtime exposes, not a gap in this seam, and no header could close it — the only in-Worker signal anyone could synthesise is isolate boot time, which changes on every cold start and would report a redeploy dozens of times a day. A client that needs to know a deployment changed reads Cloudflare's deployments API, in the customer's own account.

The `tag` the binding also carries stays off the wire. It is adopter-authored free text, this header crosses a trust boundary, and neither question a client asks is answered by it.

### Declaring one

```ts
defineCapability({
  name: "support",
  adminRoutes: supportAdminRoutes(resolved.basePath),
  routes: registerSupportRoutes({ config: resolved }),
});
```

Build the paths from the capability's resolved `basePath`, never from its default — otherwise the declaration describes a Worker other than this one.

---

## 15. CLI

Every command is non-interactive and `--json` capable, like the rest of the CLI.

```
pithy dashboard connect --env production
pithy dashboard connect --env production --update --worker-url https://api.example.com
pithy dashboard connect --env production --public-key ./client.jwk.json --scope manifest:read
pithy dashboard rotate --env production
pithy dashboard revoke-key --env production --key-id cpk_2026_07
pithy dashboard disconnect --env production
pithy dashboard status --env production
```

Connection is **project-wide, per environment — never per Worker.** Workers share a resource by declaring the same binding name, so one user record lives in one D1 that several Workers touch. A per-Worker credential would produce views where a user is visible in one pane and absent from another.

### Which of these go through the seam

Registering a key is your Worker's own decision to make. `POST /control-plane/keys` is where that decision is made: it checks the connection's `keys:rotate` grant, it is signed with the key being replaced, and it writes the registration into your audit trail. A CLI writing that column directly is not a second implementation of the rule — both paths share the same lifecycle code — but a second **authority** over it, which means the rule holds for whoever remembers to route through it.

So one rule, stated as a property rather than a list:

> **The CLI adds a key to your connection only when no live key exists to sign for one through the seam.**

| Command | Where the write happens | Recorded as | Why |
|---|---|---|---|
| `connect` (first, or starting over) | The CLI, into your D1 | `controlplane/connection_registered` | No key exists, so nothing can sign a registration — and your Worker may not be deployed at all. **The one exemption.** |
| `connect --public-key` (first) | The CLI, into your D1 | `controlplane/connection_registered` | The same case with no dashboard in it. |
| `connect --public-key` (a successor) | Refused | — | A live key exists, so the seam can serve it. The CLI cannot: the private half is yours. It prints the call to make. |
| `connect --public-key` (recovery) | The CLI, into your D1 | `controlplane/connection_updated` | The connection existed and had nothing live, so nothing could sign. Its keys changed; the connection was not created. |
| `connect --update` | The CLI, into your D1 | `controlplane/connection_updated` | Adds no key. It re-points an address your Worker never reads, and changes a grant only you may change — a route letting a client widen its own grant is the thing scopes exist to prevent. The client is told the new address first, and the row is written only if that succeeded. |
| `rotate` | **The seam**, `POST /control-plane/keys` | `controlplane/key_registered` | A live key exists to sign with, so the registration is your Worker's to accept, audit, and scope-check. |
| expiry | **The seam**, `POST /control-plane/keys/:keyId/expire` | `controlplane/key_expired` | Never the CLI's at all, and never was: it belongs to the client that proved the successor from its own infrastructure (§6). |
| `revoke-key` | The CLI, into your D1 | `controlplane/connection_updated` | Revocation *removes* trust, and revocation that needed our cooperation would not be revocation (§7). |
| `disconnect` | The CLI, into your D1 | `controlplane/connection_removed` | The same, at connection granularity: every credential for this environment stops working at once. |

Exactly one operation is exempt, and it is exempt because the seam cannot serve it rather than because it is convenient: a connection with nothing live has nothing to sign a registration with. Requiring a running Worker to register the key that lets anyone talk to it is a chicken-and-egg with no exit. That same sentence covers recovery — a connection whose every key you revoked is back to having nothing that can sign, and `connect` is the way out.

### A CLI-side write records itself

**Every row in that table has a code beside it, and the CLI-side ones are written by the CLI.** A write that never reaches your Worker cannot be recorded by a route — there is no request to record — so `pithy dashboard` writes the event itself, into the same D1 as the connection row, through `connectionRegistry`. That is the only door onto the table, which is what makes "every write is recorded" a property rather than a habit.

It matters most for the ones that never touch your Worker at all. A management client gaining reach into an environment, that reach moving, and every credential for it dying at once are the three widest-blast-radius changes on your side, and until they were emitted you could read a *key* rotation in your own trail but not the connection being created or destroyed. The larger event was the invisible one.

Three things follow, and each is visible in the row:

- **The actor is not `control-plane`.** That kind means a management client called in and proved it. These came from a person at a terminal, named from your Cloudflare token where the command had one and recorded as `system` with a note where it did not. `worker` and `version` are null, because no Worker recorded it and there is no build id to name.
- **Nothing is recorded that did not happen.** The row is written first and the event follows. A refused write records nothing.
- **The trail never fails the command.** If you do not compose `audit`, the events go nowhere and `connect` is unchanged. If your trail is unreachable, the write still lands and the drop is logged. A `disconnect` that failed because the audit database was down would leave a credential live on the strength of an audit problem, which is exactly backwards.

The metadata names ids and addresses — the connection, the keys by id, the scopes, what a re-point moved from and to. Never key material.

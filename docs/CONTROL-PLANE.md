# The control-plane seam

_The reader's version of this page is [pithy.sh/docs/capabilities/control-plane](https://pithy.sh/docs/capabilities/control-plane). This copy stays in the kit because `packages/cli/src/dashboard/contract.ts` sends an adopter to it by name._

How a management client reaches into your Worker, without Pithy operating a data plane.

**An AI agent reaching a Pithy application is a case of its own**, and [`AGENT-ACCESS.md`](AGENT-ACCESS.md) is the model for it: which kinds of agent reach this seam and which do not, how a connection records who authorized it, and why an agent authorized as a *user of the app* does not come through here at all.

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

**It is present and denying by default.** A Worker that composes the capability and has never been connected answers every control-plane route with `controlplane/not_connected`. There is no flag to leave off, no backdoor, and nothing enabled silently. Connecting a client is a deliberate act, and until you perform it the seam's only behavior is refusal.

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

### It answers a preflight, so a browser can actually reach it

A control-plane token rides the `pithy-control-plane` header, which is not one a browser will send cross-origin without asking first. So every admin route answers `OPTIONS` — the seam's own, and every capability's, derived from the same route table the manifest is built from.

Your Worker answers for `issuer` out of the box. Nothing to configure: the hosted dashboard reaches a stock Worker on the day you connect it.

Add your own console with `allowedOrigins`, which is **additive** — an entry there never removes `issuer`, so putting your own UI on top cannot lock out the dashboard that was already working:

```ts
controlplane({ allowedOrigins: ["https://ops.example.com"] })
```

Each entry is a scheme and a host: `https://ops.example.com`, `http://localhost:5173`, `http://[::1]:5173`. A trailing slash or an explicit `:443` is the same origin spelled differently and is accepted. A path, a query, or a credential is refused when the config is parsed, at deploy — those look like they scope the entry, and they do not.

In local dev you configure nothing. When `ENVIRONMENT` is `dev`, your Worker answers for any address on your own machine — `localhost`, `127.0.0.1`, `[::1]`, on any port. The dev port allocator picks a console's port per feature, so there is no value you could write into `allowedOrigins` that would stay true across checkouts, and this is the rule that does not need one.

It is dev and loopback or it is nothing: in staging and production the allow-list is the config above and nothing else. And it grants no access. Every admin route still demands a verified control-plane token, so what this permits a local page to do is read a reply it could already provoke.

A browser caches a preflight for `corsMaxAgeSeconds`, ten minutes by default. Set it to `0` while you are working an allow-list out: a browser that has cached a refusal keeps refusing for the whole window after you fix the config, which reads exactly like a change that did not take.

Two properties worth knowing, because both are deliberate. The list is read from config and **never** from a connection row: a preflight is the one request here that is answered before any credential is read, so consulting the database would turn it into a way for anyone to ask which origins you have registered. And an origin that is not on the list gets the same `204` and the same empty body as one that is, minus the header that permits the read — the browser blocks it, and the answer says nothing about what the list contains. Your browser console will name it as a CORS failure; your Worker will not tell you more than that, on purpose.

Cookies are never in play. The token is a header, so `Access-Control-Allow-Credentials` is never sent.

---

## 5. Registration

One keypair per connection — per customer, per project, per environment. A leak exposes one connection rather than a fleet, and rotation and revocation are naturally scoped.

**We generate the keypair. The private key is born in our infrastructure and never leaves it.** The alternative — your CLI generating one and sending it to us — puts key material on the wire for no benefit.

```
pithy dashboard connect --env prod
```

1. The CLI starts a **device-code flow** against the management client's origin, prints a short user code, and offers `o` to open your browser — on macOS and Linux; Windows prints the URL and opens nothing, for the reason `docs/commands/dashboard.md` gives. Same shape as `wrangler login`. *This* leg is genuine user delegation, which is why a browser authorization flow belongs here and not on the machine-to-machine leg.
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

If your client runs in a browser, put its origin in `allowedOrigins` — or in `issuer`, if it is the only one you use. Registering a connection with `--origin` writes the issuer into that connection's row and does not widen what your Worker answers a preflight for; those are two different questions, and only the config answers the second.

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

**Rotation is a scope.** A client that was never granted `keys:rotate` cannot rotate, whatever it intends — better than a toggle somebody has to be trusted to honor.

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

`GET /control-plane/ping` requires a verified caller and no scope at all. It is not modeled as a scope, because granting or withholding it would change nothing: ping must work for a connection granted nothing, since it is how a new key is proven before the old one is expired.

---

## 9. What a call must satisfy

Every step default-denies, and every failure raises the same `controlplane/invalid_credential`. One code for every step is deliberate — distinguishing "unknown key" from "bad signature" from "replayed token" would tell an attacker exactly how far they got. The failing step goes in the error's `detail`, which the HTTP codec strips before anything reaches the wire and which your logs keep.

1. Read `kid` from the token header and `aud` from its claims. **Untrusted at this point** — a parsed token is a well-formed shape, never an authentic one.
2. Load the connection named by `aud`. No connection registered for this environment: `controlplane/not_connected`.
3. The key named by `kid` must exist on that connection, not be revoked, and be inside its validity window.
4. Verify the EdDSA signature with that key, via WebCrypto. `alg` is pinned to the literal `EdDSA` at parse — the algorithm-confusion defense.
5. `aud` must equal the loaded connection's id, and its `environment` must equal this Worker's. **A staging credential cannot reach production.**
6. `iss` must equal the issuer that connection was registered against.
7. `exp` and `iat` are checked with a bounded clock skew, and a token claiming a lifetime longer than the configured maximum is rejected outright.
8. The SHA-256 digest of the raw body is recomputed and compared. A signature over claims that do not bind the body would let an attacker swap the payload.
9. The scope check of §8. A refusal here is `controlplane/insufficient_scope`, and it spends the `jti` too, so a token refused for scope cannot be presented again at a route it does cover. Only its first presentation names the caller on the audit row (§11).
10. `jti` is claimed in the replay set, as a single-use insert. Already spent: denied. Last, because it is the only step that writes anything a granted call depends on.
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

**And which kind of client did it.** `control-plane` names an agent, the dashboard and a script alike, so the guard stamps the connection's own `actorKind` — recorded when the connection was registered, never read from the token — onto every `control-plane` event the call writes, its own and every handler's, and onto an attributed scope refusal (below). `@pithy-sh/audit` stores it in `actor_kind` and filters on it. A connection registered before kinds were recorded writes rows with none ([`AGENT-ACCESS.md` §7](AGENT-ACCESS.md)).

Denials are audited too. `denied` is a first-class outcome, and this is the surface where an unaudited blocked attempt is least acceptable. An audit write that fails never turns a correct denial into a 500 — the denial has already been decided by the time it is recorded. A handler can need a grant beyond the one its route is gated on, and refuse the call itself with `controlplane/insufficient_scope` once the gate has let it in. The guard records that refusal as `controlplane/call_denied` too, with `refusedBy: "handler"`, so a credential probing for a grant it lacks is not hidden behind the gate's `call_allowed`. That row names the credential's scope and key id exactly as the gate's row does, so a read of one key's reach (§13, `@pithy-sh/audit`) finds its refusals too, even on a request with no request id to join by.

**A denial names exactly what it proved.** A call that failed verification — no connection, a bad signature, an unknown or expired key — is written with no actor and no connection, because its `sub` is unproven and recording it would let a forged token name someone. A call whose credential verified and whose scope was not granted is a known connection asking for something it lacks, which is what scope probing looks like, so its `controlplane/call_denied` row carries the subject as `actorId`, the connection as `resourceType: "controlplane_connection"` and `resourceId`, the connection's `actorKind` as the allowed row carries it, and the key in `metadata.keyId`, beside `reason`, `required`, `method` and `path`. So a trail filtered on `actorKind` holds a client's refusals beside its allowed calls. An unattributed refusal carries no actor kind. **Only the first presentation of a token is attributed.** A signature proves who minted a token, not who presented it, and a token binds no path, so a captured one could be replayed at every route it does not cover. The refusal therefore spends its `jti`, and a token already spent — by an allowed call or by an earlier refusal — is written with no actor and no connection. The refusal the caller receives is the same either way.

---

## 12. The seam's own routes

| Route | Requires | Purpose |
|---|---|---|
| `GET /control-plane/ping` | any verified caller | Connectivity and key proof. Used at connect, and to prove a new key before the old one is expired |
| `GET /control-plane/manifest` | `manifest:read` | Which capabilities this Worker composes, **and how to call each one's admin routes** — path, method, and required scope. Discovery over configuration (§14) |
| `GET /control-plane/keys` | `keys:rotate` | The registration state — which keys are live, their ages, and their validity windows |
| `POST /control-plane/keys` | `keys:rotate` | Register a new public key. **Authenticated with the key it replaces** |
| `POST /control-plane/keys/:keyId/expire` | `keys:rotate` | Expire a superseded key, naming the proven successor |
| `GET /control-plane/migrations` | `migrations:read` | Where each database this Worker binds stands: applied, pending, undeclared, and the run that last moved it |
| `GET /control-plane/privacy` | `privacy:read` | Every stored schema holding a privacy-marked field: each field's path, its class, and where it lives |
| `POST /control-plane/presence/tickets` | the room kind's own scope | A single-use ticket into one presence room: who else has a record open, live (below) |

### Migration state

`GET /control-plane/migrations` answers what is applied where, and whether a deploy left something behind. It asks the Worker because the Worker **is** the deployed build. `pithy doctor` reads the project on disk, which is what you have and not necessarily what is deployed.

**One entry per database the Worker binds**, sorted by name. A readable one carries four things:

- `applied` — every applied migration, in the order the ledger applied them.
- `pending` — declared by this build and not applied, in the order they would run.
- `undeclared` — applied and not declared by this Worker. Kysely reads one as a corrupted chain and applies nothing, so this is not drift a later run works around.
- `lastGroup` — the newest group with anything still applied: its value, when it applied, what it applied there, and its `position`. `top` means the group is the tip of this database's ledger, with nothing applied over it. It is not a promise that `pithy migrate --rollback --group <value>` will run: the CLI also refuses while the ledger holds an undeclared migration, and keeps back or refuses a database another environment binds. `buried` names what is in the way: the groups `above` it and the `ungrouped` migrations over it.

**Every migration names its namespace.** A namespace is a capability's name, which the manifest reports in `capabilities[]`. Compare the two and your own migrations are told from a composed capability's, with no convention and no list kept anywhere. `namespace` is `null` only for an undeclared migration whose name no Pithy registry could have composed.

**`undeclared` is relative to this Worker.** Two Workers bound to one D1 share its ledger, and the CLI composes across both. A Worker composes only its own capabilities, so from inside one, every migration the other shipped to the shared database is listed as undeclared. On a database no other Worker binds, an undeclared migration is the real thing.

**A database that cannot be read says so, and costs only itself.** It comes back `unreadable` with its name and binding and no lists at all, never empty ones, because `pending: []` reads as up to date. The other databases still answer, and the route still answers 200. What D1 said goes to the Worker's log, not the response.

**It is read-only.** Nothing over the seam runs, reverses or resets a migration. The Worker composes the provider with `collectMigrationSets` from `@pithy-sh/core/src/migrations/capabilitySets`, the function `pithy migrate` composes with, so the route and `pithy doctor` compose the same way. They do not always compose the same inputs. On a D1 that two Workers share, `pithy doctor` merges every co-bound Worker's migrations and the route sees only its own Worker's, so their `pending` and `undeclared` can differ. On a database one Worker binds alone, they agree.

The seam's own manifest entry carries two counts behind the same scope, so a client sees *this environment is behind* on the read it already makes (§14). `pendingMigrations` declares `nominal: { atMost: 0 }`. `undeclaredMigrations` declares none, for the reason above: graded, it would report a corrupted chain on a shared database that is fine. Both are totals across every bound database, and one database that cannot be read makes both unavailable rather than a partial total.

`migrations:read` is a read — every route requiring it is a `GET` — so `pithy dashboard connect` grants it by default. A connection made before it existed does not hold it, and an `--update` without `--scope` leaves the grant as it is. [`pithy dashboard connect --update --scope migrations:read`](commands/dashboard.md), with every scope the connection already holds passed beside it, adds it. So does `--update --scope all`.

### Privacy

`GET /control-plane/privacy` answers which of this Worker's stored fields are private, and which class each is (#132). Every D1 table and KV store the composed capabilities declare is walked, and each schema holding a marked field is listed: its capability, `storage` (`d1` or `kv`), the database or namespace it lives in, its name, and `fields[]` — each `{ path, class }`. A KV field's path leads with the part of the entry it is in: `key.email`, `value.token`, `metadata.ip`, `value[].email` for an array value.

**It is derived from the running code, not stamped.** The schemas are already in the deployed bundle — they are the table definitions — and the walk runs on the first read and is cached for the isolate. Unmark a `phi()` field and it leaves this report on the next deploy, with no build step and no person in between. A Worker whose control plane is never called never walks. The whole kit, twenty capabilities and sixty schemas, walks in 3 to 8 ms, once.

**Its own scope**, because field names are the kind of thing you may reasonably withhold from a client that has no business seeing them. `privacy:read` is a read, so `pithy dashboard connect` preselects it, and it is separately grantable: a connection granted `manifest:read` alone sees the posture headline below and no field names.

The manifest carries the headline as `privacy`: declared classes, observed classes, a count per class, both deltas, the console gate, and which sources were walked. What `declared` means, why it is an attestation, and how stale one can be is [`docs/PRIVACY.md`](PRIVACY.md).

**Encryption is a second axis on the same records** (#390). Each field record carries `encryptedAtRest`, `true` or `false`, and leaves it out where the core cannot say — so a Worker on an older core reports no encryption data rather than reporting `false`. Each schema lists `encrypted[]`, every encrypted field whether or not it carries a class, `unrotatable` where it rests outside D1. The posture, on both routes, carries `retirement: { blocked, reasons, liveVersions }`, the field key's retirement guard read directly; it is absent on an older core. What each means is [Encrypted fields](PRIVACY.md#encrypted-fields).

### Presence rooms

A presence room answers one question: who else has this record open, and what are they doing (#815). Two people answering one support thread reply twice when neither can see the other. A room is one record of one **room kind**, and it lives in one hibernating Durable Object, `PresenceRoom`, in your own Worker.

**A capability declares its room kinds**, on the `Capability` contract's `presence` field, beside its admin routes: a name (`support.thread`), the scope that reads the record (`support:threads:read`), which must be one the capability's own admin routes already require and only `GET` routes require, so `pithy dashboard connect` offers it and joining never needs a write grant, and the activities a participant may announce (`viewing`, `replying`). The name starts with the capability's own. The manifest lists every kind under the capability that declares it, as `presenceRooms[]`: the kind, its scope, its activities, its participant cap, and the two paths below, built from that capability's own `basePath`. A Worker that predates presence rooms sends no `presenceRooms` at all, which is not the same as an empty list.

**Presence adds no scope.** Anyone who may read a record may see who else has it open, so a room kind names the scope that already reads it.

**Joining takes a ticket**, because a browser's `WebSocket` sets no headers: it can carry neither the control-plane token nor, cross-origin, a session cookie. There are two doors, and both answer the same `PresenceTicket`:

- **Control plane:** `POST /control-plane/presence/tickets`, signed like any control-plane call, **with the room kind's own scope**. The body names the room and the participant: an opaque `ref` and a display `name`, both the client's own. The signed body is what makes them the client's claims. Which scope a call needs is named in its body, so the gate reads the kind from the body and verifies against that kind's scope, exactly as it verifies any route's own. A token minted for any other scope is refused with `controlplane/insufficient_scope` and audited like any denial: one denial row naming the kind's scope, and no allowed row. An undeclared kind is a 404.
- **Session:** `POST {base}/presence/tickets`, for a signed-in user of the app, behind the declaring capability's own permission for reading that record. The participant is that user. A kind that declares no session gate admits management clients only.

A ticket is single use, expires in 60 seconds, and is bound to one room and one participant. It is signed with `presence-ticket-key`, a secret generated per environment like the kit's other generated values: the declaring capability lists it in its `@pithy-sh/secrets` registry as `PRESENCE_TICKET_KEY_ENTRY` and in its manifest's `devSecrets`, `pithy add` mints the local one, and `pithy secrets provision` the deployed ones (`pithy provision --feature` a feature's). Every capability that declares rooms in one Worker signs with that one key.

**Then the socket:** `GET {base}/presence/rooms/:kind/:recordId`, upgraded, offering `pithy.presence.v1` and `pithy.ticket.<ticket>` in `Sec-WebSocket-Protocol`. The Worker answers with `pithy.presence.v1`. A missing, forged, expired, spent or misdirected ticket is one refusal, `core/presence_ticket_invalid` (401), so a caller holding someone else's ticket learns only that it does not work. A full room is `core/presence_room_full` (409).

**The room holds nothing but who is here.** Each participant — `ref`, `name`, `origin` (`control-plane` or `session`), `activity` and `joinedAt` — lives in its socket's attachment and is read back from `getWebSockets()`, so a room that hibernates wakes knowing who is in it. The first frame is `init`, everyone in the room. Then `joined`, `left` and `activity` reach every other socket as they happen, and a dropped socket leaves. Nothing is written to D1, KV or Durable Object storage, and when the last socket closes the room is gone. A management client and a signed-in user in one room see each other, each with its origin.

**Bounded.** A room refuses past its kind's participant cap (25 by default, at most 100), a client frame past 1,024 bytes, and an activity its kind does not declare. A participant sends one JSON frame, `set_activity`, and the plain-text `ping`. The frames are in the AsyncAPI contract, and how they may change is [`docs/SOCKETS.md`](SOCKETS.md).

**Wired by the CLI.** The first composed capability that declares a room kind makes `pithy add` and `pithy upgrade` write the `PRESENCE_ROOMS` binding, the `PresenceRoom` class migration tag and the entry export, through the Durable Object path every capability uses. The CLI reads that from the manifest, not the code: a kit capability's `pithy.manifest.json` lists the binding in `requiredBindings` exactly as `PRESENCE_ROOMS_BINDING_SPEC` gives it (`durable_object`, `PRESENCE_ROOMS`, class `PresenceRoom` from `@pithy-sh/core/src/presence/durableObject`), beside `presence-ticket-key` in `devSecrets`, and one that leaves it out gets no binding, no migration and no export from `pithy add`. Only the adopter's own `app` capability, which has no manifest, is wired by `pithy upgrade` from its composition. `pithy remove` takes them out with the last capability that declares rooms, and `pithy upgrade` takes them out of a Worker where none does any more. It uses no Cloudflare API token.

---

## 13. Capabilities contribute their own admin routes

The same federation as migrations, error codes, and audit actions. A capability declares admin routes behind `requireControlPlane(scope)` and they compose into the tree with nothing to wire.

`@pithy-sh/payments` was the first: `POST /payments/entitlements/grant` and `/revoke`, the only way an entitlement appears without money moving. More followed, and between them they are what a dashboard's first panes read:

- **`@pithy-sh/payments`** — read what the project sells; page the purchase log, the purchases that renew, and what subjects are entitled to; comp an entitlement or take one back; mint and list discount codes; read the reconciliation log and start a pass; page every notification a store sent. **A subject is the pair `(subjectType, subjectId)`** — a user, or an organization, depending on what the project bills — so the entitlement reads filter on both halves and the per-subject read is `GET /payments/admin/entitlements/:subjectType/:subjectId`. Both halves, always: nothing keeps an organization id from equaling some user's id, so a pane that keyed on the id alone would show one holder's plan under another's name. Scopes: `payments:catalog:read`, `payments:purchases:read`, `payments:subscriptions:read`, `payments:entitlements:read`, `payments:usage:read`, `payments:webhooks:read`, `payments:entitlements:grant`, `payments:entitlements:revoke`, `payments:overrides:set`, `payments:overrides:clear`, `payments:overrides:unrestricted`, `payments:discounts:read`, `payments:discounts:create`, `payments:reconcile:read`, `payments:reconcile:run`. **`payments:catalog:read` is its own grant because reading what a project sells is not reading what anybody bought** — it names no account and no transaction, and answers identically against a database with no rows in it, so a tool that needs a list of comp-able entitlements can hold that and nothing else. It is also what a grant is checked against: `entitlements/grant` refuses a key the `entitlements` map does not declare, with `payments/entitlement_not_in_catalog`, naming the key — a declared key no product sells is comp-only. The same read projects what each key buys, its quotas, its features and the `overrideMax` ceilings, plus the free floor, so an override editor is built from it alone. Its `manualEntitlements` field is the comp-only keys — declared, and sold by no product. It is not the config key of that name, which is gone; the field keeps its first name so a client reads an older Worker and a newer one the same way. The read makes a good comp control possible; the refusal makes a bad one impossible (#300). The reads landed late and the cost is worth stating: for a while this capability shipped the two writes with no read beside them, so a console could comp an entitlement and never list one, and three panes in the first adopter computed **absent** and dropped out of the rail. Not blocked, not refused — absent, which no grant and no seed can repair, because there was no route to grant a scope to. The reads never project a stored provider payload; the queries behind them do not select it. **`GET /payments/admin/webhook-events` is the read that explains the others** (#830): every notification a store sent, newest received first, filtered by `rail`, `state` and a `since`/`until` window, each as `projected`, `pending` with its `attempts`, or `abandoned` — so a notification that arrived and never projected reads as exactly that, never as missing. A projected event names the purchase and subscription rows it changed, as `targets`; one projected before the Worker recorded them reads `targets: null`, which is *unrecorded*, not *changed nothing*. The store's own name for the event crosses as `eventType`, read out of the payload by the database; the payload itself does not, and the stored error crosses as its code alone — never the store's sentence.
- **`@pithy-sh/auth`** — find and read users with their sessions and devices; revoke a session, sign a user out everywhere, revoke a device; suspend a user and reinstate them; delete a user, restore one, and export everything held about one; read the ledger of sign-in links and codes sent. Scopes: `auth:users:read`, `auth:devices:read`, `auth:sessions:revoke`, `auth:users:logout`, `auth:devices:revoke`, `auth:users:suspend`, `auth:users:delete`, `auth:users:export`, `auth:verifications:read`. **No impersonation** — the most dangerous administrative capability there is, and it gets its own design and security review rather than riding in on a batch. **The account lifecycle** has three scopes, each its own blast radius: `auth:users:suspend` to end an account's access and give it back, `auth:users:delete` to delete one, restore it inside its window and start its purge, and `auth:users:export` to hand over everything the kit holds about one person. Reading a user confers none of them. Both user reads report where each account stands — `state`, `suspendedUntil`, `purgeAfter` — read the way enforcement reads it, so a pane knows whether to offer suspend or reinstate without trying either. `POST /auth/admin/users/:userId/suspend` and `POST /auth/admin/users/:userId/reinstate` take `auth:users:suspend`, each with a required reason: a suspension revokes every session the user holds, and a reinstatement restores none. `DELETE /auth/admin/users/:userId` and `POST …/restore` take `auth:users:delete`, and `GET …/export` takes `auth:users:export`, each with a required reason. A deletion is soft unless the caller names `mode: "hard"`: soft opens the purge window, `retention.purgeAfterDays`, inside which a restore brings the account back, and hard purges now. The export is one document with every composed capability's part, audited as a disclosure. The state sits on `pithy_auth_users`, every transition is recorded in `pithy_auth_user_lifecycle` with its actor and reason, and a refused account is refused at every request, sign-in and token refresh. Auth's own routes, sign-in and refresh answer `auth/account_suspended` or `auth/account_deleted` (403); another capability's `requireAuth()` answers 401, and the client's next refresh gets the code. **The purge contribution** is how a purge reaches rows other capabilities hold: each declares, on the `Capability` contract, how one subject's rows are erased and exported, and the purge Workflow runs each as its own step. The adopter's own Worker hosts it, and a daily cron starts it for every account past its window. [`packages/auth/docs/account-lifecycle.md`](../packages/auth/docs/account-lifecycle.md) has the states, the enforcement, the record and the contract. **The verification ledger** answers whether sign-in mail landed: `auth:verifications:read` opens `GET {auth}/admin/verifications`, every sign-in link and code issued over a `since`/`until` window, counted by type as issued, used, expired unused and still pending, and the rows, paged — each with its type, the account when known, the `pithy_email_jobs` id that carried it, and its issue, expiry and use times. Never a token or an address. The job id is the join to `email:jobs:read` and `email:suppressions:read`. Auth writes the ledger itself, `pithy_auth_verification_outcomes`, because Better Auth deletes a verification on its first use; the purge erases an account's rows with it.
- **`@pithy-sh/audit`** — page the trail by actor, action, resource, outcome, severity, origin, tenant, and time; read one event in full. `tenant` is the one filter over a dimension the recorder does not stamp — it is whose action it was, and in a multi-tenant app it is the only column that separates one customer's history from another's, since project, environment, and Worker are constant across every row. Scopes: `audit:events:read`, `audit:events:read_detail`. The detail route is separate because IP, user-agent, and metadata one event at a time is a forensic read, and the same fields across a hundred rows is bulk harvesting. `GET /audit/control-plane/access-history?since=…` replays who could do what: every membership, connection and key change in the window, oldest first, each with when, the actor and its kind, and what changed. A member change names the organization, the membership, the member, and the role before and after — none before a join, none after a leave or a removal — and counts the operator's own writes, the founding of an account and ownership changing hands. A connection change names the connection, its kind, purpose and principal, and its scopes before and after. A key change names the key and whether it was registered, expired or revoked. An event written before its emitter recorded the detail says `detail: "not_recorded"`, and its unknown before or after is null rather than a guess. `until` ends the window and defaults to now; `cursor` and `limit` page it. Each page is one SQL statement over the named metadata keys, so it needs only `audit:events:read`: it never returns an IP, a user-agent, or any other metadata key. It answers whatever this Worker's trail holds, so a client reads each Worker it needs and filters by organization. `GET /audit/control-plane/reach?connectionId=…&since=…` answers what one credential reached, for the hour after a key leaks: one row per tenant, route, action, method and outcome, with the scope the credential carried, a count, the distinct subjects touched, and the first and last call. A call a handler refused past the gate is one denied call, not an admitted one beside it, when the request carries a request id; without one, as off Cloudflare, the refusal still counts as denied with the scope its own row names, and the gate's admission stays beside it. Either way the refusal's scope is the one the credential held, not the one it lacked; the gate's own refusals are of calls that never verified, so they name no connection and are no credential's reach. `keyId` narrows it to one key, `until` ends the window and defaults to now, and `route` narrows it to one route. Calls group by the admin route the manifest declares, matched most specific first; a called path no route matches is its own row, with `matched: false`. `route=…&subjects=true` expands one route into the paths it was called with and the subject ids they name — the list a breach scope is drawn from. The subject is the route's last id parameter, so a ledger read by user and currency names the user, and the subject count is of distinct subjects, not distinct paths. The tenant is the one the handler behind each call recorded in the same request, joined by `requestId` and actor, because the guard writes its row before any tenant is resolved; a call whose handler named none, or that carries no request id, reached no named tenant. It is one SQL statement over indexes on action, connection and time and on request id, and it needs only `audit:events:read`: it never returns an IP, a user-agent, or a metadata key beyond the key id, scope, method and path. `GET /audit/control-plane/usage?connectionId=…&since=…` answers which scopes one connection exercised and was refused: one row per scope and key, with `allowed` and `denied` counts, the last allowed call's time, method and path, and the last refusal's time, beside `oldestEventAt` — the oldest event the trail holds, so a client can tell a quiet connection from a window retention already pruned. `until` defaults to now. It is counted in one SQL statement over an index on action, connection and time, and it needs only `audit:events:read`, because it returns the management client's own footprint and never an IP, a user-agent or any other metadata key. Read-only by construction: a credential that could erase an audit row could erase the evidence of its own use.
- **`@pithy-sh/email`** — jobs by status and in detail, retry a failed one, read and amend the suppression list. Scopes: `email:jobs:read`, `email:jobs:retry`, `email:suppressions:read`, `email:suppressions:write`, `email:suppressions:delete`. Silent email failure costs a signup.
- **`@pithy-sh/media`** and **`@pithy-sh/storage`** — what an account holds: stored records and their bytes, per organization, or per owner within one organization. Scopes: `media:usage:read`, `storage:usage:read`. Numbers only — never a record, a path or a URL. **A per-owner figure is always one organization's**, so `groupBy=owner` and an `ownerId` filter are refused unless an `organizationId` is named (`none` for records written with no organization in force): a per-user total summed across organizations would disclose that the user holds an account elsewhere, by a figure that would not reconcile with what the organization can see. The adopter's permission hook is not asked, so it cannot widen one either.
- **`@pithy-sh/media`** — what this environment's media was served: minutes of video and image requests, per asset, in a window (`since`, `until`, the last 30 days by default). Scope: `media:delivery:read`. Read from Cloudflare's GraphQL Analytics API with the application's one `runtime` token ([TOKENS.md](TOKENS.md)), and **joined to this environment's own assets**: the datasets are account-wide, and Cloudflare is only ever asked about the Stream uids and Images ids this environment's database holds, so no account total is reported. A type stored in R2 is named as unavailable and why, never reported as zero. A window past what Cloudflare keeps is refused with `media/analytics_window`, naming the cap. An account whose Customer Metadata Boundary is outside the US gets `media/analytics_unavailable`, because Stream and Images analytics are US-only there, and "nothing was watched" is a different sentence. Every read is audited as `media/delivery_read`, with counts and never a name.
- **`@pithy-sh/turnstile`** — which widget guards this environment, whether it is a real one or one of Cloudflare's test keys, and how its challenges went in a window (`since`, `until`, the last 30 days by default). Scope: `turnstile:widgets:read`, at `GET /turnstile/admin/widgets`. Each widget the Worker's config declares is reported in one of four states. **`reported`**: a real sitekey, with challenges issued, solved and unsolved, the solve rate, what siteverify accepted and refused, and every event type Cloudflare counted, read from Cloudflare's `turnstileAdaptiveGroups` with the application's one `runtime` token ([TOKENS.md](TOKENS.md)) and filtered by that sitekey, so an account-wide dataset answers for this widget alone. **`test-key`**: one of Cloudflare's documented test keys, which is what dev, staging and a feature build render, deliberately. Its outcome is fixed, so nothing is queried, and it is never reported as broken or as zero challenges. **`misconfigured`**: one of those test keys anywhere else, prod included. The gate refuses a test key's verdict outside dev, staging and feature as `turnstile/config`, so no challenge gets through, and the read says so and names `pithy turnstile provision` rather than calling it deliberate. Nothing is queried for it either. **`unconfigured`**: no sitekey is in force here. A read is per environment, so a client asking about three environments asks three Workers. The account the widget lives in comes from `turnstile-account`, which `pithy turnstile provision` writes, and it is read only when a real widget is in force: an environment with a real widget and no account is `turnstile/config`, while a test-key, misconfigured or unconfigured one answers without it. A window past what Cloudflare keeps is `turnstile/analytics_window`, naming the cap. An account Cloudflare serves no Turnstile analytics to is `turnstile/analytics_unavailable`. The dataset is served under a US and an EU metadata boundary alike.
- **`@pithy-sh/vector`** — every index the Worker's config declares, read three ways. Scope: `vector:indexes:read`, at `GET {basePath}/indexes` (`/vector/indexes` by default; the manifest names the mounted path). **From config:** the declared model, dimensions and metric. **From Vectorize:** `describe()` on the index's own binding, so no Cloudflare API token is involved and nothing is added to `runtime` ([TOKENS.md](TOKENS.md)): the vector count, the dimensions it was created with, and `processedUpToDatetime` with `processedUpToMutation`, Vectorize's statement that every mutation before them is reflected, which is the answer to *have my writes landed*. A declared dimension count the index disagrees with is named as a mismatch, with `pithy vector reset` said as a person's decision, because dimensions are fixed at creation and the reset deletes every vector. An index whose binding is missing or whose `describe` fails is **`unreadable`**, never zero vectors. **From D1:** how many documents are embedded under the declared model, under another one, and under none, which is what catches a model changed and never reprocessed: queries compare vectors from two embedding spaces and nothing errors. **Against the provision record:** **`unprovisioned`** (declared, absent from `VECTOR_PROVISIONED`), **`provisioned`**, or **`drifted`** (a filterable field provision never saw, or saw as another type), naming each field. The read is an admin route, so it answers a drifted Worker, the state it most needs to report (#763). **Namespaces are a count and never a list.** A namespace partitions one index, and for many adopters it is a tenant or organization id, so naming them would enumerate those ids to every holder of the scope. Two health keys sit on the manifest behind the same scope. `vectorCorpusEmbedding` is a state, `current` or `stale`, nominal at `current`: whether any document is off its index's declared model. **It is a state and not a count on purpose.** A count of stale rows reads every row an index holds, even through the `(indexName, model)` index, so it would grow with the corpus on every manifest read; whether one exists is three seeks per declared index that each stop at the first row, which is what `cost: "indexed"` promises. The number is the index read's. `unprovisionedVectorIndexes` is a count, nominal at zero, read from the record already in the Worker's hands.
- **`@pithy-sh/organization`** — the account list and one account's roster, then membership administration: add an existing user at a named role, change a role, remove a member, rename an account or move its short name, set its seat limit, list, resend or revoke an invitation, and, where the project declares an `ownership` pair, force ownership onto a member when the owner is gone; and the organization's own lifecycle: suspend, reinstate, delete — soft with a window, or hard — and restore it, with an opt-in cascade to the accounts of members whose only organization it is. **A cascade can be previewed before it runs**: `POST …/suspend/preview` and `POST …/delete/preview` take the write's own body under the write's own scope, refuse whatever it would refuse with the same error, and answer who it would reach and who it would leave alone, and why — computed by the function the write calls, with nothing written. It is a snapshot; the write's response is the record. Scopes: `organization:accounts:read`, `organization:members:read`, `organization:members:write`, `organization:accounts:write`, `organization:ownership:transfer`, `organization:accounts:suspend`, `organization:accounts:delete`. Every write takes a required `reason` and is audited as an `organization/admin_*` event; a roster write never moves the owning role: an add at it, a role change to or from it, or the removal of an owner is refused 403 `controlplane/insufficient_scope`, naming the ownership route in `params.ownershipRoute`, even on a connection granted `organization:ownership:transfer` — ownership moves only through `POST …/ownership` — and the last owner cannot be removed or demoted. The routes and their rules are in the [organization README](../packages/organization/README.md#membership-administration) and [`organization-lifecycle.md`](../packages/organization/docs/organization-lifecycle.md).
- **`@pithy-sh/leaderboard`** — read a board and moderate it. Scopes: `leaderboard:entries:read`, `leaderboard:entries:moderate`. The read scope covers `GET {basePath}/admin/boards`, each board with the window open now and its rank mode; `GET {basePath}/admin/boards/:board/entries`, one window in the board's own order, keyset-paged, **hidden and opted-out entries in place with no rank**, each with the result that wrote it, filterable to one player or to hidden entries; and `GET {basePath}/admin/locks`, the rank-refresh lock with its holder and when it was taken. The lock is not per board: one `rank-refresh` row serializes the refresh across every board, so its routes are not board-rooted. The moderate scope covers `POST …/entries/:userId/hide`, `/unhide` and `/correct`, and `POST {basePath}/admin/locks/:name/clear`. **Every act takes an idempotency key and a required reason.** A replayed key answers what the first request did, writes nothing and emits nothing; the same key on another act is `core/conflict`. An act that names no window acts on the one open now, and its retry answers the window the first request acted on, even after a rollover. A blank reason is a 400 before anything is written. The change and its row in `pithy_leaderboard_moderations` — the act, what it found, what it left, the reason, the connection and the operator — are one `d1.batch()`, so a correction keeps the original score in the entry's history as well as on its audit event. A correction is held to the board's `min` and `max`, and takes the entry over: it keeps no result's contributions, so a later void of the session it replaced leaves the operator's number alone. A clear names the holder the operator saw, and a lock that has changed hands since is `core/conflict`, so a running refresh is never released. Each act that changed something emits one `leaderboard/entry_hidden`, `entry_unhidden`, `entry_corrected` or `lock_cleared`, severity `warning`. Ranks recompute by the board's own mode: a `live` board on its next read, a materialized one on its next refresh pass, with the entry's stored rank cleared and its window marked in `pithy_leaderboard_stale_windows`, so a closed window is renumbered too. Kinds, per #725: the read scope is `reads`, the moderate scope `writes`.
- **`@pithy-sh/ledger`** — balances and transaction history, and four writes that correct one account: credit, debit, reverse an entry, release a hold, each a `POST` under `{base}/admin/accounts/:userId/:currency/`. Scopes: `ledger:accounts:read`, `ledger:transactions:read`, `ledger:accounts:adjust`. **The writes carry every guarantee the in-process ledger gives, and two a console needs.** Each takes an idempotency key the client chose, written as the entry's ref, so a double-click moves the balance once and a replay answers 200 with the balance as it stands and `applied: false`. Each takes a required `reason`, refused when blank before anything is written, stored as the entry's memo and carried verbatim on the audit event. A debit, and a reversal of a credit, are refused below `available` with `ledger/insufficient_funds`, naming the shortfall in `params`, so no balance goes negative. **Nothing is updated or deleted**: a reversal is a new entry, the opposite movement under `<ref>:reverse` carrying the original as its `relatedRef`, and that ref is unique, so two reversals of one entry sent at once post one. Only a credit or a debit reverses, and never a reversal; anything else is `ledger/entry_not_reversible`, naming the kind. **A client ref never ends in `:reverse`, `:resolve`, `:out` or `:in`**: the ledger writes those itself, so a credit or a debit naming one is refused before anything is written. And `applied: false` means only a replay — the same write sent again. The same key sent for another account, for the other act, for another amount or naming a hold is `ledger/ref_conflict`, and so is a reversal or a release whose derived ref an unrelated entry holds; nothing moves. A reversal or a release names a ref, and the entry or hold must be on the account the path names, or it is not found and never touched. Every write that moved money writes one `warning` audit event — `ledger/account_credited`, `ledger/account_debited`, `ledger/entry_reversed` or `ledger/hold_released` — naming the connection, the account, the act, the ref it wrote, the amount, the reason and the balance before and after; a replay or a refusal writes none. The reads stay audited as before, with identifiers and counts and never a balance, a memo or a ref. `ledger:accounts:adjust` is the one scope that moves money, it reads nothing, and `pithy dashboard connect` never grants it unasked — reads are preselected and it is not one.
- **`@pithy-sh/matchmaking`** — who is waiting for a game, and two acts on it. Reads, behind `matchmaking:queues:read`: `GET {basePath}/admin/games/:game/queue`, each waiting player's region, skill, current skill band and wait, read from the game's queue Durable Object; `GET {basePath}/admin/games/:game/rooms`, the open rooms with their code, host, occupancy and age, paged by KV cursor (codes for every game share one list, so a page can hold fewer than asked and `nextCursor` says whether to read on); `GET {basePath}/admin/invites`, every pending invite, newest first, optionally for one `game`. Acts, behind `matchmaking:queues:moderate`: `POST {basePath}/admin/invites/:id/cancel` and `POST {basePath}/admin/games/:game/queue/:userId/drop`. **Each act takes an `idempotencyKey` and a required `reason`.** A retry with the same key changes nothing, tells nobody, emits nothing and answers `replayed: true`. A drop's key is remembered for a day, in that game's queue. A key already spent canceling another invite, or dropping another player from the same game's queue, is `core/conflict`. A cancel tells both players through presence (`invite_canceled`), and the invite can no longer be accepted; a drop tells the player's presence socket why (`queue_dropped`, carrying the reason, so it is written for them). Each first act emits one `@pithy-sh/audit` event, `matchmaking/invite_canceled` or `matchmaking/queue_player_dropped`, `actorType: "control-plane"`, carrying the connection, the game, the target and the reason. The read is a read, so `pithy dashboard connect` grants it by default; the acts are `POST`s and never are. **No route reads or writes the friend graph**: friend edges are the players' own.
- **`@pithy-sh/secrets`** — every declared secret's status, one secret's rotation history, and rotating one secret. Scopes: `secrets:status:read`, `secrets:rotate`. **Metadata only, and structurally so**: the response types have no field for a value, a ciphertext, an IV, a metadata snapshot or a rotation's error message, so widening one is a compile error rather than a review miss. A failed rotation reports as a status and a code, never as a message — an error message is free text written at a failure site, which is where a value gets pasted by accident. Its own read scope because the list of which credentials a project holds, which are stale, and which no automation will ever rotate is a map of where to push; an adopter must be able to grant a users pane without also granting that. There is no route that reads a value and no scope that could grant one: the reason a secret is encrypted under a key only the customer's Worker holds is that no third party has a path to the plaintext, and a route here would be that path in every deployment whether or not anybody granted it.

  **`secrets:rotate` is separate again, and it is the one scope where folding would have been an escalation with a name that hid it.** `scopeCovers` matches exactly, so a scope confers every route requiring it — a rotation behind `secrets:status:read` would have handed credential replacement to every adopter who ever wanted a status pane, retroactively and without being asked. It never enters a default grant either, because `defaultGrant` classifies by route method and every route requiring it is a `POST`.

  **The write is a rotation and nothing else, and that is what makes it possible.** Create and update still cannot exist here: a management client holds neither the adopter's registry nor their Zod schemas, so it could not write a value against the schema that governs it. A rotation supplies nothing — the successor is produced inside the Worker, minted from the entry's own recipe or returned by the rotator its registry entry carries — so no value crosses in either direction, and the outcome shape has no field one could sit in.

  **A Worker rotates less than the CLI does, and says so rather than doing half of it.** It holds one environment's D1 and its own master key. A `cf-secrets-store` secret is an account-level entry written through Cloudflare's API with a token an app Worker must never hold; a `global` secret is identical in every environment by definition, and writing one of them would strand the rest under one name. Both are refused with `secrets/rotation_unsupported` (409) naming `pithy secrets rotate`, before anything is called — so is a name this environment has never stored, because discovering *that* after a provider roll would manufacture an unrecoverable incident out of a configuration gap. Every rotation, successful or not, is audited as `secrets/rotated` with the operator, the secret, the environments and the outcome; the `unrecorded` member — rolled at the issuer, successor never stored — is `critical`.

That list is what a customer consents to at connect, so it is stated here rather than left to be read off a manifest.

A capability also **declares** those routes via `adminRoutes`, so a management client learns how to call them from the Worker itself rather than from a route table it ships with (§14).

```ts
app.post(
  `${base}/entitlements/grant`,
  describeRoute({
    summary: "Grant an entitlement by hand.",
    verification: "control-plane",
    scopes: [PAYMENTS_ENTITLEMENT_GRANT_SCOPE],
    responses: { 200: PaymentsEntitlementResponse },
  }),
  requireControlPlane(PAYMENTS_ENTITLEMENT_GRANT_SCOPE),
  validate("json", EntitlementGrantRequest),
  (c) => grantEntitlement(c, c.req.valid("json")),
);
```

Note that those are **two** scopes — `payments:entitlements:grant` and `payments:entitlements:revoke` — not one admin flag. Scopes name operations, not credential holders, and these two operations have different blast radii: grant mints paid product out of nothing, revoke takes paid access from a live customer. A refund tool needs revoke and never grant. One flag would make each of them the other.

**The override writes split the same way, three times.** `POST /payments/entitlements/overrides` pins a negotiated number or switch for one subject — a merge by name, so a request names only what it changes; version-checked, so a write behind the row is `payments/override_stale` (409) and changes nothing; bounded by any `overrideMax` the catalog declares, refused naming the limit and never clamped; and carrying a required `reason` the audit event records verbatim. Its scope is `payments:overrides:set`. **`unrestricted` is not a field on that body** — a set carrying it is a 400 — but its own route, `POST /payments/entitlements/overrides/unrestricted`, behind `payments:overrides:unrestricted`: every quota unlimited and every feature on, for every name declared now and every name declared later. It is the largest grant the kit has and the only one whose reach grows by itself, so a credential that may raise one customer's email cap must not, by that fact, be able to hand anybody the whole product. `POST /payments/entitlements/overrides/clear` unpins names or the whole override behind `payments:overrides:clear`; its `version` and `reason` are optional, so a clear sent without a version is not checked against the row, and a clear of nothing answers 200. None of the three grants an entitlement key. Each write that changes the row writes an `@pithy-sh/audit` event naming the subject, the mode, the before and the after; a clear of nothing writes none. `GET /payments/admin/overrides` and the per-subject read show every override, and every entitlement row says whether its holder is unrestricted — so does `pithy doctor`.

**And a capability that can write a resource must be able to read it.** Payments shipped those two writes and no read, which is a subtler failure than a missing feature: a pane over a resource nothing declares computes `absent` and vanishes, so the surface reports *nothing is wrong*. A refusal an adopter can act on requires a route to refuse. `packages/payments/src/admin/coverage.ts` states the invariant for that capability and `coverage.test.ts` enforces it — every table decides, where it is defined, whether a management client may read it, and every resource the control-plane surface can write it can also read.

**Never put `requireAuth()` on a control-plane route.** A management client is not a user of the adopter's app, so `c.var.auth` is deliberately null on these calls — an auth gate would deny every legitimate management call, permanently, with no credential able to fix it.

Guards before validators, always. A validator ahead of the guard turns a 401 into a 400 and tells an unauthenticated caller which requests were well-formed — on this seam that is a live oracle.

**A Worker in a bad state still answers its control plane.** It is the diagnostic surface, so it cannot sit behind the faults it diagnoses. A capability that must refuse because the Worker is misconfigured or unprovisioned declares that refusal as `readiness`, not `middleware`:

```ts
defineCapability({
  name: "vector",
  readiness: [provisionGuard(resolved)],
  // …
});
```

`createBackend` mounts every readiness guard after every capability's `middleware` and before any capability's routes, and skips it on the admin surface: every composed capability's `adminRoutes`, the seam's own included. So a Worker whose vector index drifted answers `ping`, the manifest and every admin route, and answers everything else with the drift error. `GET /health` answers either way.

Only that kind of refusal goes there. A rate limit, authentication and a CSRF check refuse a *caller*, and they stay in `middleware`, where they keep running on the admin surface. So does everything the seam stands on: `controlplane()`'s verifier and `audit()`'s recorder are both middleware, which is why the exemption is the guard and never the middleware. Skip those and the seam denies everything, or stops auditing without a word.

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
    { "name": "controlplane", "package": "@pithy-sh/core", "version": "1.4.0", "healthKeys": [], "health": null,
      "configKeys": [], "config": {}, "adminRoutes": [
      { "method": "GET",  "path": "/control-plane/ping", "scope": null,
        "summary": "Prove connectivity and which key answered. Always available to a verified caller." }
    ]},
    { "name": "payments", "package": "@pithy-sh/payments", "version": "1.4.0", "healthKeys": [], "health": null,
      "configKeys": [
        { "key": "billingSubject", "choices": ["user", "organization"],
          "summary": "What kind of thing holds a purchase in this project — one person, or one organization." }
      ],
      "config": { "billingSubject": "organization" },
      "adminRoutes": [
        { "method": "POST", "path": "/billing/entitlements/grant", "scope": "payments:entitlements:grant",
          "summary": "Comp an entitlement, or repair a purchase that verified but never projected." },
        { "method": "POST", "path": "/billing/entitlements/revoke", "scope": "payments:entitlements:revoke",
          "summary": "Take an entitlement back, effective immediately." }
      ]},
    { "name": "secrets", "package": "@pithy-sh/secrets", "version": "1.4.0",
      "healthKeys": [
        { "key": "secretsDueForRotation", "kind": "count", "states": null,
          "scope": "secrets:status:read", "cost": "indexed",
          "summary": "Secrets past the rotation cadence their registry entry declares." }
      ],
      "health": { "secretsDueForRotation": 3 },
      "configKeys": [],
      "config": {},
      "adminRoutes": [
        { "method": "GET", "path": "/secrets/admin/status", "scope": "secrets:status:read",
          "summary": "Every declared secret's status: when it was last rotated, how often, and whether it is overdue." },
        { "method": "POST", "path": "/secrets/admin/status/:name/rotate", "scope": "secrets:rotate",
          "summary": "Replace one declared secret in this environment, against its declared rotator. Reports per environment, never in aggregate." }
      ]},
    { "name": "rating", "package": "@pithy-sh/rating", "version": "0.5.0", "healthKeys": [], "health": null,
      "configKeys": [], "config": {}, "adminRoutes": [] },
    { "name": "app", "package": null, "version": null, "healthKeys": [], "health": null,
      "configKeys": [], "config": {}, "adminRoutes": [] }
  ],
  "grantedScopes": ["manifest:read", "payments:entitlements:grant"]
}
```

**Knowing a capability is installed is not enough to call it.** Note the paths above: this adopter mounted payments at `/billing`. `basePath` is configurable on every capability, so a client that hardcoded `/payments` would 404 against exactly the adopters who customized anything. Each capability builds its declaration from its *resolved* config, so the manifest names where things actually are.

Each route also names the scope it needs. Against `grantedScopes`, that is what lets a client gray out `revoke` — not granted here — instead of offering a button that answers 403.

**Each capability names the package it comes from, beside the version.** A version is only actionable joined against a release feed, a feed is keyed by package name, and a capability name is not one — `controlplane` ships inside `@pithy-sh/core`, so a client deriving `@pithy-sh/<name>` asks about a package that has never been published and is told nothing, which reads exactly like *up to date*. `package` and `version` are null together: the adopter's own `app` capability has a name and neither. A Worker deployed before the field sends no `package` at all, and a client reads that as null and falls back to whatever it guessed before.

A capability with no management surface reports an empty list rather than being absent. "Composed, but nothing to administer" and "not installed" are different facts, and a client that cannot tell them apart renders the wrong thing for both. The same holds for `configKeys` and `config`: only payments states a fact above, and every other entry carries `[]` and `{}` rather than omitting them.

So a Worker that does not compose payments has no purchases pane, and that is a fact the client discovers. Run `pithy add support` and a **working** support pane appears on the next visit — panes *and* the calls behind them — with nothing for either side to configure.

**The declaration is checked, not trusted.** A hand-maintained list beside generated behavior is a list that rots, and a manifest that has drifted is worse than none: a client believes it, calls a path nothing serves, and the adopter sees a management client broken for reasons inside somebody else's package. So `missingAdminRoutes` compares every declared route against the router that actually mounted, and each capability asserts it in its own `routeContract.test.ts`.

There is deliberately **no manifest schema version**. With the routes described here, a client dispatches on what this Worker declares right now; a schema version would be a second source of truth to keep in sync with the first.

### The facts a client must respect

A route says where to call and which scope to hold. It does not say what to **send**. `POST /billing/entitlements/grant` names the holder and never assumes it — `subjectType` is a request field, deliberately — and whether this project's holders are people or organizations is a decision the adopter made once, in config, with no default to fall back on. A client that cannot read that decision has to guess it. Against a project billing the other kind the guess is refused, and the person a support agent meant to help is still locked out.

Nothing else on the wire answers it either. The catalog read returns products. The client projection leaves it out on purpose and is a browser bundle besides. And the entitlement rows carry a `subjectType` each — evidence about who happens to hold something, not a statement about what the project bills. An empty table says nothing, and a project that migrated has both kinds in it.

So a capability may state **configured facts** on its own entry, declared alongside its routes for the same reason: `configKeys` is the closed vocabulary, `config` is what this deployment resolved each one to. Payments states one, `billingSubject`, read off `PaymentsSubjectType` so a third kind of holder cannot land without the manifest learning it. Most capabilities state none, and say so with an empty list.

**A configured fact is not a health number**, though the two sit side by side on the entry:

| | A health number | A configured fact |
| --- | --- | --- |
| Who it is for | This caller — scoped, and withheld without the grant | Everybody, identically |
| Where it comes from | A producer, run on the read | Resolved config, read once at assembly |
| How it fails | `unavailable` — a fourth state that must not read as zero | It cannot. There is nothing to ask |
| How old it is | As old as the manifest a client cached | Changes only when the adopter redeploys |
| What a client does with it | Renders it | Sends it back on the next call |

**No per-key scope, deliberately.** A health key inherits one because a count is still a fact about somebody's posture. `billingSubject` is not that: it names no account, no transaction and no amount, and reads identically against an empty database. The whole manifest already sits behind `manifest:read` — the same gate that discloses every route, every scope and every composed version. Withholding stays addable later with no wire change: a key present in `configKeys` with no value in `config` already means "declared and not shown".

**Scalars only, and a value nothing declares is refused.** A capability's resolved config holds provider credentials and an adopter's whole catalog, so the seam is narrow by construction rather than by taste: `defineManifestConfig` is the only constructor, it takes a string, a number or a boolean and nothing else, and it refuses a value no key declares, a declared key with no value, and a value outside its own `choices`.

**Both fields are defaulted rather than required**, like `healthKeys` before them. A Worker deployed before they existed sends neither, and its manifest must still parse whole — there is no schema version to negotiate on, so absence is the entire compatibility mechanism.

### The numbers, so a rail costs one read

A client that wants to say *"3 secrets need rotating"* beside a rail already read this. Making it call again — once per capability it wants a number from, against a production Worker, on every screen load — spends a credential per number nobody has asked for yet. **The count is not the expensive part. The round trip is.**

So a capability may contribute a **bounded health summary** to its own entry, declared alongside its routes. `healthKeys` is the closed vocabulary; `health` is what this caller is entitled to see. Most capabilities contribute nothing, and say so with an empty list.

Three rules keep it from becoming a data API, and each is in the type rather than in a comment:

- **Scalars only.** A number, or a member of a closed list. No names, no ids, no rows, no nested objects — a projection does not compile.
- **A closed vocabulary per capability.** A client renders a key it has never heard of from the declaration beside it, or renders nothing; a value the declaration does not name is refused before it reaches the wire.
- **Nothing that costs a table scan.** `cost` is `memory` or `indexed`, and there is no third member — so a value that would need a scan cannot state its cost, and therefore cannot be declared. A count that scans on every manifest read has moved the cost, not removed it.

**A withheld number and a zero are different facts.** Each key names a scope the capability's *own admin routes* already require — never a new one, or an adopter would never be offered it at connect — and a connection without that scope gets `null`, not `0`. Read `health` with `healthKeys` beside it and three states are distinguishable: nothing declared, declared and withheld, declared and zero. Collapse the first two and a client tells an adopter everything is fine when it has simply not been allowed to look. A caller with no grant is not merely filtered, either: the producer is never run, so the number costs the adopter's Worker nothing.

**These numbers are as old as the manifest a client cached.** They are right for a rail. They are not live, and must not be rendered as if they were.

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

**Nothing inside a Worker can observe a deployment.** That is a boundary of what the runtime exposes, not a gap in this seam, and no header could close it — the only in-Worker signal anyone could synthesize is isolate boot time, which changes on every cold start and would report a redeploy dozens of times a day. A client that needs to know a deployment changed reads Cloudflare's deployments API, in the customer's own account.

**The manifest body carries the creation time too, as `versionCreatedAt` beside `version`** (#132), from the same binding and with the same rule: relayed, never interpreted, and `null` where the binding is absent. It is there for a client that reads the body and not the headers — and for the comparison `docs/PRIVACY.md` describes, where a privacy attestation much older than the version it rides on is a build the attestation does not describe.

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
pithy dashboard connect --env prod
pithy dashboard connect --env prod --update --worker-url https://api.example.com
pithy dashboard connect --env prod --public-key ./client.jwk.json --scope manifest:read
pithy dashboard connect --env prod --scope all
pithy dashboard rotate --env prod
pithy dashboard revoke-key --env prod --key-id cpk_2026_07
pithy dashboard disconnect --env prod
pithy dashboard status --env prod
```

Connection is **project-wide, per environment — never per Worker.** Workers share a resource by declaring the same binding name, so one user record lives in one D1 that several Workers touch. A per-Worker credential would produce views where a user is visible in one pane and absent from another.

### Which of these go through the seam

Registering a key is your Worker's own decision to make. `POST /control-plane/keys` is where that decision is made: it checks the connection's `keys:rotate` grant, it is signed with the key being replaced, and it writes the registration into your audit trail. A CLI writing that column directly is not a second implementation of the rule — both paths share the same lifecycle code — but a second **authority** over it, which means the rule holds for whoever remembers to route through it.

So one rule, stated as a property rather than a list:

> **The CLI adds a key to your connection only when no live key exists to sign for one through the seam.**

| Command | Where the write happens | Recorded as | Why |
|---|---|---|---|
| `connect` (first) | The CLI, into your D1 | `controlplane/connection_registered` | No key exists, so nothing can sign a registration — and your Worker may not be deployed at all. **The one exemption.** |
| `connect` (starting over) | The CLI, into your D1 | `controlplane/connection_removed` for the old connection, with `replacedByConnectionId`, then `controlplane/connection_registered` for the new one, with `replacedConnectionId` | The same exemption. Starting over ends the old connection's grant as surely as `disconnect` would, so it is recorded as a removal first — otherwise the trail shows the old connection registered and never ended. |
| `connect --public-key` (first) | The CLI, into your D1 | `controlplane/connection_registered` | The same case with no dashboard in it. |
| `connect --public-key` (a successor) | Refused | — | A live key exists, so the seam can serve it. The CLI cannot: the private half is yours. It prints the call to make. |
| `connect --public-key` (recovery) | The CLI, into your D1 | `controlplane/connection_updated` | The connection existed and had nothing live, so nothing could sign. Its keys changed; the connection was not created. The new key takes a signed-in session, `--kind` and `--purpose`, and the row's principal, kind and purpose become that key's, recorded as a `connection_updated` that says what they were. |
| `connect --update` | The CLI, into your D1 | `controlplane/connection_updated` | Adds no key. It re-points an address your Worker never reads, edits the purpose, and changes a grant only you may change — a route letting a client widen its own grant is the thing scopes exist to prevent. The client is told the new address first, and the row is written only if that succeeded. |
| `rotate` | **The seam**, `POST /control-plane/keys` | `controlplane/key_registered` | A live key exists to sign with, so the registration is your Worker's to accept, audit, and scope-check. |
| expiry | **The seam**, `POST /control-plane/keys/:keyId/expire` | `controlplane/key_expired` | Never the CLI's at all, and never was: it belongs to the client that proved the successor from its own infrastructure (§6). |
| `revoke-key` | The CLI, into your D1 | `controlplane/connection_updated` | Revocation *removes* trust, and revocation that needed our cooperation would not be revocation (§7). |
| `disconnect` | The CLI, into your D1 | `controlplane/connection_removed` | The same, at connection granularity: every credential for this environment stops working at once. |

Exactly one operation is exempt, and it is exempt because the seam cannot serve it rather than because it is convenient: a connection with nothing live has nothing to sign a registration with. Requiring a running Worker to register the key that lets anyone talk to it is a chicken-and-egg with no exit. That same sentence covers recovery — a connection whose every key you revoked is back to having nothing that can sign, and `connect` is the way out.

### A CLI-side write records itself

**Every row in that table has a code beside it, and the CLI-side ones are written by the CLI.** A write that never reaches your Worker cannot be recorded by a route — there is no request to record — so `pithy dashboard` writes the event itself, into the same D1 as the connection row, through `connectionRegistry`. That is the only door onto the table, which is what makes "every write is recorded" a property rather than a habit.

It matters most for the ones that never touch your Worker at all. A management client gaining reach into an environment, that reach moving, and every credential for it dying at once are the three widest-blast-radius changes on your side, and until they were emitted you could read a *key* rotation in your own trail but not the connection being created or destroyed. The larger event was the invisible one.

Three things follow, and each is visible in the row:

- **The actor is not `control-plane`.** That kind means a management client called in and proved it. These came from a person at a terminal, named from your Cloudflare sign-in or token where the command had one — the person under a `pithy cloudflare connect` session, the token's name under an account token — and recorded as `system` with a note where it did not. `worker` and `version` are null, because no Worker recorded it and there is no build id to name.
- **Nothing is recorded that did not happen.** The row is written first and the event follows. A refused write records nothing.
- **The trail never fails the command.** If you do not compose `audit`, the events go nowhere and `connect` is unchanged. If your trail is unreachable, the write still lands and the drop is logged. A `disconnect` that failed because the audit database was down would leave a credential live on the strength of an audit problem, which is exactly backwards.

The metadata names ids and addresses — the connection, the keys by id, the scopes, what a re-point moved from and to. A registration also names who authorized it, its kind and its purpose, and an edited purpose names the old and the new. Never key material.

**Registering takes a signed-in session.** `connect` records the session's email as the connection's authorizing principal, and refuses an account token, a session with no email, and no credential at all, in every environment, naming `pithy cloudflare connect` ([`AGENT-ACCESS.md` §7](AGENT-ACCESS.md)).

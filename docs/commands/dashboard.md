# pithy dashboard

Register a management client's access to one of your environments, rotate its key, revoke it, and inspect what is registered.

## Synopsis

```
pithy dashboard connect [--env <environment>] [--worker <name>] [--worker-url <url>] [--scope <scope>]… [--update] [--public-key <file> --issuer <url> [--key-id <id>]] [--project <name>] [--origin <url>] [--json]
pithy dashboard rotate [--env <environment>] [--worker <name>] [--origin <url>] [--json]
pithy dashboard revoke-key --key-id <id> [--env <environment>] [--worker <name>] [--yes] [--origin <url>] [--json]
pithy dashboard disconnect [--env <environment>] [--worker <name>] [--yes] [--local] [--origin <url>] [--json]
pithy dashboard status [--env <environment>] [--worker <name>] [--verify] [--origin <url>] [--json]
```

**You run these, against your own project.** They are the CLI half of the control-plane seam (`docs/CONTROL-PLANE.md`): the commands by which you grant a management client — the hosted dashboard at `app.pithy.sh`, or one you wrote yourself — the right to call your Worker's administrative routes, and by which you take that right back. Every registration is a row in *your* D1. Your Worker is the authority; the management client is a client.

**Connection is project-wide, per environment — never per Worker.** Workers share a resource by declaring the same binding name, so one user record lives in one D1 that several Workers touch. A per-Worker credential would produce a management view where a user is visible in one pane and absent from another. `--worker` is only how the CLI finds the app database; the row is keyed on `--env`.

**What needs what.** `--env dev` resolves the database from a local Miniflare store and needs no Cloudflare account; `--env staging` or `--env prod` reads and writes the environment's real D1 over the REST API, which needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. Separately, `connect`, `rotate`, `disconnect`, and `status --verify` call the management client and run a browser device-code flow, which needs a human at a browser. Two paths avoid that: `connect --public-key`, which contacts no dashboard at all, and `disconnect --local`, which skips the courtesy call. `revoke-key` never contacts anyone.

## Flags

| Flag | Applies to | Default | Purpose |
|---|---|---|---|
| `--env <environment>` | all five | `dev` | The environment whose registration is being read or written |
| `--worker <name>` | all five | resolved | Which Worker resolves the app database (`apps/<name>`). On `connect` it also names the Worker that composes the admin surface, and is required when the project has several |
| `--origin <url>` | all five | `https://app.pithy.sh` | The management client's origin. Re-points every call at a self-hosted one |
| `--worker-url <url>` | `connect` | resolved | Override the resolved Worker URL for this environment. The only way to say so when a proxy fronts your Worker |
| `--scope <scope>` | `connect` | the seam's own, plus every declared read | Grant one scope, narrowing the default. Repeatable — the raw argv is read, so several survive |
| `--update` | `connect` | `false` | Re-point an existing connection's URL and scopes instead of creating one |
| `--public-key <file>` | `connect` | — | Register a JWK you generated yourself. No dashboard is contacted |
| `--issuer <url>` | `connect` | — | With `--public-key`: the `iss` your own client presents. Required on that path, and rejected off it |
| `--key-id <id>` | `connect` | the JWK's `kid` | With `--public-key`: the key id, if the JWK carries none. Rejected off that path |
| `--key-id <id>` | `revoke-key` | required | The key to revoke, as `status` reports it |
| `--project <name>` | `connect` | `pithy.config.ts`'s `name` | Override the project name sent to the management client |
| `--yes` | `revoke-key`, `disconnect` | `false` | Skip the confirmation. How CI runs the same command |
| `--local` | `disconnect` | `false` | Delete the row without telling the management client |
| `--verify` | `status` | `false` | Prove the connection with a signed ping |
| `--json` | all five | `false` | One line of machine-readable output. Implies non-interactive: no prompt is ever shown |

Every subcommand writes its machine output to stdout and its diagnostics — the device code, the waiting line — to stderr, so a `--json` consumer parses one clean line.

## What it does

**`connect`** registers a management client against one environment. It resolves the address from your project rather than demanding it: the Worker's `domains` declaration for that environment, else its first `routes` pattern, else a hand-set `vars.BASE_URL`. It prints what it found and where it came from before registering. It also sends the seam's **base path** — the mount point, `/control-plane` by default — because that is the one address a client cannot discover, and a wrong one registers cleanly, passes the ping, and then 404s every call.

### What a connect grants

**The default is every read your Worker declares, plus the seam's own two.** Connecting produces a management client that can actually read, without a second command — which used to be the whole problem: a connection holding `manifest:read` and `keys:rotate` opens a dashboard where every pane says the credential does not cover this call, and looks like a broken product rather than a grant nobody made.

It is derived, never listed. Each capability declares its admin routes with the scope each one needs, and `connect` reads that off the Worker it is registering — the same declaration `GET /control-plane/manifest` reports. So a capability you add is offered on your next `connect` with no coordination and nothing to keep in step, and a capability you do not compose is never mentioned.

**A read is a route, not a name.** A scope joins the default only when *every* declared route requiring it is a `GET`. `scopeCovers` matches exactly — no prefixes, no wildcards — so holding a scope confers every route that requires it, and one mutating route anywhere makes the whole scope a write however it is spelled. That is why `keys:rotate` is not derived: it gates a key listing and two key writes. It stays in the default because it always has, and because dropping it would break `pithy dashboard rotate` on every new connection — but nothing the derivation adds can write.

At a terminal `connect` lists every operation your Worker exposes, described in each capability's own words, preselected to that default — because narrowing is the point of showing the list. `--scope` answers the same question non-interactively and narrows to exactly what you pass. An explicitly empty selection is passed through as empty rather than collapsed into the default: an operator who deselected everything must not be handed `keys:rotate` anyway. On an update, no `--scope` means "leave the grant alone".

Whatever you end up with is printed on the `Scopes` line and stored on your row, and your Worker enforces that row and nothing else. A narrowed grant refuses every call it left out with `controlplane/insufficient_scope`, and the manifest tells a client which routes those are before it tries.

Then the device-code flow: a short user code, your browser, your approval. The management client generates the Ed25519 keypair, keeps the private half, and returns the public one; the CLI writes it into your D1. **Nothing reports connected until a signed `ping` round-trips** against your Worker. A registration that was written but cannot be reached is a dead link, and reporting it as connected is how an operator finds out weeks later — so that case is `needs_reconnect`, and the command deliberately does not print `Done.`

The client's response is checked, not trusted. A scope it returns that you did not request is a management client trying to widen its own grant, and the connection is refused outright rather than quietly stored narrower.

`--public-key` is the offline path: register a key you generated, with no dashboard involved, and write your own management client against the contract in `@pithy-sh/cli/src/dashboard/contract`. Nothing proves that key — the CLI holds no private half to sign with — so the status is `registered` and the command says so.

**`rotate`** appends a successor key and proves it. **It never expires the old one**, and that ordering is the entire safety property (`docs/CONTROL-PLANE.md` §6): append, prove, then expire, with expiry belonging to the management client once *it* has proven the successor from *its* infrastructure. Two live keys is a normal state. A stale key costs nothing; expiring one that turns out to be the only working credential costs the connection, with no authenticated path back.

**`revoke-key`** stamps one key revoked, immediately. It is the narrow instrument beside `disconnect`'s blunt one: a client that leaked a single key does not need the whole connection rebuilt. Purely local — it writes to your own D1 and tells nobody, which is what "immediate and unilateral" has to mean. It will take the last live key if you ask it to, because an adopter holding a leaked key must never be told they have to keep trusting it; the connection is then denying every call, and the command says so plainly.

**`disconnect`** deletes the registration. **The row goes first**, and the management client is told afterwards as a courtesy that cannot fail the command — a dashboard that is down must not be able to keep a credential alive. Re-running it is not an error.

**`status`** reports what is registered: the connection, its scopes, and every key with its age and whether it is live. Looking is free; proving costs a browser sign-in, so the probe is opt-in behind `--verify` and its absence is reported as `unverified` rather than guessed at.

## `--json`

One line, one object, one shape per subcommand. The `command` field is the subcommand's dotted name, matching `worker.add` and `feature.create` rather than the space-separated form the resource commands use.

```
$ pithy dashboard connect --env prod --json
{"command":"dashboard.connect","environment":"prod","connectionId":"b6a1f0c2-…","issuer":"https://app.pithy.sh","workerUrl":"https://api.example.com","scopes":["manifest:read"],"keyId":"cpk_2026_07","status":"connected","updated":false}
```

| key | type | meaning |
|---|---|---|
| `command` | `"dashboard.connect"` | The subcommand that produced the line |
| `environment` | `string` | The environment the connection is bound to |
| `connectionId` | `string` | The connection's id — the token `aud`, and the row's primary key |
| `issuer` | `string` | The management-client origin every token from this connection must carry |
| `workerUrl` | `string` | The Worker URL the management client will call |
| `scopes` | `string[]` | The operations granted, as stored on the row |
| `keyId` | `string \| null` | The key registered by this run, or `null` when `--update` only re-pointed |
| `status` | `"connected" \| "needs_reconnect" \| "registered"` | Whether a signed ping proved the connection. `registered` is the `--public-key` path: written, but nothing proved it |
| `detail` | `string` | Operator-facing context for a status that is not `connected`. Absent otherwise |
| `updated` | `boolean` | True when an existing connection was re-pointed rather than a new one created |

```
$ pithy dashboard rotate --env prod --json
{"command":"dashboard.rotate","environment":"prod","connectionId":"b6a1f0c2-…","keyId":"cpk_2026_08","previousKeyIds":["cpk_2026_07"],"status":"connected"}
```

| key | type | meaning |
|---|---|---|
| `command` | `"dashboard.rotate"` | The subcommand that produced the line |
| `environment` | `string` | The environment rotated |
| `connectionId` | `string` | The connection the key was appended to |
| `keyId` | `string` | The newly registered key |
| `previousKeyIds` | `string[]` | The keys that were already live, and that stay live. Two live keys is the normal state |
| `status` | `"connected" \| "needs_reconnect"` | Whether a signed ping proved the new key |
| `detail` | `string` | Operator-facing context when the ping did not prove it. Absent otherwise |

```
$ pithy dashboard revoke-key --env prod --key-id cpk_2026_07 --yes --json
{"command":"dashboard.revoke-key","environment":"prod","keyId":"cpk_2026_07","revoked":true,"connection":{"id":"b6a1f0c2-…","environment":"prod","issuer":"https://app.pithy.sh","workerUrl":"https://api.example.com","basePath":"/control-plane","scopes":["manifest:read"],"keys":[…],"createdAt":"2026-07-01T09:00:00.000Z","updatedAt":"2026-08-05T11:12:13.000Z"}}
```

| key | type | meaning |
|---|---|---|
| `command` | `"dashboard.revoke-key"` | The subcommand that produced the line |
| `environment` | `string` | The environment the key was revoked on |
| `keyId` | `string` | The key named by `--key-id` |
| `revoked` | `boolean` | `false` when no key answered to that id. Re-running a revoke is not an error |
| `connection` | `object \| null` | The connection after the write, or `null` when nothing matched |
| `connection.id` | `string` | The connection id — a UUID, because it is the token `aud` and therefore externally exposed |
| `connection.environment` | `string` | The environment this connection is valid in. Checked against the Worker's own on every call, so a staging credential cannot reach production |
| `connection.issuer` | `string` | The exact `iss` this connection accepts |
| `connection.workerUrl` | `string` | The deployed Worker URL captured at connect |
| `connection.basePath` | `string` | Where this Worker mounts the seam. `/control-plane` unless you moved it |
| `connection.scopes` | `string[]` | The operations granted, stored and enforced on your side |
| `connection.keys` | `object[]` | Every key this connection may sign with, current and superseded |
| `connection.keys[].keyId` | `string` | The key's id, matched against a token's `kid` header |
| `connection.keys[].publicKey` | `object` | The Ed25519 public JWK: `kty` (`"OKP"`), `crv` (`"Ed25519"`), and `x`, the base64url public point |
| `connection.keys[].validFrom` | `string` | ISO-8601. When the key became valid |
| `connection.keys[].validUntil` | `string \| null` | ISO-8601, or `null` while open-ended. Set only by the expire route |
| `connection.keys[].revokedAt` | `string \| null` | ISO-8601, or `null`. Revocation ignores `validUntil` and takes effect immediately |
| `connection.createdAt` | `string` | ISO-8601. When the connection was registered |
| `connection.updatedAt` | `string` | ISO-8601. When the row last changed |

`connection` is the stored row as the CLI decoded it, so every date arrives as an ISO-8601 string rather than the ms-epoch SQLite holds.

```
$ pithy dashboard disconnect --env prod --yes --json
{"command":"dashboard.disconnect","environment":"prod","connectionId":"b6a1f0c2-…","removed":true,"dashboardNotified":true}
```

| key | type | meaning |
|---|---|---|
| `command` | `"dashboard.disconnect"` | The subcommand that produced the line |
| `environment` | `string` | The environment revoked |
| `connectionId` | `string \| null` | The connection that was removed, or `null` when there was nothing registered |
| `removed` | `boolean` | Whether a row was deleted. `false` on a re-run, which is not an error |
| `dashboardNotified` | `boolean` | Whether the management client was successfully told. Never gates the revocation — `--local` makes it `false` by choice |
| `detail` | `string` | Why the management client was not told, when it was not. Absent otherwise |

```
$ pithy dashboard status --env prod --json
{"command":"dashboard.status","environment":"prod","connected":true,"connectionId":"b6a1f0c2-…","issuer":"https://app.pithy.sh","workerUrl":"https://api.example.com","scopes":["manifest:read"],"keys":[{"keyId":"cpk_2026_07","live":true,"ageDays":35,"validFrom":"2026-07-01T09:00:00.000Z","validUntil":null,"revokedAt":null}],"status":"unverified"}
```

| key | type | meaning |
|---|---|---|
| `command` | `"dashboard.status"` | The subcommand that produced the line |
| `environment` | `string` | The environment inspected |
| `connected` | `boolean` | Whether anything is registered at all. `false` is the shipped, denying state |
| `connectionId` | `string \| null` | The connection's id, or `null` when nothing is registered |
| `issuer` | `string \| null` | The management-client origin this connection trusts |
| `workerUrl` | `string \| null` | The Worker URL the management client calls |
| `scopes` | `string[]` | The operations granted |
| `keys` | `object[]` | Every registered key, live and superseded, in stored order |
| `keys[].keyId` | `string` | The key's id, as a token's `kid` names it |
| `keys[].live` | `boolean` | Whether this key may verify a call right now |
| `keys[].ageDays` | `number` | Whole days since the key became valid — the number a rotation policy is read against |
| `keys[].validFrom` | `string` | ISO-8601. When the key became valid |
| `keys[].validUntil` | `string \| null` | ISO-8601, or `null` while open-ended |
| `keys[].revokedAt` | `string \| null` | ISO-8601, or `null` |
| `status` | `"connected" \| "needs_reconnect" \| "unverified"` | `unverified` unless `--verify` was passed. Status never claims a round-trip it did not make |
| `detail` | `string` | Operator-facing context from the probe. Absent otherwise |

## Errors

Each one is a `PithyError` — the problem, then the action. Under `--json` they arrive on stderr as `{"error":{…}}`, and the process exits 1. A `needs_reconnect` is **not** an error: the registration succeeded, the round-trip did not, and the command reports both and exits 0.

**No Worker resolves the database.** Every subcommand opens the registry, so this is the one door the check sits behind.

```
No worker resolves the DB binding for this environment.
Add the DB d1_databases binding to a worker's wrangler.jsonc, or pass --worker to name one.
```

**Nothing is connected.** `rotate` against an environment with no registration raises `controlplane/not_connected`, whose action names `pithy dashboard connect --env <environment>`.

**`--public-key` without `--issuer`.** The issuer is compared on every call, so there is no default to fall back on.

```
--public-key needs --issuer.
Pass --issuer https://<your-client> — it is the iss every one of your tokens must carry.
```

**`--issuer` or `--key-id` without `--public-key`.** Both are refused rather than ignored: on the dashboard path the client mints the keypair and returns the issuer, so either flag would be a value nothing reads.

**`--update` with nothing to update.**

```
Nothing to update.
Pass --worker-url, --scope, or both.
```

**A public key that is not an Ed25519 JWK.** A file that is not JSON, a P-256 key, and a private key carrying a `d` component are each refused here rather than written into your authorization row. A key with no id — no `--key-id` and no `kid` — is refused too: every token names its key in the `kid` header, and a key nobody can address is a key nobody can use.

**The management client asked for more than you granted.** Nothing is registered.

```
The management client asked for more access than you granted.
Nothing was registered. Re-run the connect, and report this to whoever operates that client.
```

**The sign-in request expired.** The device-code flow polls until the authorization's own expiry and then stops rather than running forever.

**The origin could not be reached.** A transport failure names the origin and says which of "it answered nothing" and "it answered wrongly" happened, so `--origin` is only suggested where re-checking it would help.

**An illegal `--env`.** Validated at the flag.

## Examples

Connect production, choosing the grant at a terminal.

```
$ pithy dashboard connect --env prod
acme-api → https://api.example.com/control-plane (declared in pithy.config.ts)
Open <the client's verification uri> and enter WXYZ-1234.
▸ Waiting for approval...
Connected prod.
Connection  b6a1f0c2-…
Issuer      https://app.pithy.sh
Worker      https://api.example.com
Scopes      manifest:read, keys:rotate, auth:users:read, audit:events:read, audit:events:read_detail, email:jobs:read, email:suppressions:read
Key         cpk_2026_07
Done.
```

The reads come from what that Worker composes. `email:jobs:retry` and `auth:sessions:revoke` are declared on the same capabilities and are not there — they are writes.

Re-point a connection after a custom domain moved.

```
$ pithy dashboard connect --env prod --update --worker-url https://api.example.com
```

Register a key you generated, against your own management client.

```
$ pithy dashboard connect --env prod --public-key ./client.jwk.json --issuer https://admin.example.com --scope manifest:read
```

Rotate, and read the line that is the point of the command.

```
$ pithy dashboard rotate --env prod
Rotated prod. New key cpk_2026_08.
cpk_2026_07 is still live. Expire it from your management client once it has proven cpk_2026_08.
Done.
```

Pull one leaked key, headlessly.

```
$ pithy dashboard revoke-key --env prod --key-id cpk_2026_07 --yes
```

Look at what is registered, then prove it still answers.

```
$ pithy dashboard status --env prod
$ pithy dashboard status --env prod --verify
```

Revoke everything without asking the management client for anything.

```
$ pithy dashboard disconnect --env prod --yes --local
```

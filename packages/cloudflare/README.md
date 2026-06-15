# @pithy-sh/cloudflare

One encapsulated client for every out-of-Worker Cloudflare operation.

## Bindings vs REST

Inside a Worker, use bindings — `env.DB`, `env.SESSIONS`, the Email binding. They are faster,
cheaper, need no token, and keep data in the user's account.

Outside a Worker — the CLI, CI, provisioning, the control-plane orchestrator — there are no
bindings. Remote `pithy migrate`, ephemeral-environment and worktree provisioning, secrets-store
and Turnstile management all reach Cloudflare over the REST API. This package is that client. It
wraps the official `cloudflare` SDK, falls back to raw `fetch` for the few endpoints the SDK does
not type yet, and is the **only** place Pithy talks to the CF API. Never hand-roll `fetch` to the
CF API elsewhere.

It is REST-only. It does not accept Worker bindings — that is what bindings are for.

## Configuration

Every manager is configured with a scoped API token and the account it targets:

```ts
import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";

const cf = new CloudflareClients({
  apiToken: process.env.CF_API_TOKEN!,
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
});
```

`CloudflareClients` is the entry point. It constructs and memoizes managers on demand:
resource-scoped managers (KV, D1, queues, Vectorize indexes, secret stores, hostname zones, R2
buckets) are keyed by resource id; account-scoped managers (AI, Images, Stream, Workers, Builds,
Turnstile) are singletons. You can also construct any manager directly.

## Managers

### KV

```ts
const kv = cf.kv("namespace-id");
await kv.set("auth:session:abc", JSON.stringify(session), { expirationTtl: 3600 });
const raw = await kv.get("auth:session:abc");
```

### D1 — also a Kysely dialect

The D1 manager `implements D1Database`, so it backs a Kysely `D1Dialect` (kysely-d1). The same
query builder a Worker runs against a binding runs from a CLI/CI context against D1 over REST —
this is what `pithy migrate` uses.

```ts
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";

const db = new Kysely<Schema>({ dialect: new D1Dialect({ database: cf.d1("database-id") }) });
const users = await db.selectFrom("users").selectAll().execute();
```

### Workers, Builds, provisioning

```ts
const workers = cf.workers();
const builds = cf.builds();
const provisioner = cf.provisioner(); // orchestrates Workers + Builds
```

### Secrets Store

```ts
const secrets = cf.secrets("store-id");
await secrets.putSecret("SIGNING_KEY", value);
```

### Turnstile

```ts
const turnstile = cf.turnstile();
const result = await turnstile.verify(token, secret);
if (!result.success) throw new Error("humanity check failed");
```

### Media — Images, Stream, R2

```ts
const images = cf.images();
const stream = cf.stream();
const r2 = cf.r2({ accessKeyId, secretAccessKey, bucketName: "assets" });
const url = await r2.createUploadUrl("path/to/object");
```

### AI and Vectorize

```ts
const ai = cf.ai();
const embeddings = await ai.generateEmbeddings("hello world");
const index = cf.vectorize("index-name");
```

### Queues and Custom Hostnames

```ts
const queue = cf.queue("queue-name");
const hostnames = cf.hostnames("zone-id");
```

## Errors

Every runtime failure is a `PithyError` (`@pithy-sh/core`), never a plain `Error`. This package
adds three `cloudflare/*` codes to the closed error union:

- `cloudflare/not_configured` — a token, account, or resource id is missing.
- `cloudflare/request_failed` — a CF REST call failed; the cause is kept in internal `detail`.
- `cloudflare/invalid_response` — a CF response did not match its expected shape.

## Testing

These are out-of-Worker REST clients, so tests mock the `cloudflare` SDK (`vi.mock("cloudflare")`)
and run in the node environment — no Miniflare. Every codec round-trips in a test.

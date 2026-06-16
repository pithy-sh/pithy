# @pithy-sh/cloudflare

One encapsulated client for every out-of-Worker Cloudflare operation.

## Bindings vs REST

Inside a Worker, use bindings — `env.DB`, `env.SESSIONS`, the Email binding. They are faster, cheaper, need no token, and keep data in the user's account.

Outside a Worker — the CLI, CI, provisioning, the control-plane orchestrator — there are no bindings. Remote `pithy migrate`, ephemeral-environment and worktree provisioning, secrets-store and Turnstile management all reach Cloudflare over the REST API. This package is that client. It wraps the official `cloudflare` SDK, falls back to raw `fetch` for the few endpoints the SDK does not type yet, and is the **only** place Pithy talks to the CF API. Never hand-roll `fetch` to the CF API elsewhere.

It is REST-only. It does not accept Worker bindings — that is what bindings are for.

## Configuration

Every manager is configured with a scoped API token and the account it targets:

```ts
import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";

const cf = new CloudflareClients({
  apiToken: process.env.CLOUDFLARE_API_TOKEN!,
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
});
```

`CloudflareClients` is the entry point. It constructs and memoizes managers on demand: resource-scoped managers (KV, D1, queues, Vectorize indexes, secret stores, hostname zones, R2 buckets) are keyed by resource id; account-scoped managers (AI, Images, Stream, Workers, Builds, Turnstile) are singletons. You can also construct any manager directly.

## Managers

### KV

```ts
const kv = cf.kv("namespace-id");
await kv.set("auth:session:abc", JSON.stringify(session), { expirationTtl: 3600 });
const raw = await kv.get("auth:session:abc");
```

### D1 — also a Kysely dialect

The D1 manager `implements D1Database`, so it backs a Kysely `D1Dialect` (kysely-d1). The same query builder a Worker runs against a binding runs from a CLI/CI context against D1 over REST — this is what `pithy migrate` uses.

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

Every runtime failure is a `PithyError` (`@pithy-sh/core`), never a plain `Error`. This package adds three `cloudflare/*` codes to the closed error union:

- `cloudflare/not_configured` — a token, account, or resource id is missing.
- `cloudflare/request_failed` — a CF REST call failed; the cause is kept in internal `detail`.
- `cloudflare/invalid_response` — a CF response did not match its expected shape.

## Testing

These are out-of-Worker REST clients, so tests mock the `cloudflare` SDK (`vi.mock("cloudflare")`) and run in the node environment — no Miniflare. Every codec round-trips in a test.

## Live integration tests

Mocks prove our call *shapes*. They cannot prove the request, the response decoding, and the error handling are functionally correct against real Cloudflare — that only surfaces live. So every manager that makes real CF calls also has a `*.integration.test.ts` that creates a throwaway resource, exercises the manager against it, and tears it down. These are excluded from the default suite and run via `bun run test:integration` (the `vitest.integration.config.ts` project), gated on credentials so they skip cleanly without them.

Run them locally by linking the root `.dev.vars` into the package, then running the suite:

```sh
bun run vars:local        # symlink ../../.dev.vars -> .dev.vars (git-ignored)
bun run test:integration  # against the account in those creds; CI overlays process.env instead
```

Point them at a **dedicated test account** — they create and delete real resources.

### The pattern

`src/test-utils/harness.ts` carries the shared scaffolding so each test does not re-derive it:

- `loadIntegrationCreds()` — reads `CLOUDFLARE_*` from `.dev.vars` (or `process.env`) and returns `hasCreds`. Gate the suite with `describe.skipIf(!creds.hasCreds)`.
- `uniqueName(prefix?)` — a collision-proof, lowercase `a-z0-9-` name for the throwaway resource.
- `withThrowawayResource(create, exercise, teardown)` — runs `exercise`, then **guarantees `teardown` in a `finally`** so a failed assertion never orphans a real resource. `create` runs outside the `try`, so a creation failure never tears down something that was never created.

Each test asserts the three things mocks cannot: a happy-path request succeeds, the response decodes to the expected shape, and at least one error/absent path behaves correctly (surfaced as our typed result or a `PithyError`).

`src/kv/kvManager.integration.test.ts` is the reference — copy it. The KV namespace itself is created and deleted with the raw SDK (the manager addresses an existing namespace by id), so namespace lifecycle is the harness's `create`/`teardown`:

```ts
const creds = loadIntegrationCreds();

describe.skipIf(!creds.hasCreds)("CloudflareKVManager — LIVE", () => {
  const client = new Cloudflare({ apiToken: creds.apiToken });

  test("round-trips a key, then reads an absent key as null", async () => {
    await withThrowawayResource(
      () => client.kv.namespaces.create({ account_id: creds.accountId, title: uniqueName("pithy-int-kv") }),
      async (namespace) => {
        const kv = new CloudflareKVManager({ accountId: creds.accountId, apiToken: creds.apiToken, namespaceId: namespace.id });
        expect(await kv.validateServiceAccess()).toBe(true);     // happy path
        await kv.set("greeting", "hello");
        expect(await kv.get("greeting")).toBe("hello");          // decoded shape
        await kv.delete("greeting");
        expect(await kv.get("greeting")).toBeNull();             // absent path: 404 -> null
      },
      (namespace) => client.kv.namespaces.delete(namespace.id, { account_id: creds.accountId }).then(() => undefined),
    );
  });
});
```

This reference landed first to lock the template; the remaining managers each copy it as their own reviewed slice under [#39](https://github.com/pithy-sh/pithy/issues/39).

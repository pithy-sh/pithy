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

### Media — Images, Stream

```ts
const images = cf.images();
const stream = cf.stream();
```

### R2

R2 is its own capability (`src/r2/`). It speaks the S3 protocol, so it signs presigned URLs with an S3 access-key/secret pair — distinct from the CF API token, and validated through the `R2Credentials` Zod schema. `CloudflareR2Provisioner` handles bucket lifecycle; `CloudflareR2Manager` handles objects.

A presigned PUT signs the content type and byte count, so the client must send exactly those. Presigned URLs last an hour unless `expiresIn` says otherwise.

```ts
const r2 = cf.r2({ accessKeyId, secretAccessKey, bucketName: "assets" });
const url = await r2.createUploadUrl("path/to/object", "image/png", 4096);
const download = await r2.createDownloadUrl("path/to/object", { expiresIn: 300 });
```

Large uploads go multipart. Only the part upload is presigned — the client never opens, completes or aborts an upload, and never sees the credentials.

```ts
const uploadId = await r2.createMultipartUpload("path/to/video", "video/mp4");
const partUrl = await r2.presignUploadPart("path/to/video", uploadId, 1);
// …the client PUTs its bytes to partUrl and reports back the ETag header…
await r2.completeMultipartUpload("path/to/video", uploadId, [{ partNumber: 1, etag }]);
```

`listParts` makes an interrupted upload resumable — ask which parts landed, re-send the rest. `abortMultipartUpload` discards one, and is idempotent so a sweep can re-run. Objects themselves are read and moved server-side with `headObject` (`null` when absent), `listObjects` (one page plus a `cursor`), `copyObject` and `deleteObject`.

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

Most managers need only `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`. A few need more, and skip cleanly without it:

- **R2** signs presigned URLs with S3 keys, not the CF token. Put them in `.dev.vars` as `R2_CREDENTIALS={"accessKeyId":"…","secretAccessKey":"…"}`; the R2 suite skips when absent.
- **Secrets Store** reuses the store in `SECRETS_STORE_ID`.
- **Images** and **Stream** consume paid quota — an account with them merely *enabled* (limit 0) rejects every upload/reservation. Those suites are additionally gated behind `PITHY_IMAGES_PAID=1` / `PITHY_STREAM_PAID=1`; set them only on an account with quota.
- **Builds** needs a git repo connected via OAuth (not automatable headlessly) — tracked as a separate follow-up issue, not covered here.

### The pattern

`src/test-utils/harness.ts` carries the shared scaffolding so each test does not re-derive it:

- `loadIntegrationCreds()` — reads `CLOUDFLARE_*` from `.dev.vars` (or `process.env`) and returns `hasCreds`. Gate the suite with `describe.skipIf(!creds.hasCreds)`.
- `uniqueName(label)` — a collision-proof, lowercase `a-z0-9-` name for the throwaway resource. The label is the distinguishing part only (`"kv"`, `"d1"`); the harness composes the reserved `pithy-int-` prefix and the timestamp the reaper reads. A label that already carries the prefix is **refused**, so pass `uniqueName("kv")`, never `uniqueName("pithy-int-kv")`.
- `withThrowawayResource(create, exercise, teardown)` — runs `exercise`, then **guarantees `teardown` in a `finally`** so a failed assertion never orphans a real resource. `create` runs outside the `try`, so a creation failure never tears down something that was never created.
- `withNamedResource(name, create, exercise, teardown)` — the same guarantee for a **named write** (`putSecret(name, …)`, `createBucket(name)`), where a rejected `create` may still have landed. Teardown is armed before `create` runs and addresses the name, so pass an idempotent delete.
- `reapStaleTestResources(kind)` — deletes debris of one kind an earlier crashed run left behind. You rarely call this directly: `src/test-utils/reap.ts` registers every kind and each `vitest.integration.config.ts` sweeps once per run via `globalSetup`. Add a kind there rather than a `beforeAll` to your suite — a hook inside a `describe.skipIf` does not run when the suite skips, which gated each reaper on the very credential whose absence lets debris pile up.

`pithy-int-` is reserved on any account: everything a live test creates is inside it, `pithy init` refuses a project name that would land in it, and the reaper deletes nothing outside it. See [`docs/NAMING.md`](../../docs/NAMING.md). When the resource names are themselves under test, provision under the reserved project `RESERVED_TEST_PROJECT` rather than inventing a name — the project segment comes first and verbatim, so every name the product composes lands in the namespace too.

Each test asserts the three things mocks cannot: a happy-path request succeeds, the response decodes to the expected shape, and at least one error/absent path behaves correctly (surfaced as our typed result or a `PithyError`).

`src/kv/kvManager.integration.test.ts` is the reference — copy it. The KV namespace itself is created and deleted with the raw SDK (the manager addresses an existing namespace by id), so namespace lifecycle is the harness's `create`/`teardown`:

```ts
const creds = loadIntegrationCreds();

describe.skipIf(!creds.hasCreds)("CloudflareKVManager — LIVE", () => {
  const client = new Cloudflare({ apiToken: creds.apiToken });

  test("round-trips a key, then reads an absent key as null", async () => {
    await withThrowawayResource(
      () => client.kv.namespaces.create({ account_id: creds.accountId, title: uniqueName("kv") }),
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

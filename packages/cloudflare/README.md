# @pithy-sh/cloudflare

One encapsulated client for every out-of-Worker Cloudflare operation.

Inside a Worker you use bindings. Outside one — the CLI, CI, provisioning, anything on Node or Bun — and for the control-plane operations a binding cannot do, you use this. Never both, and never a hand-rolled `fetch` to the Cloudflare API.

```sh
bun add @pithy-sh/cloudflare
```

It is a library rather than a capability, so it has no `pithy add`. Every capability that provisions anything depends on it already.

**Documentation: [pithy.sh/docs/core-concepts/bindings-or-rest](https://pithy.sh/docs/core-concepts/bindings-or-rest).** Which of the two a given operation takes, and why the rule is absolute. The package list is at [pithy.sh/docs/reference/packages](https://pithy.sh/docs/reference/packages).

_Everything on the adopter side is on the site. `pithy.sh/docs` is canonical — new adopter prose goes there, not here._

## Live integration tests

Mocks prove our call *shapes*. They cannot prove the request, the response decoding, and the error handling are functionally correct against real Cloudflare — that only surfaces live. So every manager that makes real CF calls also has a `*.integration.test.ts` that creates a throwaway resource, exercises the manager against it, and tears it down. These are excluded from the default suite and run via `bun run test:integration` (the `vitest.integration.config.ts` project), gated on credentials so they skip cleanly without them.

Credentials come from `packages/cloudflare/.dev.vars`, with `process.env` overlaid per key for anything the file does not set (`loadCloudflareEnv`). **Nothing creates that file.** It used to be a symlink to the root's, wired by a `vars:local` task; #154 removed both, and `pithy dev` and `pithy seed` generate `apps/<worker>/.dev.vars` in an adopter's project — `apps/` is the registry, so nothing regenerates a file in a kit package. Write it, or export the variables:

```sh
cat > .dev.vars <<'EOF'          # a real file, in this package, git-ignored
CLOUDFLARE_ACCOUNT_ID=…
CLOUDFLARE_API_TOKEN=…
EOF
bun run test:integration         # against the account in those creds
```

Exporting them instead works identically and is how CI runs — the workflow sets `CLOUDFLARE_*` and `SECRETS_STORE_ID` from the `E2E Integration Testing` environment with no `.dev.vars` present. Set a key in both places and the file wins.

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

**This section stays here.** It is for whoever is working on this package, not for an adopter — the site documents the kit, and a contributor's test harness has no page on it. `src/test-utils/harness.ts`, `src/kv/kvManager.integration.test.ts` and `src/d1/d1Provisioner.integration.test.ts` each point a reader at it by name.

## License

MIT — adopter-side app value. The root `LICENSE` covers it.

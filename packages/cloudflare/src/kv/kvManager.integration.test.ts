import { Cloudflare } from "cloudflare";
import { beforeAll, describe, expect, test } from "vitest";
import { loadIntegrationCreds, reapStaleTestResources, uniqueName, withThrowawayResource } from "../test-utils/harness";
import { CloudflareKVManager } from "./kvManager";

/**
 * LIVE integration test — the reference for the pattern every other `*.integration.test.ts` copies
 * (see `README.md` § "Live integration tests"). Creates a real KV namespace, exercises the manager
 * against it, and tears the namespace down in a guaranteed `finally`. Reads creds from the package
 * `.dev.vars` (symlink via `bun run vars:local`) or `process.env`; skipped when absent. Run via
 * `bun run test:integration`.
 *
 * It asserts the three things every live test must: a happy-path request succeeds, the response
 * decodes to the expected shape, and an error/absent path behaves correctly (a deleted key reads
 * back as `null` — the 404 → null translation — not a thrown `request_failed`).
 */
const creds = loadIntegrationCreds();

describe.skipIf(!creds.hasCreds)("CloudflareKVManager — LIVE", () => {
  // The namespace itself is created/deleted with the raw SDK: the manager addresses an existing
  // namespace by id, so namespace lifecycle is the harness's `create`/`teardown`, not the manager's.
  const client = new Cloudflare({ apiToken: creds.apiToken });

  // A run killed before its `finally` orphans the namespace. One such run left `pithy-int-kv-…` on a real
  // account alongside a Vectorize index from the same aborted invocation, so this is not hypothetical.
  // KV lists namespaces by title and deletes by id, so the reaper maps one to the other.
  beforeAll(async () => {
    const byTitle = new Map<string, string>();
    await reapStaleTestResources({
      label: "KV namespace",
      list: async () => {
        byTitle.clear();
        for await (const namespace of client.kv.namespaces.list({ account_id: creds.accountId })) {
          byTitle.set(namespace.title, namespace.id);
        }
        return [...byTitle.keys()];
      },
      remove: async (title) => {
        const id = byTitle.get(title);
        if (id) await client.kv.namespaces.delete(id, { account_id: creds.accountId });
      },
    });
  });

  test("creates a namespace, round-trips a key with metadata, then reads an absent key as null", async () => {
    await withThrowawayResource(
      () => client.kv.namespaces.create({ account_id: creds.accountId, title: uniqueName("pithy-int-kv") }),
      async (namespace) => {
        const kv = new CloudflareKVManager({
          accountId: creds.accountId,
          apiToken: creds.apiToken,
          namespaceId: namespace.id,
        });

        // Happy path: the namespace is reachable.
        expect(await kv.validateServiceAccess()).toBe(true);

        // Round-trip a value with metadata, then read both back — the decoded response shape.
        await kv.set("greeting", "hello", { metadata: { lang: "en" } });
        expect(await kv.get("greeting")).toBe("hello");

        const withMetadata = await kv.getWithMetadata<{ lang: string }>("greeting");
        expect(withMetadata.value).toBe("hello");
        expect(withMetadata.metadata).toEqual({ lang: "en" });

        // A key written without metadata reads back value + null metadata — the real API's no-metadata
        // path, which the stricter "only 404 → null" metadata catch must treat as absent, not an error.
        await kv.set("plain", "no-meta");
        const plain = await kv.getWithMetadata("plain");
        expect(plain.value).toBe("no-meta");
        expect(plain.metadata).toBeNull();

        // listKeys decodes to an array of key records (its enumeration is eventually consistent, so we
        // assert the decoded shape, not the just-written key's immediate presence).
        expect(Array.isArray(await kv.listKeys())).toBe(true);

        // Error/absent path: a deleted key reads back as null (404 → null), never a thrown error.
        await kv.delete("greeting");
        expect(await kv.get("greeting")).toBeNull();
      },
      (namespace) => client.kv.namespaces.delete(namespace.id, { account_id: creds.accountId }).then(() => undefined),
    );
  });
});

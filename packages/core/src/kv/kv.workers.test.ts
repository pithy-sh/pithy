import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { createLogger } from "../logger/logger";
import type { LogRecord } from "../logger/record";
import { KV_METADATA_MAX_BYTES, kvMetadata, TypedKv } from "./kv";

// A capability value with a two-segment key: assets:<assetType>:<uuid>.
const Asset = z
  .object({
    url: z.string().describe("Where the asset bytes live."),
    bytes: z.number().describe("Size of the asset in bytes."),
  })
  .describe("An asset record stored in KV for the test.");

// Small, list-time fields — size-bounded by kvMetadata.
const AssetMeta = kvMetadata(
  z
    .object({
      status: z.enum(["pending", "ready"]).describe("Processing status."),
    })
    .describe("List-time metadata for an asset."),
);

const AssetKey = z
  .object({
    assetType: z.enum(["photo", "doc"]).describe("Asset category — first key segment."),
    uuid: z.uuid().describe("Asset id — second key segment."),
  })
  .describe("The ordered key segments for an asset.");

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

function assets() {
  return new TypedKv(env.SESSIONS, {
    prefix: "assets",
    key: AssetKey,
    value: Asset,
    metadata: AssetMeta,
  });
}

// A protected store: metadata is derived from the value (the source of truth).
function protectedAssets() {
  return new TypedKv(env.SESSIONS, {
    prefix: "assets",
    key: AssetKey,
    value: Asset,
    metadata: AssetMeta,
    deriveMetadata: (value) => ({ status: value.bytes > 0 ? ("ready" as const) : ("pending" as const) }),
  });
}

beforeEach(async () => {
  // Clear every key the suite touches (KV persists across tests in the isolate).
  const { keys } = await env.SESSIONS.list({ prefix: "assets:" });
  await Promise.all(keys.map((k) => env.SESSIONS.delete(k.name)));
});

describe("TypedKv — structured keys", () => {
  test("builds an ordered, namespaced key (name) from validated segments", () => {
    const kv = assets();
    expect(kv.name({ assetType: "photo", uuid: UUID_A })).toBe(`assets:photo:${UUID_A}`);
  });

  test("rejects an invalid key segment", () => {
    const kv = assets();
    // Not a uuid.
    expect(() => kv.name({ assetType: "photo", uuid: "nope" })).toThrow();
  });

  test("put stores under the namespaced key; get parses it back", async () => {
    const kv = assets();
    const value = { url: "https://x/y.jpg", bytes: 42 };
    await kv.put({ assetType: "photo", uuid: UUID_A }, value);

    const raw = await env.SESSIONS.get(`assets:photo:${UUID_A}`, "text");
    expect(raw).toBe(JSON.stringify(value));
    expect(await kv.get({ assetType: "photo", uuid: UUID_A })).toEqual(value);
  });

  test("get returns null on a miss", async () => {
    const kv = assets();
    expect(await kv.get({ assetType: "doc", uuid: UUID_B })).toBeNull();
  });

  test("put rejects an invalid value before writing", async () => {
    const kv = assets();
    await expect(kv.put({ assetType: "photo", uuid: UUID_A }, { url: "x", bytes: "big" } as never)).rejects.toThrow();
    expect(await env.SESSIONS.get(`assets:photo:${UUID_A}`, "text")).toBeNull();
  });

  test("get validates stored data, rejecting a corrupt value", async () => {
    const kv = assets();
    await env.SESSIONS.put(`assets:photo:${UUID_A}`, JSON.stringify({ url: "x" }));
    await expect(kv.get({ assetType: "photo", uuid: UUID_A })).rejects.toThrow();
  });

  test("delete removes the value", async () => {
    const kv = assets();
    await kv.put({ assetType: "photo", uuid: UUID_A }, { url: "x", bytes: 1 });
    await kv.delete({ assetType: "photo", uuid: UUID_A });
    expect(await kv.get({ assetType: "photo", uuid: UUID_A })).toBeNull();
  });
});

describe("TypedKv — patch (partial update)", () => {
  test("merges changes over the current value and persists them", async () => {
    const kv = assets();
    await kv.put({ assetType: "photo", uuid: UUID_A }, { url: "x", bytes: 1 });

    const merged = await kv.patch({ assetType: "photo", uuid: UUID_A }, { bytes: 99 });
    expect(merged).toEqual({ url: "x", bytes: 99 }); // url preserved, bytes updated
    expect(await kv.get({ assetType: "photo", uuid: UUID_A })).toEqual({ url: "x", bytes: 99 });
  });

  test("validates the merged result", async () => {
    const kv = assets();
    await kv.put({ assetType: "photo", uuid: UUID_A }, { url: "x", bytes: 1 });
    await expect(kv.patch({ assetType: "photo", uuid: UUID_A }, { bytes: "big" } as never)).rejects.toThrow();
  });

  test("throws when the key does not exist", async () => {
    const kv = assets();
    await expect(kv.patch({ assetType: "doc", uuid: UUID_B }, { bytes: 1 })).rejects.toThrow(/no value to update/);
  });

  test("recomputes derived metadata from the merged value", async () => {
    const kv = protectedAssets();
    await kv.put({ assetType: "photo", uuid: UUID_A }, { url: "x", bytes: 0 }); // derives status: pending
    expect((await kv.getWithMetadata({ assetType: "photo", uuid: UUID_A }))?.metadata).toEqual({ status: "pending" });

    await kv.patch({ assetType: "photo", uuid: UUID_A }, { bytes: 5 }); // now > 0 → ready
    expect((await kv.getWithMetadata({ assetType: "photo", uuid: UUID_A }))?.metadata).toEqual({ status: "ready" });
  });

  test("preserves explicit metadata across a patch", async () => {
    const kv = assets();
    await kv.put({ assetType: "photo", uuid: UUID_A }, { url: "x", bytes: 1 }, { metadata: { status: "pending" } });

    await kv.patch({ assetType: "photo", uuid: UUID_A }, { bytes: 2 });
    const after = await kv.getWithMetadata({ assetType: "photo", uuid: UUID_A });
    expect(after?.value).toEqual({ url: "x", bytes: 2 });
    expect(after?.metadata).toEqual({ status: "pending" }); // metadata not dropped
  });
});

describe("TypedKv — metadata", () => {
  test("put stores metadata; getWithMetadata and list return it validated", async () => {
    const kv = assets();
    await kv.put({ assetType: "photo", uuid: UUID_A }, { url: "x", bytes: 1 }, { metadata: { status: "ready" } });

    const withMeta = await kv.getWithMetadata({ assetType: "photo", uuid: UUID_A });
    expect(withMeta?.value).toEqual({ url: "x", bytes: 1 });
    expect(withMeta?.metadata).toEqual({ status: "ready" });
  });

  test("put rejects invalid metadata", async () => {
    const kv = assets();
    await expect(
      kv.put({ assetType: "photo", uuid: UUID_A }, { url: "x", bytes: 1 }, { metadata: { status: "bogus" } as never }),
    ).rejects.toThrow();
  });

  test("kvMetadata rejects oversized metadata", () => {
    const Big = kvMetadata(z.object({ blob: z.string().describe("A big string.") }).describe("Oversized metadata."));
    const overLimit = "x".repeat(KV_METADATA_MAX_BYTES + 1);
    expect(() => Big.parse({ blob: overLimit })).toThrow();
  });
});

describe("TypedKv — derived / protected metadata", () => {
  test("put derives metadata from the value without an explicit metadata arg", async () => {
    const kv = protectedAssets();
    await kv.put({ assetType: "photo", uuid: UUID_A }, { url: "x", bytes: 10 });

    const withMeta = await kv.getWithMetadata({ assetType: "photo", uuid: UUID_A });
    expect(withMeta?.metadata).toEqual({ status: "ready" });

    // The metadata was actually stored, derived from the value.
    const { metadata } = await env.SESSIONS.getWithMetadata(`assets:photo:${UUID_A}`, "text");
    expect(metadata).toEqual({ status: "ready" });
  });

  test("list rebuilds metadata an external edit dropped, and persists it", async () => {
    const kv = protectedAssets();
    const name = `assets:photo:${UUID_A}`;

    // Simulate a Cloudflare dashboard hand-edit: value rewritten, metadata gone.
    await env.SESSIONS.put(name, JSON.stringify({ url: "x", bytes: 5 }));
    expect((await env.SESSIONS.getWithMetadata(name, "text")).metadata).toBeNull();

    // list self-heals the missing metadata from the value.
    const { keys } = await kv.list({ prefix: { assetType: "photo" } });
    expect(keys.find((k) => k.name === name)?.metadata).toEqual({ status: "ready" });

    // And it was written back, so a later read sees it too.
    expect((await env.SESSIONS.getWithMetadata(name, "text")).metadata).toEqual({ status: "ready" });
  });

  test("a failed self-heal write-back is non-fatal and routes through the logger", async () => {
    const name = `assets:photo:${UUID_A}`;
    // A namespace that reads real but fails the write-back — forces the self-heal put to throw.
    // Methods bind to the real namespace (native KV rejects a rebound `this`); only `put` is overridden.
    const failingPut = {
      get: (...args: Parameters<typeof env.SESSIONS.get>) => env.SESSIONS.get(...args),
      getWithMetadata: (...args: Parameters<typeof env.SESSIONS.getWithMetadata>) =>
        env.SESSIONS.getWithMetadata(...args),
      list: (...args: Parameters<typeof env.SESSIONS.list>) => env.SESSIONS.list(...args),
      delete: (...args: Parameters<typeof env.SESSIONS.delete>) => env.SESSIONS.delete(...args),
      put: () => Promise.reject(new Error("KV PUT 429")),
    } as unknown as typeof env.SESSIONS;

    const records: LogRecord[] = [];
    const kv = new TypedKv(
      failingPut,
      {
        prefix: "assets",
        key: AssetKey,
        value: Asset,
        metadata: AssetMeta,
        deriveMetadata: (v) => ({ status: v.bytes > 0 ? ("ready" as const) : ("pending" as const) }),
      },
      { logger: createLogger({ level: "debug", sink: (r) => records.push(r) }) },
    );

    await env.SESSIONS.put(name, JSON.stringify({ url: "x", bytes: 5 }));

    // The list still returns healed metadata despite the write-back failure.
    const { keys } = await kv.list({ prefix: { assetType: "photo" } });
    expect(keys.find((k) => k.name === name)?.metadata).toEqual({ status: "ready" });

    // And the failure was observed, not swallowed — one warn record naming the key.
    const warned = records.find((r) => r.level === "warn" && r.msg.includes("heal write-back"));
    expect(warned?.fields).toMatchObject({ key: name });
    expect(warned?.fields?.detail).toContain("KV PUT 429");
  });

  test("list leaves metadata null when not configured for derivation", async () => {
    const kv = assets(); // no deriveMetadata
    const name = `assets:photo:${UUID_A}`;
    await env.SESSIONS.put(name, JSON.stringify({ url: "x", bytes: 5 }));

    const { keys } = await kv.list({ prefix: { assetType: "photo" } });
    expect(keys.find((k) => k.name === name)?.metadata).toBeNull();
  });

  test("list does not write or throw when derive yields no metadata", async () => {
    // A derive that can't produce metadata for some value (typed away).
    const kv = new TypedKv(env.SESSIONS, {
      prefix: "assets",
      key: AssetKey,
      value: Asset,
      metadata: AssetMeta,
      deriveMetadata: () => undefined as unknown as { status: "ready" | "pending" },
    });
    const name = `assets:photo:${UUID_A}`;
    await env.SESSIONS.put(name, JSON.stringify({ url: "x", bytes: 5 }));

    const { keys } = await kv.list({ prefix: { assetType: "photo" } });
    expect(keys.find((k) => k.name === name)?.metadata).toBeNull();
    // Nothing was written back — no thrash.
    expect((await env.SESSIONS.getWithMetadata(name, "text")).metadata).toBeNull();
  });
});

describe("TypedKv — list over a prefix range", () => {
  beforeEach(async () => {
    const kv = assets();
    await kv.put({ assetType: "photo", uuid: UUID_A }, { url: "a", bytes: 1 }, { metadata: { status: "ready" } });
    await kv.put({ assetType: "photo", uuid: UUID_B }, { url: "b", bytes: 2 }, { metadata: { status: "pending" } });
    await kv.put({ assetType: "doc", uuid: UUID_A }, { url: "c", bytes: 3 }, { metadata: { status: "ready" } });
  });

  test("scopes by a leading segment and returns parsed keys + metadata", async () => {
    const kv = assets();
    const { keys, listComplete } = await kv.list({ prefix: { assetType: "photo" } });

    expect(listComplete).toBe(true);
    expect(keys).toHaveLength(2);
    expect(keys.map((k) => k.name).sort()).toEqual([`assets:photo:${UUID_A}`, `assets:photo:${UUID_B}`]);

    const a = keys.find((k) => k.name === `assets:photo:${UUID_A}`);
    expect(a?.key).toEqual({ assetType: "photo", uuid: UUID_A });
    expect(a?.metadata).toEqual({ status: "ready" });
  });

  test("lists the whole namespace when no prefix is given", async () => {
    const kv = assets();
    const { keys } = await kv.list();
    expect(keys).toHaveLength(3);
  });

  test("rejects a non-contiguous prefix", async () => {
    const kv = assets();
    // uuid without the preceding assetType is not a leading run.
    await expect(kv.list({ prefix: { uuid: UUID_A } as never })).rejects.toThrow();
  });

  test("rejects a full-key prefix, pointing at get()", async () => {
    const kv = assets();
    // All segments supplied is an exact key, not a range — that is get()'s job.
    await expect(kv.list({ prefix: { assetType: "photo", uuid: UUID_A } })).rejects.toThrow(/full key; use get/);
  });

  test("returns an empty, complete page when nothing matches", async () => {
    const kv = assets();
    await kv.delete({ assetType: "doc", uuid: UUID_A });
    const { keys, listComplete, cursor } = await kv.list({ prefix: { assetType: "doc" } });
    expect(keys).toEqual([]);
    expect(listComplete).toBe(true);
    expect(cursor).toBeUndefined();
  });

  test("paginates with limit and cursor across pages", async () => {
    const kv = assets();

    // First page: limit forces an incomplete listing with a cursor.
    const page1 = await kv.list({ limit: 2 });
    expect(page1.listComplete).toBe(false);
    expect(page1.cursor).toBeDefined();
    expect(page1.keys).toHaveLength(2);

    // Second page: resume from the cursor; the listing now completes.
    const page2 = await kv.list({ limit: 2, cursor: page1.cursor });
    expect(page2.listComplete).toBe(true);
    expect(page2.cursor).toBeUndefined();

    // Together the pages cover every key exactly once.
    const names = [...page1.keys, ...page2.keys].map((k) => k.name).sort();
    expect(names).toEqual([`assets:doc:${UUID_A}`, `assets:photo:${UUID_A}`, `assets:photo:${UUID_B}`]);
  });
});

describe("TypedKv — list resilience to external edits", () => {
  test("one entry's corrupt stored metadata does not abort the page", async () => {
    const kv = assets();
    // A good entry, and one an external writer left with invalid metadata.
    await kv.put({ assetType: "photo", uuid: UUID_B }, { url: "b", bytes: 2 }, { metadata: { status: "ready" } });
    await env.SESSIONS.put(`assets:photo:${UUID_A}`, JSON.stringify({ url: "a", bytes: 1 }), {
      metadata: { status: "archived" }, // not in the enum
    });

    const { keys } = await kv.list({ prefix: { assetType: "photo" } });
    expect(keys).toHaveLength(2); // both keys still returned — page did not throw
    expect(keys.find((k) => k.name === `assets:photo:${UUID_B}`)?.metadata).toEqual({ status: "ready" });
    expect(keys.find((k) => k.name === `assets:photo:${UUID_A}`)?.metadata).toBeNull(); // degraded, not thrown
  });

  test("one unparseable value does not abort the page in a protected store", async () => {
    const kv = protectedAssets();
    await kv.put({ assetType: "photo", uuid: UUID_A }, { url: "a", bytes: 1 });
    // External writer planted a value the schema can't parse, with no metadata.
    await env.SESSIONS.put(`assets:photo:${UUID_B}`, JSON.stringify({ not: "an asset" }));

    const { keys } = await kv.list({ prefix: { assetType: "photo" } });
    expect(keys).toHaveLength(2);
    expect(keys.find((k) => k.name === `assets:photo:${UUID_A}`)?.metadata).toEqual({ status: "ready" }); // healed
    expect(keys.find((k) => k.name === `assets:photo:${UUID_B}`)?.metadata).toBeNull(); // unhealable, but no throw
  });
});

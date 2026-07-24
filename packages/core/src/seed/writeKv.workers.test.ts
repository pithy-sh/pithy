import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { PithyError } from "../error/pithyError";
import { TypedKv } from "../kv/kv";
import { kvSeedGroup } from "./seed";
import { seedKvGroup } from "./writeKv";

const Asset = z
  .object({
    url: z.string().describe("Where the asset bytes live."),
    bytes: z.number().describe("Size of the asset in bytes."),
  })
  .describe("An asset value for the KV seed test.");

const AssetKey = z
  .object({
    uuid: z.uuid().describe("Asset id — the key segment."),
  })
  .describe("The key segments for a seeded asset.");

const spec = { prefix: "assets", key: AssetKey, value: Asset } as const;

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";

function store() {
  return new TypedKv(env.SESSIONS, spec);
}

const group = kvSeedGroup("assets", "images", spec, [
  { key: { uuid: UUID_A }, value: { url: "https://e/a", bytes: 1 } },
  { key: { uuid: UUID_B }, value: { url: "https://e/b", bytes: 2 } },
]);

async function keyCount(): Promise<number> {
  const { keys } = await env.SESSIONS.list({ prefix: "assets:" });
  return keys.length;
}

beforeEach(async () => {
  const { keys } = await env.SESSIONS.list({ prefix: "assets:" });
  await Promise.all(keys.map((k) => env.SESSIONS.delete(k.name)));
});

describe("seedKvGroup", () => {
  test("writes each entry through the typed store", async () => {
    const result = await seedKvGroup(store(), group, spec);
    expect(result).toEqual({ store: "images", entries: 2 });
    expect(await store().get({ uuid: UUID_A })).toEqual({ url: "https://e/a", bytes: 1 });
  });

  test("is idempotent — re-running re-establishes the same keys with no duplication", async () => {
    await seedKvGroup(store(), group, spec);
    await seedKvGroup(store(), group, spec);
    expect(await keyCount()).toBe(2);
  });

  test("dryRun counts but writes nothing", async () => {
    const result = await seedKvGroup(store(), group, spec, { dryRun: true });
    expect(result).toEqual({ store: "images", entries: 2 });
    expect(await keyCount()).toBe(0);
  });

  test("an invalid entry mid-group throws before any write — no entry lands", async () => {
    // [valid, invalid, valid]: entry 1's `bytes` is a string, so the value schema rejects it.
    const badGroup = {
      namespace: "assets",
      store: "images",
      entries: [
        { key: { uuid: UUID_A }, value: { url: "https://e/a", bytes: 1 } },
        { key: { uuid: UUID_B }, value: { url: "https://e/b", bytes: "two" } },
        { key: { uuid: UUID_C }, value: { url: "https://e/c", bytes: 3 } },
      ],
    } as unknown as typeof group;

    await expect(seedKvGroup(store(), badGroup, spec)).rejects.toBeInstanceOf(PithyError);
    // Whole-group pre-validation: the valid entries before and after the bad one never wrote.
    expect(await keyCount()).toBe(0);
  });

  test("never overwrites an existing key — a colliding value is preserved", async () => {
    // A live value already sits at key A (as if it belonged to another writer at the same key).
    await store().put({ uuid: UUID_A }, { url: "https://existing", bytes: 99 });

    const result = await seedKvGroup(store(), group, spec);
    expect(result).toEqual({ store: "images", entries: 2 });
    // Key A is left untouched; only the genuinely new key B is written.
    expect(await store().get({ uuid: UUID_A })).toEqual({ url: "https://existing", bytes: 99 });
    expect(await store().get({ uuid: UUID_B })).toEqual({ url: "https://e/b", bytes: 2 });
  });

  test("treats unreadable foreign data at a key as present — never overwrites it", async () => {
    // Foreign data that does not match the store schema still counts as present.
    await env.SESSIONS.put(`assets:${UUID_A}`, JSON.stringify({ unrelated: true }));

    await seedKvGroup(store(), group, spec);
    expect(await env.SESSIONS.get(`assets:${UUID_A}`)).toBe(JSON.stringify({ unrelated: true }));
    expect(await store().get({ uuid: UUID_B })).toEqual({ url: "https://e/b", bytes: 2 });
  });
});

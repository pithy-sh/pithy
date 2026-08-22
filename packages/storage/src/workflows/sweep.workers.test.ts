// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { R2Bucket } from "@cloudflare/workers-types";
import { MAX_BOUND_PARAMETERS } from "@pithy-sh/core/src/data/boundParameters";
import type { DatabaseSchema } from "@pithy-sh/core/src/data/db";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { CamelCasePlugin, Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import { beforeEach, describe, expect, test } from "vitest";
import { StorageObject, type StorageObjectStatus } from "../data/storageObject";
import { STORAGE_OBJECTS_TABLE, type StorageDatabase, type StorageTables, storageDatabase } from "../data/tables";
import { storage_0001_objects } from "../migrations/0001_objects";
import { type ObjectStore, objectStore, type PresignedObjects } from "../object/store";
import { sweepStorage } from "./sweep";

/**
 * The orphan sweep against a **deliberately divergent** bucket and table: rows with no object, objects
 * with no row, an object a row claims, an object another tool owns, and a row young enough to still be
 * in flight. Both directions of divergence are real here, in real D1 and real R2 — a fake bucket would
 * only ever confirm what the sweep already believes.
 */

const TTL_SECONDS = 3600;
const OWNER = "user-ada";

/** The multipart abort would take the S3 path, which Miniflare does not serve — record the call instead. */
const aborted: Array<{ key: string; uploadId: string }> = [];

let db: StorageDatabase;
let bucket: R2Bucket;
let store: ObjectStore;

const noPresign = (): PresignedObjects => {
  throw new Error("the sweep must reach R2 through the binding for everything but the abort");
};

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS pithy_storage_shares");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_storage_objects");
  db = storageDatabase(env.DB);
  await storage_0001_objects.up(db as unknown as Kysely<unknown>);
  bucket = env.STORAGE_BUCKET;
  for (const prefix of ["obj/", "other/"]) {
    const listing = await bucket.list({ prefix });
    for (const object of listing.objects) await bucket.delete(object.key);
  }
  aborted.length = 0;
  const real = objectStore({ bucket, env: {} as SecretsStoreEnv, presigned: noPresign });
  store = {
    ...real,
    get: (key, options) => real.get(key, options),
    head: (key) => real.head(key),
    list: (options) => real.list(options),
    delete: (key) => real.delete(key),
    abortMultipart: async (key, uploadId) => {
      aborted.push({ key, uploadId });
    },
  };
});

/**
 * Insert one row through the codec, exactly as a handler would. The id is a fresh UUID (the column is
 * one, and the schema enforces it); the **key** is what the assertions below identify a row by, since
 * the key is the join to the bucket and therefore the thing the sweep reasons about.
 */
async function insertRow(options: {
  key: string;
  status: StorageObjectStatus;
  createdAt: Date;
  uploadId?: string | null;
}): Promise<void> {
  const record = StorageObject.encode({
    id: crypto.randomUUID(),
    key: options.key,
    path: `${options.key}.bin`,
    ownerId: OWNER,
    contentType: "application/octet-stream",
    size: 4,
    visibility: "private",
    checksum: null,
    status: options.status,
    uploadId: options.uploadId ?? null,
    createdAt: options.createdAt,
    updatedAt: options.createdAt,
  });
  await db.insertInto(STORAGE_OBJECTS_TABLE).values(record).execute();
}

/**
 * The same database, wired to record how many parameters each statement bound.
 *
 * Miniflare does throw `too many SQL variables` past the cap today, but that is its SQLite build's
 * limit happening to match D1's — a runtime bump could raise it and disarm this test without anyone
 * noticing. Counting the parameters asserts the limit we actually mean, and turns an opaque
 * `SQLITE_ERROR` into a failure that names the defect.
 */
function recordingDatabase(bound: number[]): StorageDatabase {
  return new Kysely<DatabaseSchema<StorageTables>>({
    dialect: new D1Dialect({ database: env.DB }),
    plugins: [new CamelCasePlugin()],
    log: (event) => {
      if (event.level === "query") bound.push(event.query.parameters.length);
    },
  }) as unknown as StorageDatabase;
}

/** A clock past the cutoff, so everything already in the bucket counts as old enough to reconcile. */
function laterClock(): () => Date {
  const at = new Date(Date.now() + (TTL_SECONDS + 60) * 1000);
  return () => at;
}

/**
 * The same store, reporting every listed object as written long ago.
 *
 * Needed to separate the two phases' clocks. `laterClock` ages the *rows* as well as the objects, so a
 * test about a young row and an old object cannot use it — and R2's `uploaded` time is R2's to set.
 * Aging only the listing lets a row sit comfortably inside its TTL while its object is past the cutoff,
 * which is the one arrangement that tells a real claim apart from an accident of timing.
 */
function agedListingStore(): ObjectStore {
  return {
    ...store,
    list: async (options) => {
      const page = await store.list(options);
      return { ...page, objects: page.objects.map((object) => ({ ...object, uploaded: new Date(0) })) };
    },
  };
}

/** The keys still claimed by a row. */
async function remainingRowKeys(): Promise<string[]> {
  const rows = await db.selectFrom(STORAGE_OBJECTS_TABLE).select("key").orderBy("key", "asc").execute();
  return rows.map((row) => row.key);
}

/** The keys still in the bucket, under both prefixes. */
async function remainingKeys(): Promise<string[]> {
  const keys: string[] = [];
  for (const prefix of ["obj/", "other/"]) {
    const listing = await bucket.list({ prefix });
    keys.push(...listing.objects.map((object) => object.key));
  }
  return keys.sort();
}

describe("rows with no object", () => {
  test("a pending row past its TTL is aborted, its bytes dropped, and its row removed", async () => {
    const old = new Date(Date.now() - (TTL_SECONDS + 600) * 1000);
    await insertRow({ key: "obj/expired", status: "pending", createdAt: old, uploadId: "up-1" });
    // A single-PUT upload whose bytes landed but which was never completed: the row *and* the object
    // both exist, and reclaiming the row must take the object with it.
    await insertRow({ key: "obj/half", status: "pending", createdAt: old });
    await bucket.put("obj/half", "data");

    const result = await sweepStorage({ db, store, now: () => new Date(), ttlSeconds: TTL_SECONDS });

    expect(result.reclaimedRows).toBe(2);
    expect(aborted).toEqual([{ key: "obj/expired", uploadId: "up-1" }]);
    expect(await remainingRowKeys()).toEqual([]);
    expect(await remainingKeys()).toEqual([]);
  });

  test("a pending row still inside its TTL is left alone — it is an upload in progress", async () => {
    await insertRow({ key: "obj/fresh", status: "pending", createdAt: new Date(), uploadId: "up-2" });
    const result = await sweepStorage({ db, store, now: () => new Date(), ttlSeconds: TTL_SECONDS });
    expect(result.reclaimedRows).toBe(0);
    expect(aborted).toEqual([]);
    expect(await remainingRowKeys()).toEqual(["obj/fresh"]);
  });

  test("stored and failed rows are never reclaimed, however old", async () => {
    const old = new Date(Date.now() - (TTL_SECONDS + 600) * 1000);
    await insertRow({ key: "obj/stored", status: "stored", createdAt: old });
    await insertRow({ key: "obj/failed", status: "failed", createdAt: old });
    await bucket.put("obj/stored", "data");

    const result = await sweepStorage({ db, store, now: () => new Date(), ttlSeconds: TTL_SECONDS });
    expect(result.reclaimedRows).toBe(0);
    expect(await remainingRowKeys()).toEqual(["obj/failed", "obj/stored"]);
  });
});

describe("objects with no row", () => {
  test("an unclaimed object older than the cutoff is deleted", async () => {
    await bucket.put("obj/orphan", "data");
    const result = await sweepStorage({ db, store, now: laterClock(), ttlSeconds: TTL_SECONDS });
    expect(result.deletedObjects).toBe(1);
    expect(await remainingKeys()).toEqual([]);
  });

  test("an object a row claims is left alone", async () => {
    await insertRow({ key: "obj/claimed", status: "stored", createdAt: new Date() });
    await bucket.put("obj/claimed", "data");
    const result = await sweepStorage({ db, store, now: laterClock(), ttlSeconds: TTL_SECONDS });
    expect(result.deletedObjects).toBe(0);
    expect(await remainingKeys()).toEqual(["obj/claimed"]);
  });

  test("a freshly uploaded object is not an orphan — the age check turns the write race into a wait", async () => {
    await bucket.put("obj/just-landed", "data");
    // The real clock: the object was written a moment ago, well inside the cutoff.
    const result = await sweepStorage({ db, store, now: () => new Date(), ttlSeconds: TTL_SECONDS });
    expect(result.deletedObjects).toBe(0);
    expect(await remainingKeys()).toEqual(["obj/just-landed"]);
  });

  test("a failed row does not shield its key — bytes that landed after an abort are still reclaimed", async () => {
    // The abort leak, end to end. A single-PUT upload was abandoned, the row went `failed`, and the
    // client then PUT to the presigned URL it still held — a URL nothing can revoke. The row bills for
    // none of those bytes and phase one only reclaims `pending` rows, so this phase is the only thing
    // between the adopter and an unbounded R2 bill.
    await insertRow({ key: "obj/abandoned", status: "failed", createdAt: new Date() });
    await bucket.put("obj/abandoned", "data");

    const result = await sweepStorage({ db, store, now: laterClock(), ttlSeconds: TTL_SECONDS });

    expect(result.deletedObjects).toBe(1);
    expect(await remainingKeys()).toEqual([]);
    // The row itself survives: it is the owner's record that an upload was attempted and abandoned.
    // Only its claim on the bytes is withdrawn.
    expect(await remainingRowKeys()).toEqual(["obj/abandoned"]);
  });

  test("a pending row claims its key — an upload in flight is never swept out from under itself", async () => {
    // The row is young, so phase one leaves it alone; the listing is aged, so phase two considers its
    // object. A claimed set narrowed to `stored` would delete the bytes a client is still sending.
    await insertRow({ key: "obj/inflight", status: "pending", createdAt: new Date(), uploadId: "up-6" });
    await bucket.put("obj/inflight", "data");

    const result = await sweepStorage({
      db,
      store: agedListingStore(),
      now: () => new Date(),
      ttlSeconds: TTL_SECONDS,
    });

    expect(result.reclaimedRows).toBe(0);
    expect(result.deletedObjects).toBe(0);
    expect(await remainingKeys()).toEqual(["obj/inflight"]);
  });

  test("a co-tenant's objects are never considered — only this capability's own prefix is swept", async () => {
    await bucket.put("other/not-ours.bin", "data");
    const result = await sweepStorage({ db, store, now: laterClock(), ttlSeconds: TTL_SECONDS });
    expect(result.deletedObjects).toBe(0);
    expect(result.scannedObjects).toBe(0);
    expect(await remainingKeys()).toEqual(["other/not-ours.bin"]);
  });
});

describe("both directions at once", () => {
  test("one run reconciles a bucket and a table that diverged in both directions", async () => {
    const old = new Date(Date.now() - (TTL_SECONDS + 600) * 1000);
    await insertRow({ key: "obj/expired", status: "pending", createdAt: old, uploadId: "up-3" });
    await insertRow({ key: "obj/kept", status: "stored", createdAt: old });
    await bucket.put("obj/kept", "data");
    await bucket.put("obj/orphan", "data");
    await bucket.put("other/theirs.bin", "data");

    const result = await sweepStorage({ db, store, now: laterClock(), ttlSeconds: TTL_SECONDS });

    expect(result.reclaimedRows).toBe(1);
    expect(result.deletedObjects).toBe(1);
    expect(await remainingRowKeys()).toEqual(["obj/kept"]);
    expect(await remainingKeys()).toEqual(["obj/kept", "other/theirs.bin"]);
  });

  test("a second run over a reconciled store finds nothing — idempotent, so a retry is free", async () => {
    const old = new Date(Date.now() - (TTL_SECONDS + 600) * 1000);
    await insertRow({ key: "obj/expired", status: "pending", createdAt: old, uploadId: "up-4" });
    await bucket.put("obj/orphan", "data");

    await sweepStorage({ db, store, now: laterClock(), ttlSeconds: TTL_SECONDS });
    const second = await sweepStorage({ db, store, now: laterClock(), ttlSeconds: TTL_SECONDS });
    expect(second).toMatchObject({ reclaimedRows: 0, deletedObjects: 0, truncated: false });
  });
});

describe("dry run", () => {
  test("reports what it would do and changes nothing", async () => {
    const old = new Date(Date.now() - (TTL_SECONDS + 600) * 1000);
    await insertRow({ key: "obj/expired", status: "pending", createdAt: old, uploadId: "up-5" });
    await bucket.put("obj/orphan", "data");

    const result = await sweepStorage({ db, store, now: laterClock(), ttlSeconds: TTL_SECONDS, dryRun: true });

    expect(result).toMatchObject({ reclaimedRows: 1, deletedObjects: 1, dryRun: true });
    expect(aborted).toEqual([]);
    expect(await remainingRowKeys()).toEqual(["obj/expired"]);
    expect(await remainingKeys()).toEqual(["obj/orphan"]);
  });
});

describe("bounded work", () => {
  test("a page cap stops the run early and says so, rather than running until it is killed", async () => {
    for (const name of ["a", "b", "c", "d", "e"]) await bucket.put(`obj/${name}`, "data");

    const result = await sweepStorage({
      db,
      store,
      now: laterClock(),
      ttlSeconds: TTL_SECONDS,
      pageSize: 2,
      maxPages: 1,
    });

    expect(result.truncated).toBe(true);
    expect(result.scannedObjects).toBe(2);
    expect(result.deletedObjects).toBe(2);
    // The rest survive this run and are collected by the next one — the cap bounds the work, it does
    // not skip it.
    expect(await remainingKeys()).toHaveLength(3);
  });

  test("without a cap, paging walks the whole bucket in one run", async () => {
    for (const name of ["a", "b", "c", "d", "e"]) await bucket.put(`obj/${name}`, "data");

    const result = await sweepStorage({ db, store, now: laterClock(), ttlSeconds: TTL_SECONDS, pageSize: 2 });

    expect(result.truncated).toBe(false);
    expect(result.scannedObjects).toBe(5);
    expect(result.deletedObjects).toBe(5);
    expect(await remainingKeys()).toEqual([]);
  });
});

describe("D1's bound-parameter cap", () => {
  /**
   * A page of 150 candidates — past D1's cap of 100 bound parameters, and a fraction of the thousand a
   * real page carries. Every other test here passes on a handful of keys, which is exactly why the sweep
   * shipped with a membership lookup that binds one parameter per key: nothing ever had enough keys to
   * notice. This is the test the fix exists for.
   */
  const CANDIDATES = 150;

  /**
   * This test is genuinely slow, and the number says so rather than hiding it (#333).
   *
   * Measured on an idle 8-core machine, three runs: **3317ms, 3483ms, 3789ms**. With the rest of the
   * repository's suites running beside it: **4053ms**. In the run that opened #333 it reported 5468ms and
   * failed. Nothing regressed — the default 5000ms was never a cap this test's own work fitted under. It
   * puts 150 objects into R2 and inserts 150 rows into D1 before the sweep it measures even starts, and
   * 150 is not padding: D1 binds at most 100 parameters, so a page under that number proves nothing about
   * chunking at all.
   *
   * **Serial setup is the fast path, which was measured rather than assumed.** Replacing the `put` loop
   * with `Promise.all` — the obvious optimization — made it *slower*: 5392ms, 5588ms, 6190ms across three
   * idle runs, failing every time. 150 concurrent writes contend inside one workerd more than they
   * overlap. The loop stays.
   *
   * So the cost is real, it cannot be bought down, and the honest move is to state it. 15000ms is roughly
   * four times the idle cost: enough that contention never decides the outcome, tight enough that work
   * which doubled would still fail here. If this test starts reporting eight seconds on an idle machine,
   * that is a regression and these numbers are what to compare it against.
   */
  const SLOW = { timeout: 15_000 };

  test("a page past the cap is chunked, and the claimed sets union before anything is deleted", SLOW, async () => {
    const bound: number[] = [];
    const recording = recordingDatabase(bound);

    const keys = Array.from({ length: CANDIDATES }, (_, index) => `obj/bulk-${String(index).padStart(4, "0")}`);
    for (const key of keys) await bucket.put(key, "data");
    // One claimed key in the **first** chunk and one in the last, so no single chunk's answer is the
    // whole answer. Keeping only the final chunk's set deletes the first key; stopping after the first
    // chunk deletes the last. Either way a live user file goes, and this is the assertion that says so
    // — a lone key in the last chunk cannot tell a real union from "whatever the last query returned".
    const claimedKeys = [keys[0] as string, keys[CANDIDATES - 1] as string];
    for (const key of claimedKeys) await insertRow({ key, status: "stored", createdAt: new Date() });

    const result = await sweepStorage({ db: recording, store, now: laterClock(), ttlSeconds: TTL_SECONDS });

    expect(result.scannedObjects).toBe(CANDIDATES);
    expect(result.deletedObjects).toBe(CANDIDATES - claimedKeys.length);
    expect(await remainingKeys()).toEqual(claimedKeys);
    expect(Math.max(...bound)).toBeLessThanOrEqual(MAX_BOUND_PARAMETERS);
    // The page really was split: only a chunked membership lookup binds a list this long, and a union
    // of one chunk would prove nothing about unioning at all.
    expect(bound.filter((count) => count > 10).length).toBeGreaterThanOrEqual(2);
  });
});

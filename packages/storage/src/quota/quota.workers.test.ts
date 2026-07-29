import { env } from "cloudflare:test";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { StorageObject, type StorageObjectRow, type StorageObjectStatus } from "../data/storageObject";
import { STORAGE_OBJECTS_TABLE, type StorageDatabase, storageDatabase } from "../data/tables";
import { storage_0001_objects } from "../migrations/0001_objects";
import { assertWithinQuota, insertReservingQuota, updateSettlingQuota, usedBytes } from "./quota";

const MIB = 1024 * 1024;

let db: StorageDatabase;

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS pithy_storage_shares");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_storage_objects");
  db = storageDatabase(env.DB);
  await storage_0001_objects.up(db as unknown as Kysely<unknown>);
});

/** Encode one row through the codec, exactly as a handler would before it writes. */
function encodeRow(
  id: string,
  ownerId: string | null,
  size: number | null,
  status: StorageObjectStatus,
): StorageObjectRow {
  return StorageObject.encode({
    id,
    key: `obj/${id}`,
    path: `${id}.bin`,
    ownerId,
    contentType: "application/octet-stream",
    size,
    visibility: "private",
    checksum: null,
    status,
    uploadId: status === "pending" ? `up-${id}` : null,
    createdAt: new Date(1_700_000_000_000),
    updatedAt: new Date(1_700_000_000_000),
  });
}

/** Write one row through the codec — encode on the way in, exactly as a handler would. */
async function insert(
  id: string,
  ownerId: string | null,
  size: number | null,
  status: StorageObjectStatus,
): Promise<void> {
  await db
    .insertInto(STORAGE_OBJECTS_TABLE)
    .values(encodeRow(id, ownerId, size, status))
    .execute();
}

const uuid = (n: number) => `3f2504e0-4f89-41d3-9a0c-0305e82c33${String(n).padStart(2, "0")}`;

describe("usedBytes", () => {
  test("counts pending reservations alongside stored bytes, and ignores failed rows", async () => {
    await insert(uuid(1), "ada", 10 * MIB, "stored");
    await insert(uuid(2), "ada", 5 * MIB, "pending");
    await insert(uuid(3), "ada", 100 * MIB, "failed");
    await insert(uuid(4), "grace", 50 * MIB, "stored");

    expect(await usedBytes(db, "ada")).toBe(15 * MIB);
    expect(await usedBytes(db, "grace")).toBe(50 * MIB);
  });

  test("is zero for an owner with no rows, and treats a null size as reserving nothing", async () => {
    expect(await usedBytes(db, "nobody")).toBe(0);
    await insert(uuid(5), "ada", null, "pending");
    expect(await usedBytes(db, "ada")).toBe(0);
  });
});

describe("assertWithinQuota", () => {
  const limitBytes = 100 * MIB;

  test("allows an upload that lands exactly on the limit", async () => {
    await insert(uuid(1), "ada", 60 * MIB, "stored");
    await expect(
      assertWithinQuota({ db, ownerId: "ada", limitBytes, additionalBytes: 40 * MIB }),
    ).resolves.toBeUndefined();
  });

  test("rejects an upload one byte over the limit", async () => {
    await insert(uuid(1), "ada", 60 * MIB, "stored");
    await expect(
      assertWithinQuota({ db, ownerId: "ada", limitBytes, additionalBytes: 40 * MIB + 1 }),
    ).rejects.toMatchObject({ payload: { code: "storage/quota_exceeded", status: 413 } });
  });

  test("a burst of concurrent inits cannot walk past the limit — the pending rows reserve", async () => {
    // Each client declares 40 MiB against a 100 MiB quota. Counting only `stored` rows, all three
    // would see a used total of zero and all three would pass. The pending reservations stop the third.
    await assertWithinQuota({ db, ownerId: "ada", limitBytes, additionalBytes: 40 * MIB });
    await insert(uuid(1), "ada", 40 * MIB, "pending");

    await assertWithinQuota({ db, ownerId: "ada", limitBytes, additionalBytes: 40 * MIB });
    await insert(uuid(2), "ada", 40 * MIB, "pending");

    await expect(assertWithinQuota({ db, ownerId: "ada", limitBytes, additionalBytes: 40 * MIB })).rejects.toThrow();
  });

  test("a null limit is unlimited, and a system object with no owner has no quota", async () => {
    await insert(uuid(1), "ada", 500 * MIB, "stored");
    await expect(
      assertWithinQuota({ db, ownerId: "ada", limitBytes: null, additionalBytes: 500 * MIB }),
    ).resolves.toBeUndefined();
    await expect(
      assertWithinQuota({ db, ownerId: null, limitBytes, additionalBytes: 500 * MIB }),
    ).resolves.toBeUndefined();
  });

  test("one owner's usage never counts against another's quota", async () => {
    await insert(uuid(1), "grace", 99 * MIB, "stored");
    await expect(
      assertWithinQuota({ db, ownerId: "ada", limitBytes, additionalBytes: 90 * MIB }),
    ).resolves.toBeUndefined();
  });
});

describe("insertReservingQuota", () => {
  const limitBytes = 100 * MIB;

  test("writes the row when it fits, and the row is byte-identical to a plain insert", async () => {
    const record = encodeRow(uuid(1), "ada", 40 * MIB, "pending");
    await insertReservingQuota({ db, ownerId: "ada", limitBytes, additionalBytes: 40 * MIB, record });

    const row = await db.selectFrom(STORAGE_OBJECTS_TABLE).selectAll().executeTakeFirstOrThrow();
    expect(row).toEqual(record);
    // Decoding proves the conditional insert did not mangle a codec column on its way through the
    // `SELECT` — an epoch date arriving as a string would fail here.
    expect(StorageObject.parse(row).createdAt).toEqual(new Date(1_700_000_000_000));
  });

  test("inserts nothing when the row would breach the limit", async () => {
    await insert(uuid(1), "ada", 90 * MIB, "stored");
    await expect(
      insertReservingQuota({
        db,
        ownerId: "ada",
        limitBytes,
        additionalBytes: 20 * MIB,
        record: encodeRow(uuid(2), "ada", 20 * MIB, "pending"),
      }),
    ).rejects.toMatchObject({ payload: { code: "storage/quota_exceeded", status: 413 } });

    expect(await db.selectFrom(STORAGE_OBJECTS_TABLE).selectAll().execute()).toHaveLength(1);
  });

  test("a row landing exactly on the limit is written — a quota is a ceiling you may reach", async () => {
    await insert(uuid(1), "ada", 60 * MIB, "stored");
    await insertReservingQuota({
      db,
      ownerId: "ada",
      limitBytes,
      additionalBytes: 40 * MIB,
      record: encodeRow(uuid(2), "ada", 40 * MIB, "pending"),
    });
    expect(await usedBytes(db, "ada")).toBe(100 * MIB);
  });

  test("a concurrent burst cannot walk past the limit — the sum is evaluated inside the write", async () => {
    // Ten reservations of 40 MiB each against a 100 MiB quota, all in flight at once. A `SELECT` that
    // ran before the `INSERT` would let every one of them read a used total of zero and pass; the
    // conditional insert lets exactly two through.
    const attempts = Array.from({ length: 10 }, (_, index) =>
      insertReservingQuota({
        db,
        ownerId: "ada",
        limitBytes,
        additionalBytes: 40 * MIB,
        record: encodeRow(uuid(index + 1), "ada", 40 * MIB, "pending"),
      }),
    );
    const settled = await Promise.allSettled(attempts);

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    for (const result of settled.filter((r) => r.status === "rejected")) {
      expect(result.reason).toMatchObject({ payload: { code: "storage/quota_exceeded" } });
    }
    expect(await usedBytes(db, "ada")).toBe(80 * MIB);
    expect(await usedBytes(db, "ada")).toBeLessThanOrEqual(limitBytes);
  });

  test("a null limit and a system object skip the condition and always write", async () => {
    await insert(uuid(1), "ada", 500 * MIB, "stored");
    await insertReservingQuota({
      db,
      ownerId: "ada",
      limitBytes: null,
      additionalBytes: 500 * MIB,
      record: encodeRow(uuid(2), "ada", 500 * MIB, "pending"),
    });
    await insertReservingQuota({
      db,
      ownerId: null,
      limitBytes,
      additionalBytes: 500 * MIB,
      record: encodeRow(uuid(3), null, 500 * MIB, "pending"),
    });
    expect(await db.selectFrom(STORAGE_OBJECTS_TABLE).selectAll().execute()).toHaveLength(3);
  });

  test("another owner's bytes never block a reservation", async () => {
    await insert(uuid(1), "grace", 99 * MIB, "stored");
    await insertReservingQuota({
      db,
      ownerId: "ada",
      limitBytes,
      additionalBytes: 90 * MIB,
      record: encodeRow(uuid(2), "ada", 90 * MIB, "pending"),
    });
    expect(await usedBytes(db, "ada")).toBe(90 * MIB);
  });
});

describe("updateSettlingQuota", () => {
  const limitBytes = 100 * MIB;

  /** A pending reservation, and the `stored` row that would settle it at `actual` bytes. */
  async function reserve(n: number, declared: number) {
    await insert(uuid(n), "ada", declared, "pending");
    return (actual: number) => ({
      record: encodeRow(uuid(n), "ada", actual, "stored"),
      overshoot: actual - declared,
    });
  }

  test("settles the row when the overshoot fits, and the row is byte-identical to a plain update", async () => {
    const settle = await reserve(1, 40 * MIB);
    const { record, overshoot } = settle(50 * MIB);
    await updateSettlingQuota({ db, ownerId: "ada", limitBytes, additionalBytes: overshoot, record });

    const row = await db.selectFrom(STORAGE_OBJECTS_TABLE).selectAll().executeTakeFirstOrThrow();
    expect(row).toEqual(record);
    // Decoding proves the conditional update did not mangle a codec column on its way through the
    // `set` — an epoch date arriving as a string would fail here.
    expect(StorageObject.parse(row).updatedAt).toEqual(new Date(1_700_000_000_000));
    expect(await usedBytes(db, "ada")).toBe(50 * MIB);
  });

  test("updates nothing when the overshoot would breach the limit", async () => {
    await insert(uuid(1), "ada", 50 * MIB, "stored");
    const settle = await reserve(2, 40 * MIB);
    const { record, overshoot } = settle(60 * MIB);

    await expect(
      updateSettlingQuota({ db, ownerId: "ada", limitBytes, additionalBytes: overshoot, record }),
    ).rejects.toMatchObject({ payload: { code: "storage/quota_exceeded", status: 413 } });

    // The row is untouched — still the pending reservation it was, never `stored` at 60 MiB.
    const row = await db
      .selectFrom(STORAGE_OBJECTS_TABLE)
      .selectAll()
      .where("id", "=", uuid(2))
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("pending");
    expect(row.size).toBe(40 * MIB);
  });

  test("the sum still counts the row's own reservation, so only the overshoot is billed", async () => {
    // 60 MiB stored plus a 40 MiB reservation is exactly the limit. Settling that reservation at
    // 40 MiB claims nothing new and must pass; billing the full 40 MiB again would refuse it.
    await insert(uuid(1), "ada", 60 * MIB, "stored");
    const settle = await reserve(2, 40 * MIB);
    const { record, overshoot } = settle(40 * MIB);
    await updateSettlingQuota({ db, ownerId: "ada", limitBytes, additionalBytes: overshoot, record });
    expect(await usedBytes(db, "ada")).toBe(100 * MIB);
  });

  test("a settlement landing exactly on the limit is written — a quota is a ceiling you may reach", async () => {
    await insert(uuid(1), "ada", 60 * MIB, "stored");
    const settle = await reserve(2, 30 * MIB);
    const { record, overshoot } = settle(40 * MIB);
    await updateSettlingQuota({ db, ownerId: "ada", limitBytes, additionalBytes: overshoot, record });
    expect(await usedBytes(db, "ada")).toBe(100 * MIB);
  });

  test("a concurrent burst of settlements cannot walk past the limit — the sum is inside the write", async () => {
    // Five reservations of 10 MiB, each settling at 30 MiB, against a 100 MiB quota. Every one of
    // them reads the same 50 MiB total if the check runs before the update, and every one of them
    // passes: 50 <= 100 - 20. The conditional update lets exactly two through.
    const settlements = [];
    for (const index of [1, 2, 3, 4, 5]) settlements.push(await reserve(index, 10 * MIB));
    const attempts = settlements.map((settle) => {
      const { record, overshoot } = settle(30 * MIB);
      return updateSettlingQuota({ db, ownerId: "ada", limitBytes, additionalBytes: overshoot, record });
    });
    const settled = await Promise.allSettled(attempts);

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    for (const result of settled.filter((r) => r.status === "rejected")) {
      expect(result.reason).toMatchObject({ payload: { code: "storage/quota_exceeded" } });
    }
    // Two settled at 30 MiB, three still reserve 10 MiB each.
    expect(await usedBytes(db, "ada")).toBe(90 * MIB);
    expect(await usedBytes(db, "ada")).toBeLessThanOrEqual(limitBytes);
  });

  test("a null limit and a system object skip the condition and always write", async () => {
    await insert(uuid(1), "ada", 500 * MIB, "stored");
    const ada = await reserve(2, 10 * MIB);
    await updateSettlingQuota({
      db,
      ownerId: "ada",
      limitBytes: null,
      additionalBytes: 490 * MIB,
      record: ada(500 * MIB).record,
    });
    await insert(uuid(3), null, 10 * MIB, "pending");
    await updateSettlingQuota({
      db,
      ownerId: null,
      limitBytes,
      additionalBytes: 490 * MIB,
      record: encodeRow(uuid(3), null, 500 * MIB, "stored"),
    });

    const rows = await db.selectFrom(STORAGE_OBJECTS_TABLE).select(["id", "status"]).execute();
    expect(rows.filter((row) => row.status === "stored")).toHaveLength(3);
  });

  test("another owner's bytes never block a settlement", async () => {
    await insert(uuid(1), "grace", 99 * MIB, "stored");
    const settle = await reserve(2, 10 * MIB);
    const { record, overshoot } = settle(90 * MIB);
    await updateSettlingQuota({ db, ownerId: "ada", limitBytes, additionalBytes: overshoot, record });
    expect(await usedBytes(db, "ada")).toBe(90 * MIB);
  });
});

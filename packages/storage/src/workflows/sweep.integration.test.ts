import { loadIntegrationCreds } from "@pithy-sh/cloudflare/src/test-utils/harness";
import { beforeAll, describe, expect, test } from "vitest";
import { StorageObject } from "../data/storageObject";
import { STORAGE_OBJECTS_TABLE, type StorageDatabase } from "../data/tables";
import { deriveObjectKey } from "../object/key";
import { MIN_PART_SIZE_BYTES } from "../object/multipart";
import type { ObjectStore } from "../object/store";
import { reapStaleStorageResources, withLiveBucket, withLiveDatabase } from "../test-utils/liveStorage";
import { sweepStorage } from "./sweep";

/**
 * LIVE integration test — the orphan sweep against a genuinely divergent bucket and table.
 *
 * The sweep exists because a file is two writes with no transaction spanning them, and its whole
 * correctness argument is about what R2 and D1 each really report: an object's `uploaded` timestamp
 * decides whether it is an orphan or a race, a listing's cursor decides whether a page was the last,
 * and an abort has to make R2 forget parts it was already billing for. A fake bucket agrees with
 * whatever the test asserts. This one does not.
 *
 * Both stores are real. D1 is a throwaway database migrated over REST — the same schema `pithy
 * migrate` promotes — because this pool is Node and Miniflare's D1 lives in workerd; reconciling an
 * emulated table against a real bucket would prove half of the thing under test.
 *
 * Skipped without `CLOUDFLARE_*` and `R2_CREDENTIALS` in `.dev.vars`.
 */
const creds = loadIntegrationCreds();

const BODY = new TextEncoder().encode("bytes that outlived their row");

/** How far past every object's real R2 timestamp a run has to look before nothing is "too new". */
const AN_HOUR_MS = 60 * 60 * 1000;

/** PUT `body` to `key` through a freshly presigned whole-object URL — the seeding path. */
async function seed(store: ObjectStore, key: string, body: Uint8Array): Promise<void> {
  const url = await store.presignPut(key, "application/octet-stream", body.byteLength);
  const put = await fetch(url, { method: "PUT", body });
  expect(put.ok).toBe(true);
}

/** Write one row directly, through the codec — the round-trip rule, not a hand-built SQLite record. */
async function insertRow(db: StorageDatabase, object: StorageObject): Promise<void> {
  await db.insertInto(STORAGE_OBJECTS_TABLE).values(StorageObject.encode(object)).execute();
}

/** Whether a row still exists. The sweep's effect on D1 is a deletion, so absence is the assertion. */
async function rowExists(db: StorageDatabase, id: string): Promise<boolean> {
  const row = await db.selectFrom(STORAGE_OBJECTS_TABLE).select("id").where("id", "=", id).executeTakeFirst();
  return Boolean(row);
}

describe.skipIf(!creds.hasCreds || !creds.r2)("sweepStorage — LIVE against real R2 and real D1", () => {
  // Clean up whatever a previous aborted run orphaned before creating anything new.
  beforeAll(() => reapStaleStorageResources(creds));

  test("reconciles both directions, leaves live data alone, and re-runs to nothing", async () => {
    await withLiveDatabase(creds, async (db) => {
      await withLiveBucket(creds, async ({ store, manager }) => {
        const now = new Date();

        // Direction one: bytes with no row. A delete that dropped the row and then failed on R2, or a
        // client that uploaded to a presigned URL after its row was gone. Nobody is billed for these.
        const orphanKey = deriveObjectKey();
        await seed(store, orphanKey, BODY);

        // Direction two: a `pending` row whose upload never finished. Its reservation counts against
        // the owner's quota forever. A real multipart upload with a real part stored under it, so the
        // abort has something R2 is actually holding.
        const staleKey = deriveObjectKey();
        const staleUploadId = await store.initMultipart(staleKey, "application/octet-stream");
        const partUrl = await store.presignPart(staleKey, staleUploadId, 1);
        expect((await fetch(partUrl, { method: "PUT", body: new Uint8Array(MIN_PART_SIZE_BYTES) })).ok).toBe(true);
        const staleId = crypto.randomUUID();
        await insertRow(db, {
          id: staleId,
          key: staleKey,
          path: "abandoned/upload.bin",
          ownerId: "owner-1",
          contentType: "application/octet-stream",
          size: MIN_PART_SIZE_BYTES,
          visibility: "private",
          checksum: null,
          status: "pending",
          uploadId: staleUploadId,
          createdAt: now,
          updatedAt: now,
        });

        // A finished file: bytes and a row that claims them. It must survive every run.
        const claimedKey = deriveObjectKey();
        await seed(store, claimedKey, BODY);
        const claimedId = crypto.randomUUID();
        await insertRow(db, {
          id: claimedId,
          key: claimedKey,
          path: "invoices/q3.pdf",
          ownerId: "owner-1",
          contentType: "application/octet-stream",
          size: BODY.byteLength,
          visibility: "private",
          checksum: null,
          status: "stored",
          uploadId: null,
          createdAt: now,
          updatedAt: now,
        });

        // A co-tenant's object under a prefix this capability never derives. The bucket may not be ours
        // alone, and a sweep that deletes someone else's bytes is worse than one that deletes nothing.
        const foreignKey = "vendor/keep.txt";
        await seed(store, foreignKey, BODY);

        // Nothing is old enough yet. This is the guard that turns the read-then-write race into a wait:
        // an object uploaded seconds ago whose row this run has not read is not an orphan.
        // `pageSize: 1` forces R2 to hand back a real continuation cursor, so paging is exercised on a
        // three-key bucket rather than only at a scale no test should pay for.
        const tooNew = await sweepStorage({ db, store, now: () => now, ttlSeconds: 3600, pageSize: 1 });
        expect(tooNew).toEqual({
          reclaimedRows: 0,
          deletedObjects: 0,
          // Only `obj/` keys are ever listed, so the co-tenant's object is not even scanned.
          scannedObjects: 2,
          truncated: false,
          dryRun: false,
        });

        // Look an hour past every timestamp R2 holds, and everything above is stale. A dry run reports
        // exactly what a real one would do, and touches nothing.
        const future = () => new Date(now.getTime() + AN_HOUR_MS);
        const reported = await sweepStorage({ db, store, now: future, ttlSeconds: 60, dryRun: true });
        expect(reported).toEqual({
          reclaimedRows: 1,
          deletedObjects: 1,
          scannedObjects: 2,
          truncated: false,
          dryRun: true,
        });
        expect(await store.head(orphanKey)).not.toBeNull();
        expect(await rowExists(db, staleId)).toBe(true);

        // The page cap is reported, not hidden: a run that stopped early says so, so an operator can
        // tell "nothing to do" from "ran out of budget".
        const capped = await sweepStorage({
          db,
          store,
          now: future,
          ttlSeconds: 60,
          dryRun: true,
          pageSize: 1,
          maxPages: 1,
        });
        expect(capped.truncated).toBe(true);
        expect(capped.scannedObjects).toBe(1);

        // The real run.
        const swept = await sweepStorage({ db, store, now: future, ttlSeconds: 60 });
        expect(swept).toEqual({
          reclaimedRows: 1,
          deletedObjects: 1,
          scannedObjects: 2,
          truncated: false,
          dryRun: false,
        });

        // Direction one settled: the unclaimed bytes are gone.
        expect(await store.head(orphanKey)).toBeNull();
        // Direction two settled: the row released its reservation, and R2 has forgotten the upload —
        // listing a forgotten upload id fails, which is the only proof the parts stopped costing money.
        expect(await rowExists(db, staleId)).toBe(false);
        await expect(manager.listParts(staleKey, staleUploadId)).rejects.toHaveProperty(
          "payload.code",
          "cloudflare/request_failed",
        );

        // Live data survived, in both stores and on both sides of the prefix guard.
        expect(await rowExists(db, claimedId)).toBe(true);
        expect((await store.head(claimedKey))?.size).toBe(BODY.byteLength);
        expect(await store.head(foreignKey)).not.toBeNull();

        // Idempotent by construction: a reconciled bucket gives a second run nothing to do, so a
        // retried Workflow step and a nervous operator cost the same.
        const again = await sweepStorage({ db, store, now: future, ttlSeconds: 60 });
        expect(again).toEqual({
          reclaimedRows: 0,
          deletedObjects: 0,
          scannedObjects: 1,
          truncated: false,
          dryRun: false,
        });
      });
    });
  });
});

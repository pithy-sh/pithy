import { loadIntegrationCreds } from "@pithy-sh/cloudflare/src/test-utils/harness";
import { beforeAll, describe, expect, test } from "vitest";
import { StorageConfig } from "../config/config";
import { StorageObject } from "../data/storageObject";
import { STORAGE_OBJECTS_TABLE, type StorageDatabase } from "../data/tables";
import type { ObjectStore } from "../object/store";
import { reapStaleStorageResources, withLiveBucket, withLiveDatabase } from "../test-utils/liveStorage";
import { abortUpload, completeUpload, type HandlerDeps, initUpload } from "./handlers";
import { CompleteUploadInput } from "./schemas";

/**
 * LIVE integration test — upload init and completion against real R2 and real D1.
 *
 * The one fact this file exists for: **a presigned PUT cannot pin a content type.** The presigner
 * marks `content-type` unsignable before signing, so a client may send whatever type it likes to the
 * URL it was handed, and R2 stores that. A row that recorded the *declared* type would therefore
 * disagree with the object — and it is the row a serve path reads when it decides what to neutralise,
 * which is what made this a security finding rather than a tidiness one.
 *
 * No mock can prove the fix, because the mock is the thing that would have to lie: it would have to
 * both refuse to sign the header and store the client's value. Only R2 does both.
 *
 * Skipped without `CLOUDFLARE_*` and `R2_CREDENTIALS` in `.dev.vars`.
 */
const creds = loadIntegrationCreds();

const BODY = new TextEncoder().encode("<p>not the pdf it was declared to be</p>");

/**
 * What `zValidator("json", CompleteUploadInput, validationHook)` hands the handler for an empty body.
 * The handlers no longer parse their own input — the route does — so a direct call supplies the
 * *parsed* value, and `parts` is only optional on the way in.
 */
const NO_PARTS = CompleteUploadInput.parse({});

/** The handler dependencies, wired the way `routes.ts` wires them from a request env. */
function deps(db: StorageDatabase, store: ObjectStore): HandlerDeps {
  return {
    db,
    store,
    config: StorageConfig.parse({}),
    ownerId: "owner-1",
    newId: () => crypto.randomUUID(),
    newToken: () => crypto.randomUUID(),
    now: () => new Date(),
  };
}

/** Read one row back through the schema — what the database really holds, decoded. */
async function loadRow(db: StorageDatabase, id: string): Promise<StorageObject> {
  const row = await db.selectFrom(STORAGE_OBJECTS_TABLE).selectAll().where("id", "=", id).executeTakeFirst();
  if (!row) throw new Error(`no storage row ${id}`);
  return StorageObject.parse(row);
}

describe.skipIf(!creds.hasCreds || !creds.r2)("storage handlers — LIVE against real R2 and real D1", () => {
  // Clean up whatever a previous aborted run orphaned before creating anything new.
  beforeAll(() => reapStaleStorageResources(creds));

  test("completion records the content type R2 stored, not the one the client declared", async () => {
    await withLiveDatabase(creds, async (db) => {
      await withLiveBucket(creds, async ({ store }) => {
        const handler = deps(db, store);

        const init = await initUpload(handler, {
          path: "invoices/q3.pdf",
          contentType: "application/pdf",
          size: BODY.byteLength,
        });
        expect(init.upload.kind).toBe("single");
        expect(init.object.status).toBe("pending");
        // The key is server-derived and never leaves the handler module — a key in a response body
        // would be a capability leak, since it is the only thing a presigned URL addresses.
        expect(init.object).not.toHaveProperty("key");

        // Upload as something else entirely. This is not a contrived attack: it is what a browser does
        // when it rewrites the header, and what a hostile client does on purpose.
        if (init.upload.kind !== "single") throw new Error("expected a single-PUT upload");
        const put = await fetch(init.upload.url, {
          method: "PUT",
          headers: { "content-type": "text/html" },
          body: BODY,
        });
        expect(put.ok).toBe(true);

        const completed = await completeUpload(handler, init.object.id, NO_PARTS);
        expect(completed.status).toBe("stored");
        // The fix, proved by R2 rather than asserted about a fake.
        expect(completed.contentType).toBe("text/html");
        expect(completed.size).toBe(BODY.byteLength);

        // And it is the *row* that changed, not just the returned view.
        const row = await loadRow(db, init.object.id);
        expect(row.contentType).toBe("text/html");
        // No upload is left in flight. Asserted as falsy rather than `null` on purpose: the D1 REST API
        // binds every parameter as a string, so a null written over REST lands as `""` where a Worker
        // binding stores a real NULL. That is a property of this transport, not of the handler — the
        // binding side is covered in `routes.workers.test.ts`. Both spellings say the same thing here.
        expect(row.uploadId).toBeFalsy();
        // The row now agrees with the object, which is the whole point.
        expect((await store.head(row.key))?.contentType).toBe("text/html");

        // Completing twice is a no-op, so a client that retried a dropped response gets one answer.
        expect((await completeUpload(handler, init.object.id, NO_PARTS)).contentType).toBe("text/html");
      });
    });
  });

  test("completion refuses an upload whose bytes never landed, and an abort leaves nothing behind", async () => {
    await withLiveDatabase(creds, async (db) => {
      await withLiveBucket(creds, async ({ store }) => {
        const handler = deps(db, store);
        const init = await initUpload(handler, {
          path: "invoices/never-sent.pdf",
          contentType: "application/pdf",
          size: BODY.byteLength,
        });

        // Error path: R2 answers the confirming HEAD with nothing, so the row is never allowed to claim
        // bytes that do not exist. Without this a `stored` row would 404 at read time, hours later.
        await expect(completeUpload(handler, init.object.id, NO_PARTS)).rejects.toHaveProperty(
          "payload.code",
          "storage/upload_incomplete",
        );

        // A single-PUT upload can still land whole without ever being completed, so abort drops the
        // bytes too — aborting must never leave an object for the sweep to find.
        if (init.upload.kind !== "single") throw new Error("expected a single-PUT upload");
        expect((await fetch(init.upload.url, { method: "PUT", body: BODY })).ok).toBe(true);
        const row = await loadRow(db, init.object.id);
        expect(await store.head(row.key)).not.toBeNull();

        expect((await abortUpload(handler, init.object.id)).status).toBe("failed");
        expect(await store.head(row.key)).toBeNull();
      });
    });
  });
});

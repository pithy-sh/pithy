import { env } from "cloudflare:test";
import type { R2Bucket } from "@cloudflare/workers-types";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { StorageConfig, type StorageConfigInput } from "../config/config";
import { STORAGE_OBJECTS_TABLE, STORAGE_SHARES_TABLE, type StorageDatabase, storageDatabase } from "../data/tables";
import { storage_0001_objects } from "../migrations/0001_objects";
import { collectParts, planMultipart } from "../object/multipart";
import { type ObjectStore, objectStore, type PresignedObjects, type UploadedPart } from "../object/store";
import { usedBytes } from "../quota/quota";
import type { HandlerDeps } from "./handlers";
import { registerStorageRoutes } from "./routes";

/**
 * The storage routes end to end, against a real Miniflare D1 database and a real R2 bucket.
 *
 * Only the *presigned* half of the object seam is stood in for, and only because it has to be:
 * Miniflare emulates R2 through the binding and serves no S3 endpoint, so a presigned URL cannot be
 * minted or PUT to here. Everything else is real — the migration, the rows, the codecs, the bytes,
 * the multipart lifecycle, the conditional and ranged reads. The double routes `initMultipart`,
 * `completeMultipart` and `abortMultipart` to the binding's own multipart API, so the part plan the
 * handlers compute is validated by R2 accepting it, and returns a placeholder URL for the two
 * presign calls a client would use to move bytes. The test then moves those bytes through the
 * binding, which is exactly what a client's PUT would have done.
 */

const MIB = 1024 * 1024;
const ADA = "user-ada";
const GRACE = "user-grace";

/** Where a presigned URL would point. Never fetched — it exists to be handed back and asserted on. */
const PRESIGNED_HOST = "https://presigned.invalid";

/** The seam must never resolve credentials in these tests; a stray S3 path fails loudly. */
const noPresign = (): PresignedObjects => {
  throw new Error("the route tests must never resolve R2 credentials");
};

let db: StorageDatabase;
let bucket: R2Bucket;

/**
 * Parts the test has PUT, keyed by `<key>:<uploadId>`. R2's *binding* exposes no part listing — only
 * the S3 API does — so the double keeps the ledger the real `listParts` reads from R2.
 */
const uploadedParts = new Map<string, UploadedPart[]>();

/**
 * The multipart uploads the handlers opened and aborted, in order.
 *
 * A refused init never tells the client the `uploadId` it opened — that is the point of refusing — so
 * a test asserting the cleanup happened has nowhere else to read it from. Without this ledger the only
 * available assertion is the D1 row count, which a handler that skipped the abort entirely would also
 * satisfy.
 */
const openedUploads: Array<{ key: string; uploadId: string }> = [];
const abortedUploads: Array<{ key: string; uploadId: string }> = [];

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS pithy_storage_shares");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_storage_objects");
  db = storageDatabase(env.DB);
  await storage_0001_objects.up(db as unknown as Kysely<unknown>);
  bucket = env.STORAGE_BUCKET;
  uploadedParts.clear();
  openedUploads.length = 0;
  abortedUploads.length = 0;
  // Miniflare's bucket persists across tests in a file; clear the derived keys so each case starts clean.
  const listing = await bucket.list({ prefix: "obj/" });
  for (const object of listing.objects) await bucket.delete(object.key);
});

/** PUT one part through the binding and record it, which is what a client's PUT to a part URL does. */
async function putPart(
  key: string,
  uploadId: string,
  partNumber: number,
  bytes: Uint8Array,
): Promise<{ partNumber: number; etag: string }> {
  const uploaded = await bucket.resumeMultipartUpload(key, uploadId).uploadPart(partNumber, bytes);
  const ledger = uploadedParts.get(`${key}:${uploadId}`) ?? [];
  ledger.push({ partNumber: uploaded.partNumber, etag: uploaded.etag, size: bytes.length });
  uploadedParts.set(`${key}:${uploadId}`, ledger);
  return { partNumber: uploaded.partNumber, etag: uploaded.etag };
}

/** The binding-backed half of the seam, plus a multipart lifecycle driven through the binding. */
function testStore(): ObjectStore {
  const real = objectStore({ bucket, env: {} as SecretsStoreEnv, presigned: noPresign });
  return {
    get: (key, options) => real.get(key, options),
    head: (key) => real.head(key),
    list: (options) => real.list(options),
    delete: (key) => real.delete(key),

    presignPut: async (key) => `${PRESIGNED_HOST}/${key}`,
    presignGet: async (key) => `${PRESIGNED_HOST}/${key}?download`,
    presignPart: async (key, uploadId, partNumber) => `${PRESIGNED_HOST}/${key}?upload=${uploadId}&part=${partNumber}`,

    initMultipart: async (key, contentType) => {
      const { uploadId } = await bucket.createMultipartUpload(key, { httpMetadata: { contentType } });
      openedUploads.push({ key, uploadId });
      return uploadId;
    },
    completeMultipart: async (key, uploadId, parts) => {
      await bucket.resumeMultipartUpload(key, uploadId).complete(parts.map((part) => ({ ...part })));
    },
    abortMultipart: async (key, uploadId) => {
      await bucket.resumeMultipartUpload(key, uploadId).abort();
      uploadedParts.delete(`${key}:${uploadId}`);
      abortedUploads.push({ key, uploadId });
    },
    listParts: async (key, uploadId) =>
      [...(uploadedParts.get(`${key}:${uploadId}`) ?? [])].sort((a, b) => a.partNumber - b.partNumber),
    // R2's binding has no server-side copy, so the double reads and re-puts. The handler only cares
    // that the destination ends up with the source's bytes.
    copy: async (sourceKey, destinationKey) => {
      const object = await bucket.get(sourceKey);
      if (!object) throw new Error(`no object at ${sourceKey}`);
      await bucket.put(destinationKey, await object.arrayBuffer(), { httpMetadata: object.httpMetadata });
    },
  };
}

let idCounter = 0;
let tokenCounter = 0;
let clock = new Date("2026-01-01T00:00:00.000Z");

/** Build the app with an auth middleware gated on an `x-user` header, and deterministic ids. */
function makeApp(configInput: StorageConfigInput = {}) {
  idCounter = 0;
  tokenCounter = 0;
  clock = new Date("2026-01-01T00:00:00.000Z");
  const config = StorageConfig.parse(configInput);
  const store = testStore();
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    const user = c.req.header("x-user");
    c.set("auth", user ? { userId: user, sessionId: "s1", scopes: [] } : null);
    await next();
  });
  const resolveDeps = async (c: { var: { auth: { userId: string } | null } }): Promise<HandlerDeps> => ({
    db,
    store,
    config,
    ownerId: c.var.auth?.userId ?? null,
    newId: () => {
      idCounter += 1;
      return `00000000-0000-4000-8000-${String(idCounter).padStart(12, "0")}`;
    },
    newToken: () => {
      tokenCounter += 1;
      return `token-${tokenCounter}`;
    },
    now: () => clock,
  });
  registerStorageRoutes({
    config,
    resolveDeps: resolveDeps as unknown as NonNullable<Parameters<typeof registerStorageRoutes>[0]["resolveDeps"]>,
  })(app);
  return app;
}

/** Start an upload as `user`. */
async function init(
  app: Hono<PithyHonoEnv>,
  user: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, never> }> {
  const response = await app.request("/storage", {
    method: "POST",
    headers: { "content-type": "application/json", "x-user": user },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, never> };
}

/** The whole small-file dance: init, PUT the bytes through the binding, complete. Returns the id. */
async function storeFile(app: Hono<PithyHonoEnv>, user: string, path: string, body: string, visibility?: string) {
  const created = await init(app, user, {
    path,
    contentType: "text/plain",
    size: new TextEncoder().encode(body).length,
    ...(visibility ? { visibility } : {}),
  });
  const id = (created.json as unknown as { object: { id: string } }).object.id;
  // The client's PUT to the presigned URL, performed through the binding because Miniflare has no
  // S3 endpoint. The key is deliberately not in the response, so it is read from the row.
  const row = await db.selectFrom(STORAGE_OBJECTS_TABLE).select("key").where("id", "=", id).executeTakeFirstOrThrow();
  await bucket.put(row.key, body, { httpMetadata: { contentType: "text/plain" } });
  const completed = await app.request(`/storage/${id}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-user": user },
    body: JSON.stringify({}),
  });
  expect(completed.status).toBe(200);
  return { id, key: row.key };
}

describe("verification strategies", () => {
  test("an unauthenticated upload is denied", async () => {
    const response = await makeApp().request("/storage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "a.txt", contentType: "text/plain", size: 1 }),
    });
    expect(response.status).toBe(401);
  });

  test("an unauthenticated list is denied", async () => {
    expect((await makeApp().request("/storage")).status).toBe(401);
  });

  test("a public object reads with no session at all", async () => {
    const app = makeApp();
    const { id } = await storeFile(app, ADA, "public/hello.txt", "hello", "public");
    const response = await app.request(`/storage/${id}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello");
  });

  test("a private object is invisible to an anonymous reader, and to another user", async () => {
    const app = makeApp();
    const { id } = await storeFile(app, ADA, "private/hello.txt", "hello");
    expect((await app.request(`/storage/${id}`)).status).toBe(404);
    expect((await app.request(`/storage/${id}`, { headers: { "x-user": GRACE } })).status).toBe(404);
  });

  test("a private object someone else owns reads as missing, not as forbidden — no enumeration oracle", async () => {
    const app = makeApp();
    const { id } = await storeFile(app, ADA, "private/hello.txt", "hello");
    const response = await app.request(`/storage/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-user": GRACE },
      body: JSON.stringify({ path: "stolen.txt" }),
    });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("storage/not_found");
  });

  test("a public object someone else owns is forbidden — its existence is already public", async () => {
    const app = makeApp();
    const { id } = await storeFile(app, ADA, "public/hello.txt", "hello", "public");
    const response = await app.request(`/storage/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-user": GRACE },
      body: JSON.stringify({ visibility: "private" }),
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("storage/forbidden");
  });
});

describe("upload — single PUT", () => {
  test("init reserves a pending row and returns one upload URL, never the object key", async () => {
    const app = makeApp();
    const created = await init(app, ADA, { path: "a/b.txt", contentType: "text/plain", size: 5 });
    expect(created.status).toBe(201);
    const payload = created.json as unknown as { object: Record<string, unknown>; upload: { kind: string } };
    expect(payload.upload.kind).toBe("single");
    expect(payload.object.status).toBe("pending");
    // The key is the only thing a presigned URL addresses; it must never appear in a response body.
    expect(JSON.stringify(payload.object)).not.toContain("obj/");
    expect(Object.keys(payload.object)).not.toContain("key");

    const row = await db.selectFrom(STORAGE_OBJECTS_TABLE).selectAll().executeTakeFirstOrThrow();
    expect(row.status).toBe("pending");
    expect(row.uploadId).toBe(null);
  });

  test("completing an upload nobody performed is refused — the row never claims bytes R2 does not have", async () => {
    const app = makeApp();
    const created = await init(app, ADA, { path: "a/b.txt", contentType: "text/plain", size: 5 });
    const id = (created.json as unknown as { object: { id: string } }).object.id;
    const response = await app.request(`/storage/${id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user": ADA },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("storage/upload_incomplete");
  });

  test("complete records the size R2 reports, not the size the client declared", async () => {
    const app = makeApp();
    const created = await init(app, ADA, { path: "a/b.txt", contentType: "text/plain", size: 500 });
    const id = (created.json as unknown as { object: { id: string } }).object.id;
    const row = await db.selectFrom(STORAGE_OBJECTS_TABLE).select("key").where("id", "=", id).executeTakeFirstOrThrow();
    await bucket.put(row.key, "short");
    const response = await app.request(`/storage/${id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user": ADA },
      body: JSON.stringify({}),
    });
    const object = (await response.json()) as { status: string; size: number };
    expect(object.status).toBe("stored");
    expect(object.size).toBe(5);
  });

  test("completing twice is a no-op, so a client that retried a dropped response is safe", async () => {
    const app = makeApp();
    const { id } = await storeFile(app, ADA, "a/b.txt", "hello");
    const again = await app.request(`/storage/${id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user": ADA },
      body: JSON.stringify({}),
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { status: string }).status).toBe("stored");
  });
});

describe("upload — multipart", () => {
  /** 5 MiB parts is R2's floor, so this is the smallest config that exercises a real multipart upload. */
  const multipartConfig: StorageConfigInput = { partSizeBytes: 5 * MIB, multipartThresholdBytes: 5 * MIB };

  test("a large upload plans parts, uploads them out of order, and completes against real R2", async () => {
    const app = makeApp(multipartConfig);
    const size = 11 * MIB;
    const created = await init(app, ADA, { path: "big.bin", contentType: "application/octet-stream", size });
    const payload = created.json as unknown as {
      object: { id: string };
      upload: { kind: string; uploadId: string; partSize: number; parts: { partNumber: number; length: number }[] };
    };
    expect(payload.upload.kind).toBe("multipart");
    expect(payload.upload.parts.map((part) => part.length)).toEqual([5 * MIB, 5 * MIB, MIB]);

    const id = payload.object.id;
    const row = await db.selectFrom(STORAGE_OBJECTS_TABLE).selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    expect(row.uploadId).toBe(payload.upload.uploadId);

    // The client's PUTs, through the binding. Deliberately reversed: parts finish in whatever order
    // the network gives them, and `collectParts` is what puts them back in order.
    const plan = planMultipart(size, 5 * MIB);
    const reported: { partNumber: number; etag: string }[] = [];
    for (const part of [...plan.parts].reverse()) {
      const chunk = new Uint8Array(part.length).fill(part.partNumber);
      reported.push(await putPart(row.key, payload.upload.uploadId, part.partNumber, chunk));
    }

    const completed = await app.request(`/storage/${id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user": ADA },
      body: JSON.stringify({ parts: reported }),
    });
    expect(completed.status).toBe(200);
    const object = (await completed.json()) as { status: string; size: number };
    expect(object.status).toBe("stored");
    expect(object.size).toBe(size);

    const head = await bucket.head(row.key);
    expect(head?.size).toBe(size);
  });

  test("a completion missing a part is refused before R2 sees it", async () => {
    const app = makeApp(multipartConfig);
    const size = 11 * MIB;
    const created = await init(app, ADA, { path: "big.bin", contentType: "application/octet-stream", size });
    const payload = created.json as unknown as { object: { id: string }; upload: { uploadId: string } };
    const row = await db
      .selectFrom(STORAGE_OBJECTS_TABLE)
      .selectAll()
      .where("id", "=", payload.object.id)
      .executeTakeFirstOrThrow();
    const first = await putPart(row.key, payload.upload.uploadId, 1, new Uint8Array(5 * MIB));

    const response = await app.request(`/storage/${payload.object.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user": ADA },
      body: JSON.stringify({ parts: [first] }),
    });
    expect(response.status).toBe(500);
    const error = ((await response.json()) as { error: { code: string; action: string } }).error;
    expect(error.code).toBe("storage/multipart_failed");
    // The action tells the client where to recover. It has to name a route that exists.
    expect(error.action).toContain("/parts");
    await bucket.resumeMultipartUpload(row.key, payload.upload.uploadId).abort();
  });

  test("collectParts is what makes out-of-order reporting safe", () => {
    const reported = [
      { partNumber: 3, etag: "c" },
      { partNumber: 1, etag: "a" },
      { partNumber: 2, etag: "b" },
    ];
    expect(collectParts(reported, 3).map((part) => part.partNumber)).toEqual([1, 2, 3]);
  });

  test("abort discards the parts, drops any bytes, and marks the row failed", async () => {
    const app = makeApp(multipartConfig);
    const size = 11 * MIB;
    const created = await init(app, ADA, { path: "big.bin", contentType: "application/octet-stream", size });
    const payload = created.json as unknown as { object: { id: string }; upload: { uploadId: string } };
    const row = await db
      .selectFrom(STORAGE_OBJECTS_TABLE)
      .selectAll()
      .where("id", "=", payload.object.id)
      .executeTakeFirstOrThrow();
    await putPart(row.key, payload.upload.uploadId, 1, new Uint8Array(5 * MIB));

    const response = await app.request(`/storage/${payload.object.id}/abort`, {
      method: "POST",
      headers: { "x-user": ADA },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { status: string }).status).toBe("failed");
    expect(await bucket.head(row.key)).toBe(null);
  });

  test("a failed row holds no quota — an abandoned upload gives its reservation back", async () => {
    const app = makeApp({ ...multipartConfig, quota: { bytesPerOwner: 12 * MIB } });
    const size = 11 * MIB;
    const created = await init(app, ADA, { path: "big.bin", contentType: "application/octet-stream", size });
    const id = (created.json as unknown as { object: { id: string } }).object.id;
    // While the upload is pending its bytes are reserved, so a second one of the same size is refused.
    const blocked = await init(app, ADA, { path: "big2.bin", contentType: "application/octet-stream", size });
    expect(blocked.status).toBe(413);

    await app.request(`/storage/${id}/abort`, { method: "POST", headers: { "x-user": ADA } });
    const allowed = await init(app, ADA, { path: "big2.bin", contentType: "application/octet-stream", size });
    expect(allowed.status).toBe(201);
  });

  test("an init over an already-full quota opens no multipart upload at all", async () => {
    const app = makeApp({ ...multipartConfig, quota: { bytesPerOwner: 11 * MIB } });
    const size = 11 * MIB;
    expect((await init(app, ADA, { path: "one.bin", contentType: "application/octet-stream", size })).status).toBe(201);
    // The quota is now full and nothing is racing, so the pre-check refuses before an R2 multipart
    // upload exists to clean up. That is the whole reason the pre-check is there.
    expect((await init(app, ADA, { path: "two.bin", contentType: "application/octet-stream", size })).status).toBe(413);

    expect(await db.selectFrom(STORAGE_OBJECTS_TABLE).selectAll().execute()).toHaveLength(1);
    expect(openedUploads).toHaveLength(1);
    expect(abortedUploads).toEqual([]);
  });

  test("an init that loses the reservation race aborts the multipart upload it opened", async () => {
    // The path the pre-check cannot cover. Four inits fire at once against a one-slot quota, so all
    // four read a used total of zero, all four pass the pre-check, and all four open a multipart
    // upload at R2 — then three of them lose the conditional insert. R2 bills stored parts whether or
    // not a row points at them, so the losers must abort what they opened. A row count alone would be
    // satisfied by a handler that opened those uploads and simply walked away.
    const app = makeApp({ ...multipartConfig, quota: { bytesPerOwner: 11 * MIB } });
    const size = 11 * MIB;
    const responses = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        init(app, ADA, { path: `race-${index}.bin`, contentType: "application/octet-stream", size }),
      ),
    );

    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    const rows = await db.selectFrom(STORAGE_OBJECTS_TABLE).select("key").execute();
    expect(rows).toHaveLength(1);
    const kept = rows[0]?.key;

    // The race really happened: more uploads were opened than rows survived.
    expect(openedUploads.length).toBeGreaterThan(1);
    const losers = openedUploads.filter((upload) => upload.key !== kept);
    expect(abortedUploads).toHaveLength(losers.length);
    expect([...abortedUploads].sort((a, b) => a.key.localeCompare(b.key))).toEqual(
      [...losers].sort((a, b) => a.key.localeCompare(b.key)),
    );
    // And R2 really forgot them, rather than the double merely recording the calls.
    for (const loser of losers) {
      await expect(
        bucket.resumeMultipartUpload(loser.key, loser.uploadId).uploadPart(1, new Uint8Array(5 * MIB)),
      ).rejects.toThrow();
    }
  });
});

describe("resuming a multipart upload", () => {
  const multipartConfig: StorageConfigInput = { partSizeBytes: 5 * MIB, multipartThresholdBytes: 5 * MIB };

  /** Init a multipart upload and hand back its id, key and uploadId. */
  async function beginMultipart(app: Hono<PithyHonoEnv>, size: number) {
    const created = await init(app, ADA, { path: "big.bin", contentType: "application/octet-stream", size });
    const payload = created.json as unknown as { object: { id: string }; upload: { uploadId: string } };
    const row = await db
      .selectFrom(STORAGE_OBJECTS_TABLE)
      .select("key")
      .where("id", "=", payload.object.id)
      .executeTakeFirstOrThrow();
    return { id: payload.object.id, key: row.key, uploadId: payload.upload.uploadId };
  }

  test("reports the stored parts and mints a fresh URL for every one still missing", async () => {
    const app = makeApp(multipartConfig);
    const { id, key, uploadId } = await beginMultipart(app, 11 * MIB);
    await putPart(key, uploadId, 2, new Uint8Array(5 * MIB));

    const response = await app.request(`/storage/${id}/parts`, { headers: { "x-user": ADA } });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      uploadId: string;
      partSize: number;
      partCount: number;
      uploaded: { partNumber: number; etag: string; size: number }[];
      missing: { partNumber: number; offset: number; length: number; url: string }[];
    };

    expect(payload.uploadId).toBe(uploadId);
    expect(payload.partCount).toBe(3);
    expect(payload.partSize).toBe(5 * MIB);
    expect(payload.uploaded.map((part) => part.partNumber)).toEqual([2]);
    expect(payload.uploaded[0]?.size).toBe(5 * MIB);
    // Only what is missing gets a URL — a resumed upload re-sends the gaps, not the file.
    expect(payload.missing.map((part) => part.partNumber)).toEqual([1, 3]);
    expect(payload.missing.map((part) => part.length)).toEqual([5 * MIB, MIB]);
    for (const part of payload.missing) {
      expect(part.url).toBe(`${PRESIGNED_HOST}/${key}?upload=${uploadId}&part=${part.partNumber}`);
    }
  });

  test("the re-presigned URLs complete the upload the init URLs could no longer reach", async () => {
    const app = makeApp(multipartConfig);
    const size = 11 * MIB;
    const { id, key, uploadId } = await beginMultipart(app, size);
    // The client sends one part, then dies. Every URL the init handed out lapses.
    const first = await putPart(key, uploadId, 1, new Uint8Array(5 * MIB));

    const resumed = (await (await app.request(`/storage/${id}/parts`, { headers: { "x-user": ADA } })).json()) as {
      missing: { partNumber: number; length: number }[];
    };
    const reported = [first];
    for (const part of resumed.missing) {
      reported.push(await putPart(key, uploadId, part.partNumber, new Uint8Array(part.length)));
    }

    const completed = await app.request(`/storage/${id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user": ADA },
      body: JSON.stringify({ parts: reported }),
    });
    expect(completed.status).toBe(200);
    expect((await completed.json()) as { status: string; size: number }).toMatchObject({ status: "stored", size });
  });

  test("nothing is missing once every part has landed", async () => {
    const app = makeApp(multipartConfig);
    const { id, key, uploadId } = await beginMultipart(app, 11 * MIB);
    await putPart(key, uploadId, 1, new Uint8Array(5 * MIB));
    await putPart(key, uploadId, 2, new Uint8Array(5 * MIB));
    await putPart(key, uploadId, 3, new Uint8Array(MIB));

    const payload = (await (await app.request(`/storage/${id}/parts`, { headers: { "x-user": ADA } })).json()) as {
      uploaded: unknown[];
      missing: unknown[];
    };
    expect(payload.uploaded).toHaveLength(3);
    expect(payload.missing).toEqual([]);
  });

  test("someone else's in-flight upload reads as missing, and an anonymous caller is denied", async () => {
    const app = makeApp(multipartConfig);
    const { id } = await beginMultipart(app, 11 * MIB);
    expect((await app.request(`/storage/${id}/parts`)).status).toBe(401);
    const response = await app.request(`/storage/${id}/parts`, { headers: { "x-user": GRACE } });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("storage/not_found");
  });

  test("a finished upload has nothing to resume", async () => {
    const app = makeApp(multipartConfig);
    const { id } = await storeFile(app, ADA, "small.txt", "hello");
    const response = await app.request(`/storage/${id}/parts`, { headers: { "x-user": ADA } });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("storage/upload_incomplete");
  });

  test("an aborted upload has nothing to resume either — its parts are gone", async () => {
    const app = makeApp(multipartConfig);
    const { id } = await beginMultipart(app, 11 * MIB);
    await app.request(`/storage/${id}/abort`, { method: "POST", headers: { "x-user": ADA } });
    expect((await app.request(`/storage/${id}/parts`, { headers: { "x-user": ADA } })).status).toBe(409);
  });
});

describe("quota", () => {
  test("an upload that would exceed the owner's quota is refused at init, before a URL is minted", async () => {
    const app = makeApp({ quota: { bytesPerOwner: 100 } });
    const response = await init(app, ADA, { path: "a.bin", contentType: "application/octet-stream", size: 200 });
    expect(response.status).toBe(413);
    expect((response.json as unknown as { error: { code: string } }).error.code).toBe("storage/quota_exceeded");
    expect(await db.selectFrom(STORAGE_OBJECTS_TABLE).selectAll().execute()).toEqual([]);
  });

  test("one owner's usage does not count against another's", async () => {
    const app = makeApp({ quota: { bytesPerOwner: 100 } });
    expect((await init(app, ADA, { path: "a.bin", contentType: "text/plain", size: 100 })).status).toBe(201);
    expect((await init(app, GRACE, { path: "b.bin", contentType: "text/plain", size: 100 })).status).toBe(201);
  });

  test("ten concurrent inits against a one-slot quota reserve one slot, not ten", async () => {
    const app = makeApp({ quota: { bytesPerOwner: 100 } });
    const attempts = Array.from({ length: 10 }, (_, index) =>
      init(app, ADA, { path: `a${index}.bin`, contentType: "application/octet-stream", size: 100 }),
    );
    const responses = await Promise.all(attempts);

    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    for (const refused of responses.filter((response) => response.status !== 201)) {
      expect(refused.status).toBe(413);
      expect((refused.json as unknown as { error: { code: string } }).error.code).toBe("storage/quota_exceeded");
    }
    const rows = await db.selectFrom(STORAGE_OBJECTS_TABLE).select("size").execute();
    expect(rows.reduce((total, row) => total + (row.size ?? 0), 0)).toBeLessThanOrEqual(100);
  });

  test("concurrent copies of one file cannot each duplicate it past the limit", async () => {
    const app = makeApp({ quota: { bytesPerOwner: 20 } });
    const { id } = await storeFile(app, ADA, "a.txt", "hello");
    const copies = Array.from({ length: 6 }, (_, index) =>
      app.request(`/storage/${id}/copy`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-user": ADA },
        body: JSON.stringify({ path: `copy-${index}.txt` }),
      }),
    );
    const responses = await Promise.all(copies);

    // 5 stored + three 5-byte copies is exactly 20. A fourth would be 25.
    expect(responses.filter((response) => response.status === 201)).toHaveLength(3);
    const rows = await db.selectFrom(STORAGE_OBJECTS_TABLE).select("size").execute();
    expect(rows.reduce((total, row) => total + (row.size ?? 0), 0)).toBeLessThanOrEqual(20);
  });

  test("bytes past the declared size are re-asserted at completion, not waved through", async () => {
    // Part URLs carry no signed Content-Length, so a client can declare 11 MiB and PUT far more. The
    // reservation was 11 MiB; completion is where the real count is measured against the quota.
    const app = makeApp({
      partSizeBytes: 5 * MIB,
      multipartThresholdBytes: 5 * MIB,
      quota: { bytesPerOwner: 12 * MIB },
    });
    const declared = 11 * MIB;
    const created = await init(app, ADA, { path: "big.bin", contentType: "application/octet-stream", size: declared });
    const id = (created.json as unknown as { object: { id: string } }).object.id;
    const payload = created.json as unknown as { upload: { uploadId: string } };
    const row = await db.selectFrom(STORAGE_OBJECTS_TABLE).select("key").where("id", "=", id).executeTakeFirstOrThrow();

    // Three parts were planned; each one is oversized. 24 MiB lands against a 12 MiB quota.
    const reported = [];
    for (const partNumber of [1, 2, 3]) {
      reported.push(await putPart(row.key, payload.upload.uploadId, partNumber, new Uint8Array(8 * MIB)));
    }

    const completed = await app.request(`/storage/${id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user": ADA },
      body: JSON.stringify({ parts: reported }),
    });
    expect(completed.status).toBe(413);
    expect(((await completed.json()) as { error: { code: string } }).error.code).toBe("storage/quota_exceeded");

    // The bytes the owner was never granted are gone, and the row holds no reservation.
    expect(await bucket.head(row.key)).toBe(null);
    const stored = await db
      .selectFrom(STORAGE_OBJECTS_TABLE)
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(stored.status).toBe("failed");
    expect(await usedBytes(db, ADA)).toBe(0);
  });

  test("two completions racing on one owner cannot both bank their overshoot", async () => {
    // The settlement race. Both uploads reserved 11 MiB and both PUT 18 MiB, so each has a 7 MiB
    // overshoot to settle against a 30 MiB quota. Sequentially the second is refused: 29 MiB is held
    // and 7 more does not fit. A check that ran ahead of the write lets both read the same 22 MiB
    // total, lets both pass, and leaves the owner holding 36 MiB of a 30 MiB quota.
    const app = makeApp({
      partSizeBytes: 5 * MIB,
      multipartThresholdBytes: 5 * MIB,
      quota: { bytesPerOwner: 30 * MIB },
    });
    const declared = 11 * MIB;

    const uploads = [];
    for (const name of ["one.bin", "two.bin"]) {
      const created = await init(app, ADA, { path: name, contentType: "application/octet-stream", size: declared });
      const payload = created.json as unknown as { object: { id: string }; upload: { uploadId: string } };
      const row = await db
        .selectFrom(STORAGE_OBJECTS_TABLE)
        .select("key")
        .where("id", "=", payload.object.id)
        .executeTakeFirstOrThrow();
      const reported = [];
      for (const partNumber of [1, 2, 3]) {
        reported.push(await putPart(row.key, payload.upload.uploadId, partNumber, new Uint8Array(6 * MIB)));
      }
      uploads.push({ id: payload.object.id, reported });
    }

    const responses = await Promise.all(
      uploads.map((upload) =>
        app.request(`/storage/${upload.id}/complete`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-user": ADA },
          body: JSON.stringify({ parts: upload.reported }),
        }),
      ),
    );

    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    for (const refused of responses.filter((response) => response.status !== 200)) {
      expect(refused.status).toBe(413);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("storage/quota_exceeded");
    }
    // The invariant the whole quota exists for, asserted on the database rather than on the responses.
    expect(await usedBytes(db, ADA)).toBeLessThanOrEqual(30 * MIB);
  });

  test("an overshoot that still fits the quota completes and records the real size", async () => {
    const app = makeApp({
      partSizeBytes: 5 * MIB,
      multipartThresholdBytes: 5 * MIB,
      quota: { bytesPerOwner: 30 * MIB },
    });
    const created = await init(app, ADA, { path: "big.bin", contentType: "application/octet-stream", size: 11 * MIB });
    const id = (created.json as unknown as { object: { id: string } }).object.id;
    const payload = created.json as unknown as { upload: { uploadId: string } };
    const row = await db.selectFrom(STORAGE_OBJECTS_TABLE).select("key").where("id", "=", id).executeTakeFirstOrThrow();

    const reported = [];
    for (const partNumber of [1, 2, 3]) {
      reported.push(await putPart(row.key, payload.upload.uploadId, partNumber, new Uint8Array(6 * MIB)));
    }

    const completed = await app.request(`/storage/${id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user": ADA },
      body: JSON.stringify({ parts: reported }),
    });
    expect(completed.status).toBe(200);
    expect((await completed.json()) as { size: number }).toMatchObject({ status: "stored", size: 18 * MIB });
    expect(await usedBytes(db, ADA)).toBe(18 * MIB);
  });
});

describe("serving bytes", () => {
  const body = "the quick brown fox jumps over the lazy dog";

  test("a whole read is 200 with the object's headers", async () => {
    const app = makeApp();
    const { id } = await storeFile(app, ADA, "fox.txt", body);
    const response = await app.request(`/storage/${id}`, { headers: { "x-user": ADA } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe(String(body.length));
    expect(response.headers.get("Content-Type")).toBe("text/plain");
    expect(response.headers.get("Content-Disposition")).toContain('filename="fox.txt"');
    expect(await response.text()).toBe(body);
  });

  test("a Range request is 206 with only those bytes", async () => {
    const app = makeApp();
    const { id } = await storeFile(app, ADA, "fox.txt", body);
    const response = await app.request(`/storage/${id}`, { headers: { "x-user": ADA, range: "bytes=4-8" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(`bytes 4-8/${body.length}`);
    expect(await response.text()).toBe("quick");
  });

  test("a suffix Range reads from the end", async () => {
    const app = makeApp();
    const { id } = await storeFile(app, ADA, "fox.txt", body);
    const response = await app.request(`/storage/${id}`, { headers: { "x-user": ADA, range: "bytes=-3" } });
    expect(response.status).toBe(206);
    expect(await response.text()).toBe("dog");
  });

  test("a range past the end is 416, and never touches R2", async () => {
    const app = makeApp();
    const { id } = await storeFile(app, ADA, "fox.txt", body);
    const response = await app.request(`/storage/${id}`, { headers: { "x-user": ADA, range: "bytes=9999-" } });
    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe(`bytes */${body.length}`);
  });

  test("If-None-Match against the current etag is 304 with no body", async () => {
    const app = makeApp();
    const { id } = await storeFile(app, ADA, "fox.txt", body);
    const first = await app.request(`/storage/${id}`, { headers: { "x-user": ADA } });
    const etag = first.headers.get("ETag") ?? "";
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);

    const second = await app.request(`/storage/${id}`, { headers: { "x-user": ADA, "if-none-match": etag } });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
  });

  test("If-None-Match against a stale etag serves the bytes", async () => {
    const app = makeApp();
    const { id } = await storeFile(app, ADA, "fox.txt", body);
    const response = await app.request(`/storage/${id}`, {
      headers: { "x-user": ADA, "if-none-match": `"${"0".repeat(32)}"` },
    });
    expect(response.status).toBe(200);
  });

  test("?download=1 switches the disposition to attachment", async () => {
    const app = makeApp();
    const { id } = await storeFile(app, ADA, "fox.txt", body);
    const response = await app.request(`/storage/${id}?download=1`, { headers: { "x-user": ADA } });
    expect(response.headers.get("Content-Disposition")).toMatch(/^attachment;/);
  });

  test("HEAD answers with the same headers and no body", async () => {
    const app = makeApp();
    const { id } = await storeFile(app, ADA, "fox.txt", body);
    const response = await app.request(`/storage/${id}`, { method: "HEAD", headers: { "x-user": ADA } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe(String(body.length));
    expect(await response.text()).toBe("");
  });

  test("a pending object has a record but no bytes, and says so", async () => {
    const app = makeApp();
    const created = await init(app, ADA, { path: "a.txt", contentType: "text/plain", size: 5 });
    const id = (created.json as unknown as { object: { id: string } }).object.id;
    const response = await app.request(`/storage/${id}`, { headers: { "x-user": ADA } });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("storage/upload_incomplete");
  });

  test("the presigned URL route hands back a short-lived direct link", async () => {
    const app = makeApp();
    const { id, key } = await storeFile(app, ADA, "fox.txt", body);
    const response = await app.request(`/storage/${id}/url`, { headers: { "x-user": ADA } });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { url: string; expiresInSeconds: number };
    expect(payload.url).toContain(key);
    expect(payload.expiresInSeconds).toBe(300);
  });
});

describe("a hostile upload cannot execute on the adopter's origin", () => {
  /**
   * The attack, end to end: declare a harmless type at init, PUT bytes R2 stores under an active one
   * (a presigned PUT cannot sign `Content-Type`, so nothing stops this), pin `inline` while you are
   * there, and read it back from an origin the adopter shares with every other Pithy route.
   */
  async function storeHostile(
    app: Hono<PithyHonoEnv>,
    options: { path: string; declared: string; stored: string; body: string; visibility?: string },
  ) {
    const created = await init(app, ADA, {
      path: options.path,
      contentType: options.declared,
      size: new TextEncoder().encode(options.body).length,
      ...(options.visibility ? { visibility: options.visibility } : {}),
    });
    const id = (created.json as unknown as { object: { id: string } }).object.id;
    const row = await db.selectFrom(STORAGE_OBJECTS_TABLE).select("key").where("id", "=", id).executeTakeFirstOrThrow();
    await bucket.put(row.key, options.body, {
      httpMetadata: { contentType: options.stored, contentDisposition: "inline" },
    });
    const completed = await app.request(`/storage/${id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user": ADA },
      body: JSON.stringify({}),
    });
    expect(completed.status).toBe(200);
    return { id, completed: (await completed.json()) as { contentType: string } };
  }

  test("complete records the type R2 stored, not the type the client declared", async () => {
    const app = makeApp();
    const { id, completed } = await storeHostile(app, {
      path: "avatar.png",
      declared: "image/png",
      stored: "text/html",
      body: "<script>alert(1)</script>",
    });
    expect(completed.contentType).toBe("text/html");
    const row = await db
      .selectFrom(STORAGE_OBJECTS_TABLE)
      .select("contentType")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row.contentType).toBe("text/html");
  });

  test("a public HTML upload is served neutralised, with the headers that make it inert", async () => {
    const app = makeApp();
    const { id } = await storeHostile(app, {
      path: "evil.html",
      declared: "image/png",
      stored: "text/html",
      body: "<script>alert(1)</script>",
      visibility: "public",
    });
    // No session at all — this is exactly the request any visitor would make.
    const response = await app.request(`/storage/${id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response.headers.get("Content-Disposition")).toMatch(/^attachment;/);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
  });

  test("a share link serves an SVG as an attachment too — the same builder answers both routes", async () => {
    const app = makeApp();
    const { id } = await storeHostile(app, {
      path: "logo.svg",
      declared: "image/png",
      stored: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    });
    const minted = await app.request(`/storage/${id}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user": ADA },
      body: JSON.stringify({}),
    });
    const share = (await minted.json()) as { token: string };

    const fetched = await app.request(`/s/${share.token}`);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(fetched.headers.get("Content-Disposition")).toMatch(/^attachment;/);
    expect(fetched.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(fetched.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
  });

  test("an inert upload is untouched — the rule neutralises active types, not every type", async () => {
    const app = makeApp();
    const { id } = await storeHostile(app, {
      path: "photo.png",
      declared: "image/png",
      stored: "image/png",
      body: "not really a png",
      visibility: "public",
    });
    const response = await app.request(`/storage/${id}`);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    // The uploader stored `inline` and gets `inline` here — but derived, with the server's filename.
    expect(response.headers.get("Content-Disposition")).toBe(
      `inline; filename="photo.png"; filename*=UTF-8''${encodeURIComponent("photo.png")}`,
    );
  });
});

describe("rename, copy, delete", () => {
  test("a rename changes the path and leaves the bytes where they are", async () => {
    const app = makeApp();
    const { id, key } = await storeFile(app, ADA, "old.txt", "hello");
    const response = await app.request(`/storage/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-user": ADA },
      body: JSON.stringify({ path: "new/name.txt", visibility: "public" }),
    });
    expect(response.status).toBe(200);
    const object = (await response.json()) as { path: string; visibility: string };
    expect(object.path).toBe("new/name.txt");
    expect(object.visibility).toBe("public");
    expect(await bucket.head(key)).not.toBe(null);
  });

  test("an empty patch is refused rather than silently doing nothing", async () => {
    const app = makeApp();
    const { id } = await storeFile(app, ADA, "a.txt", "hello");
    const response = await app.request(`/storage/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-user": ADA },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });

  test("a copy is a new object with its own key, and is private even when the source was public", async () => {
    const app = makeApp();
    const { id } = await storeFile(app, ADA, "public/a.txt", "hello", "public");
    const response = await app.request(`/storage/${id}/copy`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user": ADA },
      body: JSON.stringify({ path: "ada/copy.txt" }),
    });
    expect(response.status).toBe(201);
    const copy = (await response.json()) as { id: string; ownerId: string; visibility: string; path: string };
    expect(copy.id).not.toBe(id);
    expect(copy.ownerId).toBe(ADA);
    // Republishing is a decision, so a copy never inherits `public`.
    expect(copy.visibility).toBe("private");

    const fetched = await app.request(`/storage/${copy.id}`, { headers: { "x-user": ADA } });
    expect(await fetched.text()).toBe("hello");
  });

  test("copy is owner-scoped: a reader of a public file cannot duplicate it onto the owner's bill", async () => {
    const app = makeApp();
    const { id } = await storeFile(app, ADA, "public/a.txt", "hello", "public");
    const response = await app.request(`/storage/${id}/copy`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user": GRACE },
      body: JSON.stringify({ path: "graces/copy.txt" }),
    });
    expect(response.status).toBe(403);
  });

  test("a delete removes the row and the bytes", async () => {
    const app = makeApp();
    const { id, key } = await storeFile(app, ADA, "a.txt", "hello");
    const response = await app.request(`/storage/${id}`, { method: "DELETE", headers: { "x-user": ADA } });
    expect(response.status).toBe(200);
    expect(await bucket.head(key)).toBe(null);
    expect(await db.selectFrom(STORAGE_OBJECTS_TABLE).selectAll().where("id", "=", id).execute()).toEqual([]);
  });
});

describe("listing", () => {
  test("lists only the caller's own files, ordered by path", async () => {
    const app = makeApp();
    await storeFile(app, ADA, "b.txt", "b");
    await storeFile(app, ADA, "a.txt", "a");
    await storeFile(app, GRACE, "c.txt", "c");
    const response = await app.request("/storage", { headers: { "x-user": ADA } });
    const payload = (await response.json()) as { objects: { path: string }[] };
    expect(payload.objects.map((object) => object.path)).toEqual(["a.txt", "b.txt"]);
  });

  test("a prefix narrows the listing, and a literal % in a path is not a wildcard", async () => {
    const app = makeApp();
    await storeFile(app, ADA, "invoices/1.txt", "1");
    await storeFile(app, ADA, "invoices/2.txt", "2");
    await storeFile(app, ADA, "notes/1.txt", "3");
    const scoped = await app.request("/storage?prefix=invoices/", { headers: { "x-user": ADA } });
    expect(((await scoped.json()) as { objects: unknown[] }).objects).toHaveLength(2);

    const wildcard = await app.request("/storage?prefix=%25", { headers: { "x-user": ADA } });
    expect(((await wildcard.json()) as { objects: unknown[] }).objects).toHaveLength(0);
  });

  test("a cursor walks the whole set exactly once", async () => {
    const app = makeApp();
    for (const name of ["a", "b", "c", "d", "e"]) await storeFile(app, ADA, `${name}.txt`, name);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const query = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : "?limit=2";
      const response = await app.request(`/storage${query}`, { headers: { "x-user": ADA } });
      const payload = (await response.json()) as { objects: { path: string }[]; cursor?: string };
      seen.push(...payload.objects.map((object) => object.path));
      cursor = payload.cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"]);
  });
});

describe("share links", () => {
  test("a share token fetches the bytes with no session", async () => {
    const app = makeApp();
    const { id } = await storeFile(app, ADA, "private/a.txt", "hello");
    const minted = await app.request(`/storage/${id}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user": ADA },
      body: JSON.stringify({}),
    });
    expect(minted.status).toBe(201);
    const share = (await minted.json()) as { token: string; expiresAt: string | null };
    expect(share.expiresAt).toBe(null);

    const fetched = await app.request(`/s/${share.token}`);
    expect(fetched.status).toBe(200);
    expect(await fetched.text()).toBe("hello");
  });

  test("a revoked share is refused with storage/share_revoked — not merely 'gone'", async () => {
    const app = makeApp();
    const { id } = await storeFile(app, ADA, "private/a.txt", "hello");
    const minted = await app.request(`/storage/${id}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user": ADA },
      body: JSON.stringify({}),
    });
    const { token } = (await minted.json()) as { token: string };

    const revoked = await app.request(`/storage/shares/${token}`, { method: "DELETE", headers: { "x-user": ADA } });
    expect(revoked.status).toBe(200);

    const fetched = await app.request(`/s/${token}`);
    expect(fetched.status).toBe(410);
    expect(((await fetched.json()) as { error: { code: string } }).error.code).toBe("storage/share_revoked");
  });

  test("an expired share is refused with storage/share_expired — a different fact, worth a different code", async () => {
    const app = makeApp();
    const { id } = await storeFile(app, ADA, "private/a.txt", "hello");
    const minted = await app.request(`/storage/${id}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user": ADA },
      body: JSON.stringify({ expiresInSeconds: 60 }),
    });
    const { token } = (await minted.json()) as { token: string };

    clock = new Date(clock.getTime() + 61_000);
    const fetched = await app.request(`/s/${token}`);
    expect(fetched.status).toBe(410);
    expect(((await fetched.json()) as { error: { code: string } }).error.code).toBe("storage/share_expired");
  });

  test("revoking someone else's share is refused", async () => {
    const app = makeApp();
    const { id } = await storeFile(app, ADA, "private/a.txt", "hello");
    const minted = await app.request(`/storage/${id}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user": ADA },
      body: JSON.stringify({}),
    });
    const { token } = (await minted.json()) as { token: string };
    const response = await app.request(`/storage/shares/${token}`, { method: "DELETE", headers: { "x-user": GRACE } });
    expect(response.status).toBe(404);
  });

  test("DELETE /storage/shares/:token revokes a share rather than deleting an object called `shares`", async () => {
    const app = makeApp();
    const { id } = await storeFile(app, ADA, "private/a.txt", "hello");
    const minted = await app.request(`/storage/${id}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user": ADA },
      body: JSON.stringify({}),
    });
    const { token } = (await minted.json()) as { token: string };
    const response = await app.request(`/storage/shares/${token}`, { method: "DELETE", headers: { "x-user": ADA } });
    // A revoke answers with the token; an object delete would have answered with an id.
    expect(await response.json()).toMatchObject({ token });
  });

  test("deleting the object takes its share links with it", async () => {
    const app = makeApp();
    const { id } = await storeFile(app, ADA, "private/a.txt", "hello");
    const minted = await app.request(`/storage/${id}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user": ADA },
      body: JSON.stringify({}),
    });
    const { token } = (await minted.json()) as { token: string };
    await app.request(`/storage/${id}`, { method: "DELETE", headers: { "x-user": ADA } });

    expect(await db.selectFrom(STORAGE_SHARES_TABLE).selectAll().where("token", "=", token).execute()).toEqual([]);
    expect((await app.request(`/s/${token}`)).status).toBe(404);
  });
});

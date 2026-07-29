import type { StorageConfig } from "../config/config";
import { StorageShare } from "../data/share";
import { StorageObject } from "../data/storageObject";
import { STORAGE_OBJECTS_TABLE, STORAGE_SHARES_TABLE, type StorageDatabase } from "../data/tables";
import {
  StorageForbiddenError,
  StorageNotFoundError,
  StorageShareExpiredError,
  StorageShareRevokedError,
  StorageUploadIncompleteError,
} from "../error/errors";
import { deriveObjectKey } from "../object/key";
import { collectParts, needsMultipart, planMultipart } from "../object/multipart";
import type { ObjectStore, UploadedPart } from "../object/store";
import { assertWithinQuota, insertReservingQuota, updateSettlingQuota } from "../quota/quota";
import type {
  CompleteUploadInput,
  CopyObjectInput,
  CreateShareInput,
  CreateUploadInput,
  ListObjectsQuery,
  UpdateObjectInput,
} from "./schemas";

/**
 * The storage request handlers — pure functions over injected dependencies, so every branch is tested
 * against real D1 and real R2 without standing up a Worker. `routes.ts` is a thin shell that resolves
 * these dependencies from the request env and maps their results onto responses.
 *
 * **Request shape is not validated here.** Each route declares its own schemas with
 * `zValidator(target, Schema, validationHook)` and hands the handler the already-parsed value, so a
 * malformed request is refused before a dependency is resolved or a row is read. What survives in
 * these handlers is everything a request schema cannot express — ownership, quota, upload state —
 * which is the whole of what they were ever really about.
 *
 * **The object key never leaves this module.** Every client-facing shape goes through {@link view},
 * which drops `key` and `uploadId`. That is not tidiness: the key is the only thing a presigned URL
 * addresses, so a key in a response body is a capability leak waiting for the first adopter who logs
 * their API responses.
 *
 * **A file you cannot see reads as missing.** `assertOwner` answers `storage/not_found` for a private
 * object owned by someone else and `storage/forbidden` only when the object is already public —
 * because a 403 on a private object confirms it exists, which is exactly the oracle an enumeration
 * attack wants. Public objects have nothing left to hide, so there the honest answer is the useful one.
 */

/** Everything a handler needs, all injectable. */
export interface HandlerDeps {
  /** The storage database. */
  db: StorageDatabase;
  /** The object plane — presigning, the multipart lifecycle, and binding-backed reads. */
  store: ObjectStore;
  /** The resolved storage config: quota, multipart sizing, default visibility. */
  config: StorageConfig;
  /** The authenticated caller from the core `AuthContext` seam, or null for an unauthenticated read. */
  ownerId: string | null;
  /** Mints an object id. */
  newId: () => string;
  /** Mints a share token. */
  newToken: () => string;
  /** The current time. */
  now: () => Date;
}

/** The client-facing shape of a stored file. Deliberately without `key` and `uploadId`. */
export interface StorageObjectView {
  id: string;
  path: string;
  ownerId: string | null;
  contentType: string;
  size: number | null;
  visibility: "private" | "public";
  checksum: string | null;
  status: "pending" | "stored" | "failed";
  createdAt: Date;
  updatedAt: Date;
}

/** One part of a multipart upload, with the URL the client PUTs those bytes to. */
export interface UploadPartTarget {
  partNumber: number;
  offset: number;
  length: number;
  url: string;
}

/** Where to send the bytes: one URL, or one per part. */
export type UploadTarget =
  | { kind: "single"; url: string }
  | { kind: "multipart"; uploadId: string; partSize: number; parts: UploadPartTarget[] };

/** What an upload-init answers with: the record's coordinates and where the bytes go. */
export interface UploadInitResult {
  object: StorageObjectView;
  upload: UploadTarget;
}

/** A minted share link. */
export interface ShareView {
  token: string;
  objectId: string;
  expiresAt: Date | null;
  createdAt: Date;
}

/** Drop the server-only fields. The single place a row becomes something a client may see. */
function view(object: StorageObject): StorageObjectView {
  return {
    id: object.id,
    path: object.path,
    ownerId: object.ownerId,
    contentType: object.contentType,
    size: object.size,
    visibility: object.visibility,
    checksum: object.checksum,
    status: object.status,
    createdAt: object.createdAt,
    updatedAt: object.updatedAt,
  };
}

/** Load one row, decoded through the schema. Null when absent. */
async function findObject(deps: HandlerDeps, id: string): Promise<StorageObject | null> {
  const row = await deps.db.selectFrom(STORAGE_OBJECTS_TABLE).selectAll().where("id", "=", id).executeTakeFirst();
  return row ? StorageObject.parse(row) : null;
}

/** Load one row or throw `storage/not_found`. */
async function loadObject(deps: HandlerDeps, id: string): Promise<StorageObject> {
  const object = await findObject(deps, id);
  if (!object) throw new StorageNotFoundError({ detail: `no storage object ${id}` });
  return object;
}

/**
 * Require the caller to own the object. A private object they do not own is reported as **missing**,
 * so the route cannot be used to test whether an id exists. A public object is reported as
 * **forbidden**, because its existence is already public knowledge and "missing" would just be a lie.
 */
function assertOwner(object: StorageObject, ownerId: string | null): void {
  if (ownerId !== null && object.ownerId === ownerId) return;
  if (object.visibility === "public") {
    throw new StorageForbiddenError({ detail: `object ${object.id} is owned by ${object.ownerId ?? "the system"}` });
  }
  throw new StorageNotFoundError({ detail: `object ${object.id} is not owned by ${ownerId ?? "an anonymous caller"}` });
}

/** Require the caller to be allowed to *read* the object: it is public, or it is theirs. */
function assertReadable(object: StorageObject, ownerId: string | null): void {
  if (object.visibility === "public") return;
  if (ownerId !== null && object.ownerId === ownerId) return;
  throw new StorageNotFoundError({
    detail: `object ${object.id} is not readable by ${ownerId ?? "an anonymous caller"}`,
  });
}

/** Require the object's bytes to actually be there. A `pending` row has a record but no content. */
function assertStored(object: StorageObject): void {
  if (object.status === "stored") return;
  throw new StorageUploadIncompleteError({ detail: `object ${object.id} is ${object.status}, not stored` });
}

/** Write a whole row back through the codec — the round-trip rule, so no field bypasses its codec. */
async function saveObject(deps: HandlerDeps, object: StorageObject): Promise<StorageObject> {
  const record = StorageObject.encode(object);
  await deps.db.updateTable(STORAGE_OBJECTS_TABLE).set(record).where("id", "=", object.id).execute();
  return object;
}

/**
 * Start an upload: reserve the row and its quota, then mint the URL(s) the client PUTs to.
 *
 * **The reservation is the insert, and the insert is conditional.** A `pending` row holds its bytes
 * against the owner's quota, so the row has to exist before an upload can proceed — but a check that
 * ran separately from the write would let a burst of concurrent inits each read a used total none of
 * them had yet contributed to. `insertReservingQuota` evaluates the sum inside the write instead, so
 * the tenth concurrent init sees the other nine (`quota/quota.ts`).
 *
 * The pre-check above it is a courtesy: it refuses an obviously oversized upload before an R2
 * multipart upload exists to clean up. When the conditional insert loses the race anyway, that
 * multipart upload is aborted — a refused init leaves R2 holding nothing.
 */
export async function initUpload(deps: HandlerDeps, input: CreateUploadInput): Promise<UploadInitResult> {
  const now = deps.now();

  await assertWithinQuota({
    db: deps.db,
    ownerId: deps.ownerId,
    limitBytes: deps.config.quota.bytesPerOwner,
    additionalBytes: input.size,
  });

  const key = deriveObjectKey();
  const multipart = needsMultipart(input.size, deps.config.multipartThresholdBytes);

  let upload: UploadTarget;
  let uploadId: string | null = null;
  if (multipart) {
    const plan = planMultipart(input.size, deps.config.partSizeBytes);
    uploadId = await deps.store.initMultipart(key, input.contentType);
    const parts: UploadPartTarget[] = [];
    for (const part of plan.parts) {
      parts.push({
        partNumber: part.partNumber,
        offset: part.offset,
        length: part.length,
        url: await deps.store.presignPart(key, uploadId, part.partNumber),
      });
    }
    upload = { kind: "multipart", uploadId, partSize: plan.partSize, parts };
  } else {
    upload = { kind: "single", url: await deps.store.presignPut(key, input.contentType, input.size) };
  }

  const object: StorageObject = {
    id: deps.newId(),
    key,
    path: input.path,
    ownerId: deps.ownerId,
    contentType: input.contentType,
    size: input.size,
    visibility: input.visibility ?? deps.config.defaultVisibility,
    checksum: null,
    status: "pending",
    uploadId,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await insertReservingQuota({
      db: deps.db,
      ownerId: deps.ownerId,
      limitBytes: deps.config.quota.bytesPerOwner,
      additionalBytes: input.size,
      record: StorageObject.encode(object),
    });
  } catch (error) {
    // The row never landed, so nothing will ever complete or abort this upload. Discard it here or R2
    // holds orphaned parts until the sweep notices.
    if (uploadId) await deps.store.abortMultipart(key, uploadId).catch(() => {});
    throw error;
  }

  return { object: view(object), upload };
}

/**
 * Finalize an upload: assemble the parts (for a multipart), then confirm against R2 that the bytes
 * are really there before the row is allowed to claim they are.
 *
 * The `head` is not a formality. Without it a client could complete an upload it never performed and
 * leave a `stored` row pointing at nothing — a 404 from R2 at read time, long after the request that
 * caused it. The size *and the content type* R2 reports win over the declared ones, so the row records
 * what was stored rather than what was promised.
 *
 * **It is also where the quota is settled.** Part URLs carry no signed `Content-Length` — the final
 * part's differs from every other, so pinning one at mint time would mean knowing the total up front
 * and would still leave the last part unconstrained. The declared size therefore buys a *reservation*,
 * not a limit, and an owner who declares 100 MiB can PUT far more across those URLs. Completion is the
 * first and last point where the real byte count is known and the object can still be thrown away, so
 * anything past the reservation is re-asserted against the quota here.
 *
 * **That re-assertion is the write, for the same reason the reservation was.** A check that ran ahead
 * of the `UPDATE` would let two completions racing on one owner both read a total neither had yet
 * contributed to, both pass, and both store — the init race, reproduced at the other end of the
 * lifecycle. `updateSettlingQuota` evaluates the sum inside the update, so the second completion sees
 * the first (`quota/quota.ts`).
 */
export async function completeUpload(
  deps: HandlerDeps,
  id: string,
  input: CompleteUploadInput,
): Promise<StorageObjectView> {
  const object = await loadObject(deps, id);
  assertOwner(object, deps.ownerId);
  // Completing twice is a no-op rather than an error: a client that retried a dropped response gets
  // the same answer, which is what makes the route safe to retry at all.
  if (object.status === "stored") return view(object);
  if (object.status !== "pending") {
    throw new StorageUploadIncompleteError({ detail: `object ${id} is ${object.status} and cannot be completed` });
  }

  if (object.uploadId) {
    const expected = planMultipart(object.size ?? 0, deps.config.partSizeBytes).partCount;
    const parts = collectParts(input.parts, expected);
    await deps.store.completeMultipart(object.key, object.uploadId, parts);
  }

  const metadata = await deps.store.head(object.key);
  if (!metadata) {
    throw new StorageUploadIncompleteError({
      message: "No bytes were uploaded for that file.",
      action: "Upload to the URL the init call returned, then complete again.",
      detail: `R2 has no object at ${object.key}`,
    });
  }

  const settled: StorageObject = {
    ...object,
    status: "stored",
    size: metadata.size,
    // The declared type is not enforceable: S3 presigning marks `content-type` unsignable, so a
    // client may PUT any type it likes to the URL it was given. Reconcile rather than reject — the
    // bytes are already stored and paid for, and a row that disagrees with the object is the actual
    // defect. R2 reporting no type at all leaves the declaration standing; it is all we have.
    contentType: metadata.contentType ?? object.contentType,
    checksum: input.checksum ?? metadata.checksumSha256 ?? null,
    uploadId: null,
    updatedAt: deps.now(),
  };

  // The pending row already reserves its declared size, and the quota sum still counts it — so only
  // the overshoot is new. Settling against `metadata.size` would bill the reservation twice.
  const overshoot = metadata.size - (object.size ?? 0);
  // An upload smaller than it declared claims nothing further, so it is written unconditionally. A
  // quota an adopter lowered under an in-flight upload must not turn a shrinking completion into a
  // deletion of bytes the owner was, at reservation time, granted.
  if (overshoot <= 0) return view(await saveObject(deps, settled));

  try {
    await updateSettlingQuota({
      db: deps.db,
      ownerId: object.ownerId,
      limitBytes: deps.config.quota.bytesPerOwner,
      additionalBytes: overshoot,
      record: StorageObject.encode(settled),
    });
  } catch (error) {
    // Do not keep bytes the owner was never granted. The object goes, and the row goes `failed`,
    // which returns the reservation — the same end state an abort reaches. The delete is best-effort,
    // so a transient R2 failure can leave the object behind; the `failed` row no longer claims its
    // key, so the orphan sweep collects it (`workflows/sweep.ts`).
    await deps.store.delete(object.key).catch(() => {});
    await saveObject(deps, { ...object, status: "failed", uploadId: null, updatedAt: deps.now() });
    throw error;
  }
  return view(settled);
}

/**
 * Abandon an in-flight upload: tell R2 to discard the stored parts, then mark the row `failed`.
 *
 * The row survives rather than being deleted. `failed` rows are excluded from the quota sum, so they
 * hold nothing, and keeping them means an owner can see that an upload was attempted and abandoned
 * instead of the record silently evaporating.
 *
 * **The bytes are R2's problem after this, not the row's.** A single-PUT abort cannot revoke the
 * presigned URL it handed out — nothing can, which is the whole cost of presigning — so a client may
 * still PUT to it for the rest of that URL's hour, after the delete below has run. The row that
 * survives therefore stops *claiming* its key the moment it goes `failed`: the orphan sweep matches
 * only rows that bill for a key, so anything that lands afterwards is collected as an orphan rather
 * than sheltered forever by a row that counts toward no quota (`workflows/sweep.ts`).
 */
export async function abortUpload(deps: HandlerDeps, id: string): Promise<StorageObjectView> {
  const object = await loadObject(deps, id);
  assertOwner(object, deps.ownerId);
  if (object.status === "stored") {
    throw new StorageUploadIncompleteError({
      message: "That upload already finished.",
      action: "Delete the file instead.",
      detail: `object ${id} is stored`,
    });
  }
  if (object.uploadId) await deps.store.abortMultipart(object.key, object.uploadId);
  // A single-PUT upload may have landed whole even though it was never completed; drop those bytes
  // too, so aborting never leaves an object the sweep has to find later.
  await deps.store.delete(object.key);

  return view(await saveObject(deps, { ...object, status: "failed", uploadId: null, updatedAt: deps.now() }));
}

/** Where a resuming client stands: what R2 already holds, and a live URL for everything it does not. */
export interface UploadPartsResult {
  uploadId: string;
  partSize: number;
  partCount: number;
  uploaded: UploadedPart[];
  missing: UploadPartTarget[];
}

/**
 * Resume a multipart upload: the parts R2 already holds, plus a **freshly presigned** URL for each
 * one still missing.
 *
 * This is what makes multipart resumable at all. `initUpload` presigns every part once, and those
 * URLs lapse an hour later — a 40 GiB upload is 640 of them, and a client that stalls or dies has no
 * way back to the ones it never sent. Re-minting them here is the recovery path, and it is a route
 * rather than a longer TTL because a presigned URL cannot be revoked: minting on demand keeps each
 * one's life short and its issue authorized.
 *
 * Only while the row is `pending`. A `stored` row has no upload left to resume, and a `failed` one had
 * its parts discarded — re-presigning against either would hand out URLs addressing nothing.
 */
export async function listUploadParts(deps: HandlerDeps, id: string): Promise<UploadPartsResult> {
  const object = await loadObject(deps, id);
  assertOwner(object, deps.ownerId);
  const uploadId = object.uploadId;
  if (object.status !== "pending" || !uploadId) {
    throw new StorageUploadIncompleteError({
      message: "That upload has no parts to resume.",
      action: "Only an in-flight multipart upload can be resumed. Start a new upload.",
      detail: `object ${id} is ${object.status} with uploadId ${uploadId ?? "null"}`,
    });
  }

  const plan = planMultipart(object.size ?? 0, deps.config.partSizeBytes);
  const uploaded = await deps.store.listParts(object.key, uploadId);
  const stored = new Set(uploaded.map((part) => part.partNumber));
  const missing: UploadPartTarget[] = [];
  for (const part of plan.parts) {
    if (stored.has(part.partNumber)) continue;
    missing.push({
      partNumber: part.partNumber,
      offset: part.offset,
      length: part.length,
      url: await deps.store.presignPart(object.key, uploadId, part.partNumber),
    });
  }

  return { uploadId, partSize: plan.partSize, partCount: plan.partCount, uploaded, missing };
}

/** The keyset a list cursor encodes: the last row's path and id, which together are unique. */
interface ListCursor {
  path: string;
  id: string;
}

/**
 * Encode a cursor. Keyset, not offset: an `OFFSET` page skips rows a concurrent upload shifted, so a
 * client paging through their files while uploading would miss some. Base64url keeps it opaque, which
 * is the point — the shape is ours to change.
 */
function encodeCursor(cursor: ListCursor): string {
  const json = JSON.stringify(cursor);
  const bytes = new TextEncoder().encode(json);
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode a cursor, or `null` when it is not one we minted. A bad cursor starts from the beginning. */
function decodeCursor(value: string | undefined): ListCursor | null {
  if (!value) return null;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { path, id } = parsed as Partial<ListCursor>;
    return typeof path === "string" && typeof id === "string" ? { path, id } : null;
  } catch {
    return null;
  }
}

/** Default page size — generous enough for a file browser, small enough to stay one index read. */
const DEFAULT_LIST_LIMIT = 50;

/**
 * One page of the caller's files, ordered by logical path. Scoped to the authenticated owner: there
 * is no way to list another owner's files, and no parameter that could be made to.
 */
export async function listObjects(
  deps: HandlerDeps,
  query: ListObjectsQuery,
): Promise<{ objects: StorageObjectView[]; cursor?: string }> {
  const limit = query.limit ?? DEFAULT_LIST_LIMIT;
  const after = decodeCursor(query.cursor);

  let statement = deps.db
    .selectFrom(STORAGE_OBJECTS_TABLE)
    .selectAll()
    .where("ownerId", "=", deps.ownerId)
    .orderBy("path", "asc")
    .orderBy("id", "asc")
    // One extra row is what distinguishes "this page is full" from "there is another page", without
    // a second count query.
    .limit(limit + 1);

  if (query.prefix) {
    // `LIKE` with an escaped prefix, so a `%` or `_` in an adopter's path is a literal character and
    // not a wildcard that would widen the listing.
    const escaped = query.prefix.replace(/[\\%_]/g, (character) => `\\${character}`);
    statement = statement.where("path", "like", `${escaped}%`);
  }
  if (after) {
    statement = statement.where((eb) =>
      eb.or([eb("path", ">", after.path), eb.and([eb("path", "=", after.path), eb("id", ">", after.id)])]),
    );
  }

  const rows = await statement.execute();
  const page = rows.slice(0, limit).map((row) => StorageObject.parse(row));
  const objects = page.map(view);
  if (rows.length <= limit) return { objects };
  const last = page[page.length - 1];
  return last ? { objects, cursor: encodeCursor({ path: last.path, id: last.id }) } : { objects };
}

/** Load an object for reading, enforcing public-or-owner and that its bytes exist. */
export async function readableObject(deps: HandlerDeps, id: string): Promise<StorageObject> {
  const object = await loadObject(deps, id);
  assertReadable(object, deps.ownerId);
  assertStored(object);
  return object;
}

/** How long a direct-download URL stays valid. Short: it is bearer-equivalent and cannot be revoked. */
export const PRESIGNED_URL_TTL_SECONDS = 300;

/**
 * Mint a presigned GET — the no-Worker-in-the-byte-path escape hatch.
 *
 * Authorization happens **here**, once, and then the URL is on its own: it cannot be revoked, and
 * anyone holding it can read the bytes until it lapses. Five minutes is short enough that a URL
 * pasted into a chat is dead before it is read, and long enough to start a large download.
 */
export async function presignObject(deps: HandlerDeps, id: string): Promise<{ url: string; expiresInSeconds: number }> {
  const object = await readableObject(deps, id);
  const url = await deps.store.presignGet(object.key, { expiresIn: PRESIGNED_URL_TTL_SECONDS });
  return { url, expiresInSeconds: PRESIGNED_URL_TTL_SECONDS };
}

/** Rename a file, change who may read it, or both. The key never moves — only the row changes. */
export async function updateObject(
  deps: HandlerDeps,
  id: string,
  input: UpdateObjectInput,
): Promise<StorageObjectView> {
  const object = await loadObject(deps, id);
  assertOwner(object, deps.ownerId);
  return view(
    await saveObject(deps, {
      ...object,
      path: input.path ?? object.path,
      visibility: input.visibility ?? object.visibility,
      updatedAt: deps.now(),
    }),
  );
}

/**
 * Copy a file server-side. The bytes are copied by R2 and never enter the Worker; the copy is a new
 * object with its own id, its own key, and its own share links — it is not an alias.
 *
 * Owner-scoped, like every other mutating route: you may copy your own files. Copying a *public* file
 * you do not own is a plausible feature and deliberately not this one — it would let any reader
 * duplicate bytes into their own quota on the owner's storage bill, which is a decision an adopter
 * should make explicitly rather than inherit.
 */
export async function copyObject(deps: HandlerDeps, id: string, input: CopyObjectInput): Promise<StorageObjectView> {
  const source = await loadObject(deps, id);
  assertOwner(source, deps.ownerId);
  assertStored(source);

  await assertWithinQuota({
    db: deps.db,
    ownerId: deps.ownerId,
    limitBytes: deps.config.quota.bytesPerOwner,
    additionalBytes: source.size ?? 0,
  });

  const key = deriveObjectKey();
  await deps.store.copy(source.key, key);
  const now = deps.now();
  const copy: StorageObject = {
    ...source,
    id: deps.newId(),
    key,
    path: input.path,
    ownerId: deps.ownerId,
    // A copy starts private even when the source was public. Republishing is a decision, and a copy
    // made to take a private working copy of your own public file should not re-publish it by default.
    visibility: "private",
    status: "stored",
    uploadId: null,
    createdAt: now,
    updatedAt: now,
  };
  try {
    // Same conditional insert as an upload init, for the same reason: a copy is bytes billed to an
    // owner, and concurrent copies of one 1 GiB file against a 1 GiB quota must not all pass.
    await insertReservingQuota({
      db: deps.db,
      ownerId: deps.ownerId,
      limitBytes: deps.config.quota.bytesPerOwner,
      additionalBytes: source.size ?? 0,
      record: StorageObject.encode(copy),
    });
  } catch (error) {
    // The row never landed, so nothing points at the copied bytes. Drop them rather than leave the
    // sweep to find them.
    await deps.store.delete(key).catch(() => {});
    throw error;
  }
  return view(copy);
}

/**
 * Delete a file: the object first, then the row. Every share link pointing at it goes with the row,
 * through the foreign key's `ON DELETE CASCADE` — a share that outlived its object would be a live
 * token for bytes that no longer exist.
 *
 * The object delete is best-effort. An R2 hiccup must not leave a row nobody can remove; the orphan
 * sweep collects an object whose row went first.
 */
export async function deleteObject(deps: HandlerDeps, id: string): Promise<{ id: string; deleted: true }> {
  const object = await loadObject(deps, id);
  assertOwner(object, deps.ownerId);
  if (object.uploadId) await deps.store.abortMultipart(object.key, object.uploadId).catch(() => {});
  await deps.store.delete(object.key).catch(() => {});
  await deps.db.deleteFrom(STORAGE_OBJECTS_TABLE).where("id", "=", id).execute();
  return { id, deleted: true };
}

/** Mint a revocable share link for one file. */
export async function createShare(deps: HandlerDeps, id: string, input: CreateShareInput): Promise<ShareView> {
  const object = await loadObject(deps, id);
  assertOwner(object, deps.ownerId);
  assertStored(object);

  const now = deps.now();
  const share: StorageShare = {
    token: deps.newToken(),
    objectId: object.id,
    expiresAt: input.expiresInSeconds ? new Date(now.getTime() + input.expiresInSeconds * 1000) : null,
    revokedAt: null,
    createdAt: now,
  };
  await deps.db.insertInto(STORAGE_SHARES_TABLE).values(StorageShare.encode(share)).execute();
  return { token: share.token, objectId: share.objectId, expiresAt: share.expiresAt, createdAt: share.createdAt };
}

/**
 * Withdraw a share link. A write, effective on the very next request — which is the whole reason a
 * share is a row and not a presigned URL.
 *
 * Revoking twice is a no-op. The first revocation time is kept, because when a link stopped working
 * is the fact anyone actually needs.
 */
export async function revokeShare(deps: HandlerDeps, token: string): Promise<{ token: string; revokedAt: Date }> {
  const row = await deps.db.selectFrom(STORAGE_SHARES_TABLE).selectAll().where("token", "=", token).executeTakeFirst();
  if (!row) throw new StorageNotFoundError({ detail: `no share token ${token}` });
  const share = StorageShare.parse(row);
  const object = await loadObject(deps, share.objectId);
  assertOwner(object, deps.ownerId);
  if (share.revokedAt) return { token, revokedAt: share.revokedAt };

  const revokedAt = deps.now();
  await deps.db
    .updateTable(STORAGE_SHARES_TABLE)
    .set(StorageShare.encode({ ...share, revokedAt }))
    .where("token", "=", token)
    .execute();
  return { token, revokedAt };
}

/**
 * Resolve a share token to the object it grants read access to.
 *
 * Revoked and expired are **separate answers**, deliberately. Both are 410, but `storage/share_revoked`
 * says the owner took the link back and `storage/share_expired` says it simply aged out — one is worth
 * asking about, the other is worth re-requesting. Collapsing them into "gone" throws away the only
 * information the holder can act on. Revocation is checked first: an explicit withdrawal is the more
 * specific fact about a link that is both.
 */
export async function resolveShare(deps: HandlerDeps, token: string): Promise<StorageObject> {
  const row = await deps.db.selectFrom(STORAGE_SHARES_TABLE).selectAll().where("token", "=", token).executeTakeFirst();
  if (!row) throw new StorageNotFoundError({ detail: `no share token ${token}` });
  const share = StorageShare.parse(row);

  if (share.revokedAt)
    throw new StorageShareRevokedError({ detail: `share ${token} revoked at ${share.revokedAt.toISOString()}` });
  if (share.expiresAt && share.expiresAt.getTime() <= deps.now().getTime()) {
    throw new StorageShareExpiredError({ detail: `share ${token} expired at ${share.expiresAt.toISOString()}` });
  }

  const object = await loadObject(deps, share.objectId);
  assertStored(object);
  return object;
}

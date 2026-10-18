// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import {
  type AccessCaller,
  type AccessLevel,
  accessLevel,
  defaultAllows,
  keepReadable,
  type PermissionHook,
  readablePredicate,
} from "@pithy-sh/core/src/access/access";
import { resolveVisibility } from "@pithy-sh/core/src/access/visibility";
import { fromZodError, PithyError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { z } from "zod";
import type { MediaConfig } from "../config/config";
import type { StorageBackend } from "../data/enums";
import { BASE_COLUMN_NAMES } from "../data/extend";
import type { DeliverySigner } from "../deliver/sign";
import { type DeliveryUrl, deliveryUrl } from "../deliver/url";
import { MediaForbiddenError, MediaNotFoundError } from "../error/errors";
import { findDuplicates } from "../hash/duplicates";
import { dedupScope, type HashStore } from "../record/hashStore";
import type { MediaRecord, RecordPage, RecordStore } from "../record/store";
import { backendForType } from "../storage/backend";
import type { MediaStorage } from "../storage/storage";
import type {
  CreateMediaInput,
  DeliveryUrlQuery,
  DuplicatesInput,
  FinalizeMediaInput,
  ListMediaQuery,
  UpdateMediaInput,
} from "./schemas";

/**
 * The media request handlers — pure functions over injected dependencies, so every branch is tested
 * against real D1 without standing up a Worker. The route shell (`routes.ts`) resolves these deps from
 * the request env.
 *
 * ## Whose a record is, and who may reach it
 *
 * Every record is written with its owner (`c.var.auth.userId`), the organization in force (core's
 * acting-organization seam), and a visibility (`private`, `organization` or `public`, from the project's
 * `visibility` policy). Every route then asks core's access rules — and the adopter's permission hook, if
 * they supplied one — before it acts:
 *
 * - **A record the caller cannot read is not found, never forbidden**, so an id cannot be probed.
 * - **Changing one** — finalize, edit, delete, visibility — is the owner's, acting for the record's
 *   organization, or a role holding `media:manage` there. A caller who may read a record but not change it
 *   is told so, because they already know it exists.
 * - **A list** returns the caller's own records and their organization's, by SQL; `includePublic=true`
 *   adds every public record; the hook may remove a row from a page and never add one.
 * - **Duplicate detection** is scoped to the tenant — the organization in force, or the owner — and the
 *   hook is not asked, because a hook that widened it would reopen the disclosure the scope closes.
 *
 * Request shape is NOT validated here. Each route declares its own schema with `validate(target,
 * Schema)` and hands the handler the already-parsed value. What survives in these handlers is validation
 * the schema cannot express: the R2 size rule, the visibility policy, and `validateRecord`, which
 * validates the *assembled* record against the effective (adopter-extended) schema.
 */

/** The power a role holds to edit, delete and re-scope any record in its own organization. */
export const MEDIA_MANAGE_POWER = "media:manage";

/** The capability's name, as the permission hook sees it. */
const CAPABILITY = "media";

/** Triggers the configured enrichment Workflow(s) for a finalized record. A no-op when nothing applies. */
export type EnrichmentDispatcher = (record: MediaRecord) => Promise<void>;

/** The dependencies the handlers need, all injectable. */
export interface HandlerDeps {
  /** The record store, already bound to the effective schema. */
  store: RecordStore;
  /** The dedup hash store — written on finalize, queried by duplicate search, cleared on delete. */
  hashes: HashStore;
  /** The storage seam (mint, sign, delete, read). */
  storage: MediaStorage;
  /** The effective record schema (base + adopter extension) — validates the assembled record. */
  schema: z.ZodObject;
  /** The resolved media config. */
  config: MediaConfig;
  /** Triggers enrichment Workflows on finalize. */
  dispatchEnrichment: EnrichmentDispatcher;
  /** Mints a new record id. */
  newId: () => string;
  /** The current time. */
  now: () => Date;
  /** Who is asking: the signed-in user, if any, and the organization they act for, if any. */
  caller: AccessCaller;
  /** The adopter's permission hook, if they supplied one. */
  permission?: PermissionHook;
  /** The Worker env, handed to the permission hook. */
  env: Record<string, unknown>;
  /** The delivery signer, resolved only when a signed URL is minted. */
  signer: () => Promise<DeliverySigner>;
  /**
   * How many media items the caller may hold — the `mediaItems` quota where the entitlement provider
   * enforces that meter — `null` for unlimited, or undefined where nothing limits it. Absent is undefined:
   * a project composing no provider, or leaving the meter advisory, uploads as it always did.
   */
  itemLimit?: () => Promise<number | null | undefined>;
}

/** The response to an upload-init: where to upload and the record's coordinates. */
export interface UploadInitResult {
  /** The created record id. */
  id: string;
  /** The URL the client uploads the bytes to. */
  uploadUrl: string;
  /** The backend the bytes will live in. */
  storageBackend: StorageBackend;
  /** The backend-specific storage handle. */
  storageKey: string;
}

/**
 * Extract only the adopter's extension fields from a create body: every key that is NOT a base column.
 * Excluding the full base column set — not just the client-input keys — is a security boundary: it stops
 * a client from smuggling a server-owned base field (`id`, `status`, `storageKey`, `ownerId`,
 * `organizationId`, `signedDelivery`, timestamps, derived text) in through the extension bag (mass
 * assignment).
 */
function splitExtension(parsed: Record<string, unknown>): Record<string, unknown> {
  const extension: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!BASE_COLUMN_NAMES.has(key)) extension[key] = value;
  }
  return extension;
}

/** Validate an assembled record against the effective schema, mapping a Zod failure to a 400. */
function validateRecord(schema: z.ZodObject, record: MediaRecord): MediaRecord {
  const result = schema.safeParse(record);
  if (!result.success) throw fromZodError(result.error);
  return result.data as MediaRecord;
}

/** What the caller may do with one record, asking the rules and the hook. */
function levelOf(deps: HandlerDeps, record: MediaRecord): Promise<AccessLevel> {
  return accessLevel({
    record,
    caller: deps.caller,
    capability: CAPABILITY,
    managePower: MEDIA_MANAGE_POWER,
    hook: deps.permission,
    env: deps.env,
  });
}

/** Load a record the caller may read, or answer not found — for a record that is absent and one they cannot see alike. */
async function loadReadable(deps: HandlerDeps, id: string, why: string): Promise<MediaRecord> {
  const record = await deps.store.get(id);
  if (!record || (await levelOf(deps, record)) === "none") {
    throw new MediaNotFoundError({
      detail: `${why}: no media record ${id} readable by ${deps.caller.userId ?? "anonymous"}`,
    });
  }
  return record;
}

/**
 * Load a record the caller may change. Not found when they cannot read it; forbidden only when they can,
 * because by then they already know it exists.
 */
async function loadWritable(deps: HandlerDeps, id: string, why: string): Promise<MediaRecord> {
  const record = await deps.store.get(id);
  const level = record ? await levelOf(deps, record) : "none";
  if (!record || level === "none") {
    throw new MediaNotFoundError({
      detail: `${why}: no media record ${id} readable by ${deps.caller.userId ?? "anonymous"}`,
    });
  }
  if (level !== "write") {
    throw new MediaForbiddenError({
      detail: `${why}: ${deps.caller.userId ?? "anonymous"} may read ${id} but not change it`,
    });
  }
  return record;
}

/** Whether a backend has a Cloudflare signing setting — R2 is private by its bucket instead. */
function signsAtCloudflare(record: Pick<MediaRecord, "storageBackend">): boolean {
  return record.storageBackend !== "r2";
}

/**
 * Upload-init: mint a direct-upload URL, create a `pending` record (with the client-computed sha256/phash
 * and any extension fields), and return where to upload. The bytes go straight to the backend — never
 * through the Worker.
 *
 * **Whose it is is decided here, from the request, never from the body.** The owner is the signed-in user
 * and the organization is the one in force; a client naming either in the body has it stripped as a base
 * column. The visibility is the one the body named, or the project's default, and a level the policy does
 * not allow is refused rather than quietly replaced.
 *
 * **A non-public Images or Stream asset is minted with `requireSignedURLs`**, so there is never an interval
 * in which its bytes are served plain; `signedDelivery` is written true because Cloudflare confirmed the
 * setting by minting the upload. An R2 object is private by its bucket, so it is signed exactly when no
 * public base serves it.
 */
export async function createMedia(deps: HandlerDeps, input: CreateMediaInput): Promise<UploadInitResult> {
  const extension = splitExtension(input);
  const organizationId = deps.caller.acting?.organizationId ?? null;
  const visibility = resolveVisibility(deps.config.visibility, input.visibility, organizationId);
  const backend = backendForType(input.type, deps.config);
  // An R2 presigned PUT signs the content length, so the client must upload exactly that many bytes — a
  // size is required for any R2-backed upload (audio and documents always; images/video when `store: 'r2'`).
  if (backend === "r2" && input.size == null) {
    throw new ValidationError({
      message: "A file size is required to upload this media type.",
      detail: `size is required for the R2-backed ${input.type} upload; the presigned PUT signs the content length`,
    });
  }
  const signed = visibility !== "public";
  const ownerLimit = await deps.itemLimit?.();
  const id = deps.newId();
  const target = await deps.storage.mintUpload({
    type: input.type,
    id,
    contentType: input.contentType,
    size: input.size ?? undefined,
    signed,
  });
  const now = deps.now();
  // Server-owned fields are written LAST so the extension bag (already stripped of base keys) can never
  // override the minted id, the lifecycle status, the owner, or the storage coordinates — defense in depth.
  const record = validateRecord(deps.schema, {
    ...extension,
    id,
    type: input.type,
    status: "pending",
    name: input.name,
    filename: input.filename,
    contentType: input.contentType,
    size: input.size ?? null,
    ownerId: deps.caller.userId,
    organizationId,
    visibility,
    signedDelivery: target.storageBackend === "r2" ? !deps.config.delivery.r2PublicBaseUrl : signed,
    storageBackend: target.storageBackend,
    storageKey: target.storageKey,
    sha256: input.sha256 ?? null,
    phash: input.phash ?? null,
    width: input.width ?? null,
    height: input.height ?? null,
    altText: null,
    caption: null,
    transcription: null,
    hasTranscription: false,
    extractedText: null,
    hasExtractedText: false,
    createdAt: now,
    updatedAt: now,
  } as MediaRecord);
  const created = await deps.store.create(record, typeof ownerLimit === "number" ? { ownerLimit } : undefined);
  if (created === null) {
    // The plan's allowance, refused in the provider's own words: the remedy is a bigger tier or a pinned
    // number, and a 402 says so. The minted upload slot is left to expire unused — nothing points at it.
    throw new PithyError({
      code: "payments/quota_exceeded",
      status: 402,
      message: "This plan's allowance is used up for this period.",
      action: "Upgrade the plan, or pin a larger mediaItems allowance for this subject from the control plane.",
      params: { meter: "mediaItems", limit: ownerLimit ?? 0 },
      detail: `${deps.caller.userId ?? "anonymous"} holds ${ownerLimit} media items, the mediaItems quota.`,
    });
  }
  return { id, uploadUrl: target.uploadUrl, storageBackend: target.storageBackend, storageKey: target.storageKey };
}

/**
 * Finalize: mark the record `stored`, fold in any client-computed size/sha256/phash, and dispatch the
 * configured enrichment Workflow(s). A change, so it is the owner's or a manager's. The dedup hash is
 * written with the record's own owner and organization, so it is matched within the tenant it belongs to.
 */
export async function finalizeMedia(deps: HandlerDeps, id: string, input: FinalizeMediaInput): Promise<MediaRecord> {
  await loadWritable(deps, id, "finalize");
  const changes: Partial<MediaRecord> = { status: "stored", updatedAt: deps.now() };
  if (input.size != null) changes.size = input.size;
  if (input.sha256 != null) changes.sha256 = input.sha256;
  if (input.phash != null) changes.phash = input.phash;
  const updated = await deps.store.patch(id, changes);
  const sha256 = typeof updated.sha256 === "string" ? updated.sha256 : null;
  if (sha256) {
    const phash = typeof updated.phash === "string" ? updated.phash : null;
    await deps.hashes.upsert({
      mediaId: id,
      mediaType: updated.type,
      sha256,
      phash,
      ownerId: updated.ownerId,
      organizationId: updated.organizationId,
    });
  }
  await deps.dispatchEnrichment(updated);
  return updated;
}

/** Fetch one record by id, or 404 — for a record that does not exist and one the caller may not read alike. */
export function getMedia(deps: HandlerDeps, id: string): Promise<MediaRecord> {
  return loadReadable(deps, id, "get");
}

/**
 * List the records the caller may see, newest first: their own and their organization's, plus every public
 * record when `includePublic=true`. The rules run in SQL; the hook is asked about each row on the page and
 * may remove one, so a page can come back short — the cursor, computed before the hook ran, still says
 * whether there is more.
 */
export async function listMedia(deps: HandlerDeps, query: ListMediaQuery): Promise<RecordPage> {
  const page = await deps.store.list({
    readable: readablePredicate(deps.caller, {
      managePower: MEDIA_MANAGE_POWER,
      includePublic: query.includePublic === "true",
    }),
    type: query.type,
    limit: query.limit,
    cursor: query.cursor,
  });
  const items = await keepReadable(page.items, {
    capability: CAPABILITY,
    caller: deps.caller,
    hook: deps.permission,
    env: deps.env,
  });
  return page.cursor === undefined ? { items } : { items, cursor: page.cursor };
}

/** Delete a record and best-effort delete its stored object. The owner's, or a manager's. */
export async function deleteMedia(deps: HandlerDeps, id: string): Promise<{ id: string; deleted: true }> {
  const record = await loadWritable(deps, id, "delete");
  // Best-effort object cleanup — a storage hiccup must not leave the record undeletable.
  await deps.storage
    .deleteObject({ storageBackend: record.storageBackend, storageKey: record.storageKey })
    .catch(() => {});
  await deps.hashes.deleteByMedia(id);
  await deps.store.delete(id);
  return { id, deleted: true };
}

/**
 * Rename a record, change who may read it, or both. The owner's, or a manager's.
 *
 * **A visibility change on Cloudflare is two writes in two systems, ordered so a half-done one is safe and
 * says so.** `visibility` is the owner's intent; `signedDelivery` is what Cloudflare last confirmed, and
 * URL building reads only the second.
 *
 * - **To private or organization**: Cloudflare is told to require signed URLs first, then both columns
 *   are written. If Cloudflare refuses, nothing is written and the record is as it was.
 * - **To public**: `visibility` is written first, then Cloudflare is told to stop requiring signatures,
 *   then `signedDelivery` is cleared. If Cloudflare refuses, the record is public with its bytes still
 *   signed — readers are handed signed URLs that work — and it reads as pending.
 *
 * Either way a retry of the same change finishes it: a record whose signing has not caught up with its
 * visibility is re-told, whatever the visibility already says. That is also how a record the ownership
 * migration made private gets its bytes signed.
 */
export async function updateMedia(deps: HandlerDeps, id: string, input: UpdateMediaInput): Promise<MediaRecord> {
  const record = await loadWritable(deps, id, "update");
  const now = deps.now();
  let current = record;
  if (input.name !== undefined) current = await deps.store.patch(id, { name: input.name, updatedAt: now });
  if (input.visibility === undefined) return current;

  // The record's own organization decides whether `organization` makes sense — not the caller's, which
  // for a manager is the same and for anyone else could not have reached this line.
  const visibility = resolveVisibility(deps.config.visibility, input.visibility, record.organizationId);
  if (!signsAtCloudflare(record)) {
    return visibility === current.visibility ? current : deps.store.patch(id, { visibility, updatedAt: now });
  }

  const location = { storageBackend: record.storageBackend, storageKey: record.storageKey };
  if (visibility !== "public") {
    if (!current.signedDelivery) await deps.storage.setSigning(location, true);
    return deps.store.patch(id, { visibility, signedDelivery: true, updatedAt: now });
  }

  if (current.visibility !== "public") current = await deps.store.patch(id, { visibility, updatedAt: now });
  if (!current.signedDelivery) return current;
  try {
    await deps.storage.setSigning(location, false);
  } catch {
    // Public, with its bytes still signed: readers get signed URLs that work, and the record says pending.
    return current;
  }
  return deps.store.patch(id, { signedDelivery: false, updatedAt: now });
}

/**
 * The URL a caller who may read a record loads its bytes from: short-lived and signed for a record whose
 * bytes are signed, plain for one that is public, presigned for a private R2 object.
 */
export async function mediaDeliveryUrl(deps: HandlerDeps, id: string, query: DeliveryUrlQuery): Promise<DeliveryUrl> {
  const record = await loadReadable(deps, id, "url");
  return deliveryUrl(record, {
    delivery: deps.config.delivery,
    signer: deps.signer,
    presign: (key, expiresInSeconds) =>
      deps.storage.presignedDownloadUrl({ storageBackend: "r2", storageKey: key }, expiresInSeconds),
    now: deps.now,
    ...(query.variant === undefined ? {} : { imageVariant: query.variant }),
  });
}

/**
 * Find exact (sha256) and near (phash) duplicates of a file, **within the caller's tenant**: the
 * organization in force, or the owner when none is, unless the adopter configured `dedup.scope: "account"`.
 *
 * Each candidate is hydrated from the record store. Within the tenant, a match is returned only when the
 * caller may read it by the rules — a member does not learn of a colleague's private file by uploading the
 * same bytes. The permission hook is not asked: a hook that widened duplicate detection would reopen the
 * disclosure the scope closes. Account-wide detection is the adopter's explicit choice to disclose, so it
 * returns every match.
 */
export async function searchDuplicates(deps: HandlerDeps, input: DuplicatesInput) {
  const scope = dedupScope(deps.caller, deps.config.dedup);
  const accountWide = "account" in scope;
  // Hydrate and judge each candidate before the cap, so a record the caller may not read never takes
  // a place in `limit` from one they may.
  const records = new Map<string, MediaRecord>();
  const candidates = await findDuplicates(deps.hashes, {
    scope,
    type: input.type,
    sha256: input.sha256,
    phash: input.phash,
    threshold: input.threshold,
    limit: input.limit,
    accept: async (candidate) => {
      const record = await deps.store.get(candidate.id);
      if (!record) return false;
      if (!accountWide && !defaultAllows("read", record, deps.caller, MEDIA_MANAGE_POWER)) return false;
      records.set(candidate.id, record);
      return true;
    },
  });
  const matches = candidates.flatMap((candidate) => {
    const record = records.get(candidate.id);
    return record ? [{ id: candidate.id, distance: candidate.distance, kind: candidate.kind, record }] : [];
  });
  return { matches };
}

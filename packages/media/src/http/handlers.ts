// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { fromZodError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { z } from "zod";
import type { MediaConfig } from "../config/config";
import { BASE_COLUMN_NAMES } from "../data/extend";
import { MediaNotFoundError } from "../error/errors";
import { findDuplicates } from "../hash/duplicates";
import type { HashStore } from "../record/hashStore";
import type { MediaRecord, RecordStore } from "../record/store";
import { backendForType } from "../storage/backend";
import type { MediaStorage } from "../storage/storage";
import type { CreateMediaInput, DuplicatesInput, FinalizeMediaInput, ListMediaQuery } from "./schemas";

/**
 * The media request handlers — pure functions over injected dependencies, so every branch is unit-tested
 * against real D1/KV bindings without standing up a Worker. The route shell (`routes.ts`) resolves these
 * deps from the request env. Every mutating route is gated by `requireAuth` at the router; ownership
 * scoping is an adopter concern via an extension field (e.g. `userId`).
 *
 * Request shape is NOT validated here. Each route declares its own schema with
 * `zValidator(target, Schema, validationHook)` and hands the handler the already-parsed value, so a
 * malformed request is rejected before any dependency is resolved. What survives in these handlers is
 * validation the schema cannot express: the R2 size rule (a cross-field, config-dependent check) and
 * `validateRecord`, which validates the *assembled* record against the effective (adopter-extended)
 * schema — neither is a property of the request body alone.
 */

/** Triggers the configured enrichment Workflow(s) for a finalized record. A no-op when nothing applies. */
export type EnrichmentDispatcher = (record: MediaRecord) => Promise<void>;

/** The dependencies the handlers need, all injectable. */
export interface HandlerDeps {
  /** The record store (D1 or KV), already bound to the effective schema. */
  store: RecordStore;
  /** The D1 dedup hash store — written on finalize, queried by duplicate search, cleared on delete. */
  hashes: HashStore;
  /** The storage seam (mint, delete, read). */
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
}

/** The response to an upload-init: where to upload and the record's coordinates. */
export interface UploadInitResult {
  /** The created record id. */
  id: string;
  /** The URL the client uploads the bytes to. */
  uploadUrl: string;
  /** The backend the bytes will live in. */
  storageBackend: string;
  /** The backend-specific storage handle. */
  storageKey: string;
}

/**
 * Extract only the adopter's extension fields from a create body: every key that is NOT a base column.
 * Excluding the full base column set — not just the client-input keys — is a security boundary: it stops
 * a client from smuggling a server-owned base field (`id`, `status`, `storageKey`, timestamps, derived
 * text) in through the extension bag and overriding it (mass assignment).
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

/**
 * Upload-init: mint a direct-upload URL, create a `pending` record (with the client-computed sha256/phash
 * and any extension fields), and return where to upload. The bytes go straight to the backend — never
 * through the Worker.
 */
export async function createMedia(deps: HandlerDeps, input: CreateMediaInput): Promise<UploadInitResult> {
  const extension = splitExtension(input);
  // An R2 presigned PUT signs the content length, so the client must upload exactly that many bytes — a
  // size is required for any R2-backed upload (audio and documents always; images/video when `store: 'r2'`).
  if (backendForType(input.type, deps.config) === "r2" && input.size == null) {
    throw new ValidationError({
      message: "A file size is required to upload this media type.",
      detail: `size is required for the R2-backed ${input.type} upload; the presigned PUT signs the content length`,
    });
  }
  const id = deps.newId();
  const target = await deps.storage.mintUpload({
    type: input.type,
    id,
    contentType: input.contentType,
    size: input.size ?? undefined,
  });
  const now = deps.now();
  // Server-owned fields are written LAST so the extension bag (already stripped of base keys) can never
  // override the minted id, the lifecycle status, or the storage coordinates — defense in depth.
  const record = validateRecord(deps.schema, {
    ...extension,
    id,
    type: input.type,
    status: "pending",
    name: input.name,
    filename: input.filename,
    contentType: input.contentType,
    size: input.size ?? null,
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
  await deps.store.create(record);
  return { id, uploadUrl: target.uploadUrl, storageBackend: target.storageBackend, storageKey: target.storageKey };
}

/**
 * Finalize: mark the record `stored`, fold in any client-computed size/sha256/phash, and dispatch the
 * configured enrichment Workflow(s). Returns the updated record.
 */
export async function finalizeMedia(deps: HandlerDeps, id: string, input: FinalizeMediaInput): Promise<MediaRecord> {
  const existing = await deps.store.get(id);
  if (!existing) throw new MediaNotFoundError({ detail: `finalize: no media record ${id}` });
  const changes: Partial<MediaRecord> = { status: "stored", updatedAt: deps.now() };
  if (input.size != null) changes.size = input.size;
  if (input.sha256 != null) changes.sha256 = input.sha256;
  if (input.phash != null) changes.phash = input.phash;
  const updated = await deps.store.patch(id, changes);
  // Write the dedup hash to D1 (always) now the upload is confirmed, so duplicate search can find it.
  const sha256 = typeof updated.sha256 === "string" ? updated.sha256 : null;
  if (sha256) {
    const phash = typeof updated.phash === "string" ? updated.phash : null;
    await deps.hashes.upsert({ mediaId: id, mediaType: updated.type, sha256, phash });
  }
  await deps.dispatchEnrichment(updated);
  return updated;
}

/** Fetch one record by id, or 404. */
export async function getMedia(deps: HandlerDeps, id: string): Promise<MediaRecord> {
  const record = await deps.store.get(id);
  if (!record) throw new MediaNotFoundError({ detail: `get: no media record ${id}` });
  return record;
}

/** List records, newest first, optionally filtered by type. */
export function listMedia(deps: HandlerDeps, query: ListMediaQuery) {
  return deps.store.list({ type: query.type, limit: query.limit, cursor: query.cursor });
}

/** Delete a record and best-effort delete its stored object. */
export async function deleteMedia(deps: HandlerDeps, id: string): Promise<{ id: string; deleted: true }> {
  const record = await deps.store.get(id);
  if (!record) throw new MediaNotFoundError({ detail: `delete: no media record ${id}` });
  // Best-effort object cleanup — a storage hiccup must not leave the record undeletable.
  await deps.storage
    .deleteObject({ storageBackend: record.storageBackend, storageKey: record.storageKey })
    .catch(() => {});
  await deps.hashes.deleteByMedia(id);
  await deps.store.delete(id);
  return { id, deleted: true };
}

/**
 * Find exact (sha256) and near (phash) duplicates of a file. Detection runs against the D1 hash store;
 * each candidate is then hydrated from the record store so the caller gets the full record (a hash whose
 * record was deleted out from under it is skipped).
 */
export async function searchDuplicates(deps: HandlerDeps, input: DuplicatesInput) {
  const candidates = await findDuplicates(deps.hashes, {
    type: input.type,
    sha256: input.sha256,
    phash: input.phash,
    threshold: input.threshold,
    limit: input.limit,
  });
  const matches = [];
  for (const candidate of candidates) {
    const record = await deps.store.get(candidate.id);
    if (record) matches.push({ id: candidate.id, distance: candidate.distance, kind: candidate.kind, record });
  }
  return { matches };
}

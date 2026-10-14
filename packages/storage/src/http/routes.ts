// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { describeRoute, type RouteResponse } from "@pithy-sh/core/src/http/routeSpec";
import { validate } from "@pithy-sh/core/src/http/validation";
import type { VerificationStrategy } from "@pithy-sh/core/src/http/verification";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import type { Context, Hono } from "hono";
import type { StorageConfig } from "../config/config";
import { storageDatabase } from "../data/tables";
import { objectStore } from "../object/store";
import { STORAGE_R2_SECRET } from "../secret/registry";
import { requireAuth } from "./guard";
import {
  abortUpload,
  completeUpload,
  copyObject,
  createShare,
  deleteObject,
  type HandlerDeps,
  initUpload,
  listObjects,
  listUploadParts,
  presignObject,
  readableObject,
  resolveShare,
  revokeShare,
  updateObject,
} from "./handlers";
import {
  ObjectDeletedResponse,
  ObjectListResponse,
  PresignedUrlResponse,
  ShareResponse,
  ShareRevokedResponse,
  StorageObjectResponse,
  UploadInitResponse,
  UploadPartsResponse,
} from "./responses";
import {
  CompleteUploadInput,
  CopyObjectInput,
  CreateShareInput,
  CreateUploadInput,
  ListObjectsQuery,
  ObjectIdParam,
  ObjectReadQuery,
  ShareTokenParam,
  UpdateObjectInput,
} from "./schemas";
import {
  parseConditions,
  parseRangeHeader,
  rangeNotSatisfiable,
  serveMetadata,
  serveObject,
  toObjectRange,
} from "./serve";

/**
 * The storage routes, their declared verification strategies, and what each accepts:
 *
 *   POST   /storage                 → start an upload            (bearer | session)
 *                                     json: CreateUploadInput
 *   GET    /storage                 → list your files            (bearer | session, owner-scoped)
 *                                     query: ListObjectsQuery
 *   DELETE /storage/shares/:token   → revoke a share             (bearer | session, owner-scoped)
 *                                     param: ShareTokenParam
 *   POST   /storage/:id/complete    → finalize a multipart       (bearer | session, owner-scoped)
 *                                     param: ObjectIdParam, json: CompleteUploadInput
 *   POST   /storage/:id/abort       → abandon an upload          (bearer | session, owner-scoped)
 *                                     param: ObjectIdParam — no body
 *   GET    /storage/:id/parts       → resume a multipart         (bearer | session, owner-scoped)
 *                                     param: ObjectIdParam
 *   POST   /storage/:id/copy        → server-side copy           (bearer | session, owner-scoped)
 *                                     param: ObjectIdParam, json: CopyObjectInput
 *   POST   /storage/:id/shares      → mint a revocable share     (bearer | session, owner-scoped)
 *                                     param: ObjectIdParam, json: CreateShareInput
 *   GET    /storage/:id/url         → presigned direct URL       (bearer | session, owner-or-public)
 *                                     param: ObjectIdParam
 *   GET    /storage/:id             → stream the bytes           (public when `visibility: 'public'`,
 *                                                                 otherwise bearer | session + owner)
 *                                     param: ObjectIdParam, query: ObjectReadQuery
 *   HEAD   /storage/:id             → metadata only              (bearer | session, owner-scoped)
 *                                     param: ObjectIdParam
 *   PATCH  /storage/:id             → rename or change access    (bearer | session, owner-scoped)
 *                                     param: ObjectIdParam, json: UpdateObjectInput
 *   DELETE /storage/:id             → delete file and row        (bearer | session, owner-scoped)
 *                                     param: ObjectIdParam
 *   GET    /s/:token                → fetch via a share link     (public — the token is the credential)
 *                                     param: ShareTokenParam, query: ObjectReadQuery
 *
 * **Every validator sits after the guard.** An unauthenticated request with a malformed body is a
 * 401, never a 400 — shape is not something a caller learns before being verified. `POST
 * /storage/:id/abort` carries no json validator because it reads no body: adding one would 400 the
 * bodyless POST every client sends today.
 *
 * `GET /storage/:id` is the one route with two strategies, because a public file must be readable by
 * someone with no session at all. It is therefore **not** wrapped in {@link requireAuth}: the guard
 * would deny before the handler could see that the object is public. Authorization happens inside the
 * handler instead, against `c.var.auth` — which is `null` with no auth capability composed, so a
 * private object is denied by default and only an explicitly public one is served.
 *
 * **Static segments are registered before `:param` ones.** Hono matches in registration order, so
 * `/storage/shares/:token` has to come before `/storage/:id` or a DELETE to `/storage/shares/abc`
 * would be read as deleting the object whose id is `shares`.
 *
 * **Uploads never proxy bytes through the Worker; downloads do.** That asymmetry is the design, not
 * an inconsistency — `serve.ts` carries the reasoning.
 */
export interface StorageRoutesOptions {
  /** The resolved storage config. */
  config: StorageConfig;
  /** Where the object routes mount. Defaults to `/storage`. */
  basePath?: string;
  /** Where share fetches mount. Defaults to `/s` — short, because the whole URL gets pasted around. */
  sharePath?: string;
  /** Test seam: resolve handler deps from the request. Defaults to the env-based resolver. */
  resolveDeps?: (c: Context<PithyHonoEnv>) => Promise<HandlerDeps>;
}

/** The bindings the storage routes read off the Worker env. */
interface StorageEnv extends SecretsStoreEnv {
  /** The app database the `pithy_storage_*` tables live in. */
  DB: D1Database;
  /** The bucket objects are stored in. */
  STORAGE_BUCKET: R2Bucket;
}

/**
 * Read one binding, or fail with a message naming the binding and how to add it. A `?.` here would
 * turn a missing binding into a `TypeError` at the first query, attributed to nothing.
 */
function requireBinding<T>(env: unknown, name: string, kind: string): T {
  const value = (env as Record<string, unknown>)[name];
  if (!value) {
    throw new InternalError({
      message: "Storage is not configured.",
      action: `Bind ${kind} named ${name} in wrangler.jsonc, then redeploy.`,
      detail: `@pithy-sh/storage requires the ${name} binding; none was present on env.`,
    });
  }
  return value as T;
}

/** Build the default per-request dependency resolver from the resolved config. */
function defaultResolveDeps(config: StorageConfig): (c: Context<PithyHonoEnv>) => Promise<HandlerDeps> {
  return async (c) => {
    const env = c.env as unknown as StorageEnv;
    const bucket = requireBinding<R2Bucket>(env, "STORAGE_BUCKET", "an R2 bucket");
    const d1 = requireBinding<D1Database>(env, "DB", "a D1 database");
    return {
      db: storageDatabase(d1),
      // Credentials resolve lazily inside the store, so a request that only reads bytes through the
      // binding never touches the secrets store.
      store: objectStore({ bucket, env, secretName: STORAGE_R2_SECRET }),
      config,
      ownerId: c.var.auth?.userId ?? null,
      newId: () => crypto.randomUUID(),
      // 32 bytes of CSPRNG output, base64url. The token *is* the credential for a share link, so its
      // entropy is the only thing standing between a link and anyone guessing one.
      newToken: () => shareToken(),
      now: () => new Date(),
    };
  };
}

/** A 256-bit share token, base64url-encoded and unpadded so it is safe in a path segment. */
function shareToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** `requireAuth()` lets either a bearer token or a session through. */
const AUTHENTICATED: readonly VerificationStrategy[] = ["bearer", "session"];

/** What a byte read can answer: the whole file, the range asked for, or nothing new since the caller's copy. */
const BYTE_RESPONSES: Readonly<Record<number, RouteResponse>> = {
  200: {
    description:
      "The whole file. Served as its stored type, or as `application/octet-stream` when none was stored or the stored one could run in a browser.",
    contentType: "application/octet-stream",
  },
  206: { description: "The byte range the `Range` header asked for.", contentType: "application/octet-stream" },
  304: { description: "The caller's copy matches `If-None-Match`. No body." },
};

/** Register the storage sub-router. Returned as the capability's `routes` hook. */
export function registerStorageRoutes(options: StorageRoutesOptions): (app: Hono<PithyHonoEnv>) => void {
  const base = options.basePath ?? "/storage";
  const share = options.sharePath ?? "/s";
  const resolve = options.resolveDeps ?? defaultResolveDeps(options.config);

  /** Stream one object, honoring `Range` and `If-None-Match`. Shared by the id route and the share route. */
  const stream = async (
    c: Context<PithyHonoEnv>,
    deps: HandlerDeps,
    object: Awaited<ReturnType<typeof readableObject>>,
    download: boolean,
  ) => {
    const requested = parseRangeHeader(c.req.header("range"), object.size);
    if (requested.kind === "unsatisfiable") return rangeNotSatisfiable(object.size ?? 0);

    const result = await deps.store.get(object.key, {
      range: toObjectRange(requested),
      onlyIf: parseConditions(c.req.header("if-none-match")),
    });
    if (!result) {
      // The row says stored but R2 has nothing. Reported as missing rather than as a 500: from the
      // caller's side the file is gone, and the orphan sweep is what reconciles the two stores.
      return c.notFound();
    }
    return serveObject({
      metadata: result.metadata,
      body: result.body,
      range: result.range,
      path: object.path,
      visibility: object.visibility,
      download,
    });
  };

  return (app) => {
    app.post(
      base,
      describeRoute({
        summary: "Start an upload.",
        description:
          "Reserves the file and its quota, then answers with the presigned URL, or one URL per part, to PUT the bytes to. The bytes never pass through the Worker.",
        verification: AUTHENTICATED,
        responses: { 201: UploadInitResponse },
      }),
      requireAuth(),
      validate("json", CreateUploadInput),
      async (c) => {
        return c.json(await initUpload(await resolve(c), c.req.valid("json")), 201);
      },
    );

    app.get(
      base,
      describeRoute({
        summary: "List the caller's files.",
        verification: AUTHENTICATED,
        responses: { 200: ObjectListResponse },
      }),
      requireAuth(),
      validate("query", ListObjectsQuery),
      async (c) => {
        return c.json(await listObjects(await resolve(c), c.req.valid("query")));
      },
    );

    // Static before `:id` — see the file doc comment.
    app.delete(
      `${base}/shares/:token`,
      describeRoute({
        summary: "Revoke a share link.",
        description: "Takes effect on the next fetch. Revoking twice is a no-op that keeps the first time.",
        verification: AUTHENTICATED,
        responses: { 200: ShareRevokedResponse },
      }),
      requireAuth(),
      validate("param", ShareTokenParam),
      async (c) => {
        return c.json(await revokeShare(await resolve(c), c.req.valid("param").token));
      },
    );

    app.post(
      `${base}/:id/complete`,
      describeRoute({
        summary: "Finish an upload.",
        description:
          "Assembles a multipart upload, then confirms the bytes against R2. Completing a stored file again answers with it unchanged.",
        verification: AUTHENTICATED,
        responses: { 200: StorageObjectResponse },
      }),
      requireAuth(),
      validate("param", ObjectIdParam),
      validate("json", CompleteUploadInput),
      async (c) => {
        return c.json(await completeUpload(await resolve(c), c.req.valid("param").id, c.req.valid("json")));
      },
    );

    // No json validator: this route reads no body, and a client that sends none must keep working.
    app.post(
      `${base}/:id/abort`,
      describeRoute({
        summary: "Abandon an upload.",
        description: "Discards whatever R2 holds for the upload. The record stays, marked failed.",
        verification: AUTHENTICATED,
        responses: { 200: StorageObjectResponse },
      }),
      requireAuth(),
      validate("param", ObjectIdParam),
      async (c) => {
        return c.json(await abortUpload(await resolve(c), c.req.valid("param").id));
      },
    );

    // The resume path: what R2 already holds, and a fresh URL for every part still missing. Minting
    // on demand is what keeps a part URL's TTL short without making a stalled upload unrecoverable.
    app.get(
      `${base}/:id/parts`,
      describeRoute({
        summary: "Resume a multipart upload.",
        verification: AUTHENTICATED,
        responses: { 200: UploadPartsResponse },
      }),
      requireAuth(),
      validate("param", ObjectIdParam),
      async (c) => {
        return c.json(await listUploadParts(await resolve(c), c.req.valid("param").id));
      },
    );

    app.post(
      `${base}/:id/copy`,
      describeRoute({
        summary: "Copy a file.",
        description: "R2 copies the bytes. The copy is a new private file with its own id.",
        verification: AUTHENTICATED,
        responses: { 201: StorageObjectResponse },
      }),
      requireAuth(),
      validate("param", ObjectIdParam),
      validate("json", CopyObjectInput),
      async (c) => {
        return c.json(await copyObject(await resolve(c), c.req.valid("param").id, c.req.valid("json")), 201);
      },
    );

    app.post(
      `${base}/:id/shares`,
      describeRoute({
        summary: "Mint a share link.",
        verification: AUTHENTICATED,
        responses: { 201: ShareResponse },
      }),
      requireAuth(),
      validate("param", ObjectIdParam),
      validate("json", CreateShareInput),
      async (c) => {
        return c.json(await createShare(await resolve(c), c.req.valid("param").id, c.req.valid("json")), 201);
      },
    );

    app.get(
      `${base}/:id/url`,
      describeRoute({
        summary: "Mint a direct download URL.",
        description:
          "For a public file or one the caller owns. The URL cannot be revoked, so it lapses in five minutes.",
        verification: AUTHENTICATED,
        responses: { 200: PresignedUrlResponse },
      }),
      requireAuth(),
      validate("param", ObjectIdParam),
      async (c) => {
        return c.json(await presignObject(await resolve(c), c.req.valid("param").id));
      },
    );

    // No `requireAuth`: a public object must be readable without a session. The handler authorizes.
    app.get(
      `${base}/:id`,
      describeRoute({
        summary: "Read a file's bytes.",
        description:
          "Public files need no credential. A private file needs the owner's bearer token or session, and reads as missing to anyone else. Honors `Range` and `If-None-Match`.",
        verification: ["public", "bearer", "session"],
        responses: BYTE_RESPONSES,
      }),
      validate("param", ObjectIdParam),
      validate("query", ObjectReadQuery),
      async (c) => {
        const deps = await resolve(c);
        const object = await readableObject(deps, c.req.valid("param").id);
        return stream(c, deps, object, c.req.valid("query").download === "1");
      },
    );

    app.on(
      "HEAD",
      `${base}/:id`,
      describeRoute({
        summary: "Read a file's headers without its bytes.",
        verification: AUTHENTICATED,
        responses: { 200: { description: "The headers a GET would carry, with no body." } },
      }),
      requireAuth(),
      validate("param", ObjectIdParam),
      async (c) => {
        const deps = await resolve(c);
        const object = await readableObject(deps, c.req.valid("param").id);
        const metadata = await deps.store.head(object.key);
        if (!metadata) return c.notFound();
        return serveMetadata({ metadata, path: object.path, visibility: object.visibility });
      },
    );

    app.patch(
      `${base}/:id`,
      describeRoute({
        summary: "Rename a file or change who may read it.",
        verification: AUTHENTICATED,
        responses: { 200: StorageObjectResponse },
      }),
      requireAuth(),
      validate("param", ObjectIdParam),
      validate("json", UpdateObjectInput),
      async (c) => {
        return c.json(await updateObject(await resolve(c), c.req.valid("param").id, c.req.valid("json")));
      },
    );

    app.delete(
      `${base}/:id`,
      describeRoute({
        summary: "Delete a file.",
        description: "Its share links go with it.",
        verification: AUTHENTICATED,
        responses: { 200: ObjectDeletedResponse },
      }),
      requireAuth(),
      validate("param", ObjectIdParam),
      async (c) => {
        return c.json(await deleteObject(await resolve(c), c.req.valid("param").id));
      },
    );

    // Public by design: the token is the credential, and it is checked on every fetch — which is what
    // makes revocation possible at all.
    app.get(
      `${share}/:token`,
      describeRoute({
        summary: "Read a file through a share link.",
        description:
          "The token is the credential. A revoked or expired link answers 410. Honors `Range` and `If-None-Match`.",
        verification: "public",
        responses: BYTE_RESPONSES,
      }),
      validate("param", ShareTokenParam),
      validate("query", ObjectReadQuery),
      async (c) => {
        const deps = await resolve(c);
        const object = await resolveShare(deps, c.req.valid("param").token);
        return stream(c, deps, object, c.req.valid("query").download === "1");
      },
    );
  };
}

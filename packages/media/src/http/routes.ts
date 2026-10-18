// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { CloudflareAnalyticsManager } from "@pithy-sh/cloudflare/src/analytics/analyticsManager";
import { accessCaller, type PermissionHook } from "@pithy-sh/core/src/access/access";
import { UsageQuery, UsageResponse, usageRollup } from "@pithy-sh/core/src/access/usage";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { requireControlPlane } from "@pithy-sh/core/src/controlPlane/http/guard";
import { meterLimit } from "@pithy-sh/core/src/entitlement/allowance";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { describeRoute } from "@pithy-sh/core/src/http/routeSpec";
import { validate } from "@pithy-sh/core/src/http/validation";
import type { VerificationStrategy } from "@pithy-sh/core/src/http/verification";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import type { Context, Hono } from "hono";
import type { Kysely } from "kysely";
import type { z } from "zod";
import { storedAssets } from "../analytics/assets";
import { type DeliveryDeps, readDelivery } from "../analytics/delivery";
import { MediaAuditActions } from "../audit/actions";
import type { MediaConfig } from "../config/config";
import { MEDIA_ASSETS_TABLE, mediaDatabase } from "../data/tables";
import { resolveDeliverySigner } from "../deliver/resolve";
import { d1RecordStore } from "../record/d1Store";
import { d1HashStore } from "../record/hashStore";
import { mediaCloudflareConfig, resolveStorage, type StorageEnv } from "../storage/resolve";
import { type EnrichmentBindings, makeEnrichmentDispatcher } from "./dispatch";
import { requireAuth } from "./guard";
import {
  createMedia,
  deleteMedia,
  finalizeMedia,
  getMedia,
  type HandlerDeps,
  listMedia,
  mediaDeliveryUrl,
  searchDuplicates,
  updateMedia,
} from "./handlers";
import {
  DuplicatesResponse,
  MediaDeletedResponse,
  MediaDeliveryResponse,
  MediaDeliveryUrlResponse,
  MediaListResponse,
  MediaRecordResponse,
  MediaUploadInitResponse,
} from "./responses";
import {
  CreateMediaInput,
  DeliveryQuery,
  DeliveryUrlQuery,
  DuplicatesInput,
  FinalizeMediaInput,
  ListMediaQuery,
  MediaIdParam,
  UpdateMediaInput,
} from "./schemas";
import { MEDIA_DELIVERY_READ_SCOPE, MEDIA_USAGE_READ_SCOPE } from "./scopes";
import { mediaView } from "./views";

/**
 * The media routes, their declared verification strategies, and what each accepts:
 *
 *   POST   /media               → upload-init      (bearer | session) json: CreateMediaInput
 *   POST   /media/duplicates    → duplicate search (bearer | session) json: DuplicatesInput
 *   GET    /media/admin/usage   → usage rollup     (control-plane, media:usage:read) query: UsageQuery
 *   POST   /media/:id/finalize  → finalize upload  (bearer | session) param: MediaIdParam, json: FinalizeMediaInput
 *   GET    /media/:id/url       → delivery URL     (public | bearer | session) param: MediaIdParam, query: DeliveryUrlQuery
 *   GET    /media/:id           → fetch one        (public | bearer | session) param: MediaIdParam
 *   PATCH  /media/:id           → rename, re-scope (bearer | session) param: MediaIdParam, json: UpdateMediaInput
 *   GET    /media               → list             (bearer | session) query: ListMediaQuery
 *   DELETE /media/:id           → delete           (bearer | session) param: MediaIdParam
 *   GET    /media/admin/delivery → what was served  (control-plane: media:delivery:read) query: DeliveryQuery
 *
 * **Reading one record is open to anyone it is public to.** `GET /media/:id` and its delivery URL are not
 * wrapped in {@link requireAuth}: a public record must be readable with no session, so the handler
 * authorizes instead, against `c.var.auth` — null with no auth composed, so a private record is not found
 * by default and only a public one is served. Everything else needs a session, and every record route
 * asks core's access rules and the adopter's permission hook before it acts (`handlers.ts`).
 *
 * The validators sit AFTER the guard on purpose: an unauthenticated request with a malformed body is a
 * 401, not a 400 — shape is never leaked to a caller who has not been verified. Bytes never proxy through
 * the Worker: upload-init returns a direct-upload URL the client uploads to.
 *
 * **Static segments before `:id`.** Hono matches in registration order, so `/media/duplicates` and
 * `/media/admin/usage` are registered ahead of the `:id` routes.
 *
 * The management routes are gated by `requireControlPlane` instead of {@link requireAuth}, never both: the
 * seam leaves `c.var.auth` null by design.
 */
export interface MediaRoutesOptions {
  /** The resolved media config. */
  config: MediaConfig;
  /** The effective record schema (base + adopter extension). */
  schema: z.ZodObject;
  /** The path the routes mount under. Defaults to `/media`. */
  basePath?: string;
  /** The adopter's permission hook: allow, deny, or the default rules, asked on every record read and write. */
  permission?: PermissionHook;
  /** Test seam: resolve handler deps from the request context. Defaults to the env-based resolver. */
  resolveDeps?: (c: Context<PithyHonoEnv>) => Promise<HandlerDeps>;
  /** Test seam: resolve the delivery read's deps. Defaults to the env-based resolver. */
  resolveDelivery?: (c: Context<PithyHonoEnv>) => Promise<DeliveryDeps>;
}

/** The full request env the media routes read. */
type MediaEnv = { DB: D1Database } & StorageEnv & EnrichmentBindings & SecretsStoreEnv;

/** Build the default per-request dependency resolver from config and the effective schema. */
function defaultResolveDeps(
  config: MediaConfig,
  schema: z.ZodObject,
  permission: PermissionHook | undefined,
): (c: Context<PithyHonoEnv>) => Promise<HandlerDeps> {
  return async (c) => {
    const env = c.env as unknown as MediaEnv;
    const storage = await resolveStorage(env, config);
    return {
      store: d1RecordStore(mediaDatabase(env.DB, schema), schema),
      hashes: d1HashStore(env.DB),
      storage,
      schema,
      config,
      // The request logger, so an enrichment skipped for a missing binding says so in the request's log.
      dispatchEnrichment: makeEnrichmentDispatcher(env, config, c.var.log),
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
      caller: await accessCaller(c.var),
      ...(permission ? { permission } : {}),
      env: c.env,
      signer: () => resolveDeliverySigner(env),
      // The `mediaItems` ceiling where the entitlement provider enforces it; undefined where it does not.
      itemLimit: async () => {
        const ceiling = await meterLimit(c, "mediaItems");
        return ceiling.enforced ? ceiling.limit : undefined;
      },
    };
  };
}

/**
 * The delivery read's deps from the request env.
 *
 * The analytics reader is built **only when asked for**, which `readDelivery` does only when a type is
 * stored somewhere Cloudflare counts — so a Worker storing everything in R2 never reads a token it has no
 * use for. The token is the application's one `runtime` token (#728), through the one secrets reader; the
 * account is the one media's own `media-storage-credentials` names, since the assets live there.
 */
function defaultResolveDelivery(config: MediaConfig): (c: Context<PithyHonoEnv>) => Promise<DeliveryDeps> {
  return async (c) => {
    const env = c.env as unknown as MediaEnv;
    const cloudflare = mediaCloudflareConfig(env, config);
    return {
      assets: storedAssets(mediaDatabase(env.DB)),
      config,
      source: async () => new CloudflareAnalyticsManager(await cloudflare()),
      now: () => new Date(),
    };
  };
}

/** The verified management caller. `requireControlPlane` has run, so a null here is a wiring mistake. */
function managementCaller(c: Context<PithyHonoEnv>) {
  const context = c.var.controlPlane;
  if (!context) {
    throw new InternalError({ detail: "requireControlPlane() must run before a media management handler." });
  }
  return context;
}

/** `requireAuth()` lets either a bearer token or a session through. */
const AUTHENTICATED: readonly VerificationStrategy[] = ["bearer", "session"];

/** A read a public record answers with no credential at all. */
const PUBLIC_OR_AUTHENTICATED: readonly VerificationStrategy[] = ["public", "bearer", "session"];

/** Register the media sub-router. Returned as the capability's `routes` hook. */
export function registerMediaRoutes(options: MediaRoutesOptions): (app: Hono<PithyHonoEnv>) => void {
  const base = options.basePath ?? "/media";
  const resolve = options.resolveDeps ?? defaultResolveDeps(options.config, options.schema, options.permission);
  const resolveDelivery = options.resolveDelivery ?? defaultResolveDelivery(options.config);

  return (app) => {
    // The management surface, registered first. `/media/admin/delivery` is two segments past the mount,
    // so `/media/:id` could never have matched it — the order is presentation, not semantics.
    app.get(
      `${base}/admin/delivery`,
      describeRoute({
        summary: "Read what this environment's media was served.",
        description:
          "Minutes of video and image requests, per asset, from Cloudflare's analytics — joined to this environment's own assets, never an account total. The window defaults to the last 30 days.",
        verification: "control-plane",
        scopes: [MEDIA_DELIVERY_READ_SCOPE],
        responses: { 200: MediaDeliveryResponse },
      }),
      requireControlPlane(MEDIA_DELIVERY_READ_SCOPE),
      validate("query", DeliveryQuery),
      async (c) => {
        const report = await readDelivery(await resolveDelivery(c), c.req.valid("query"));
        const who = managementCaller(c);
        await c.var.emit({
          action: MediaAuditActions.deliveryRead,
          outcome: "success",
          actorType: "control-plane",
          actorId: who.subject,
          resourceType: "media_delivery",
          resourceId: null,
          requestId: c.req.header("cf-ray"),
          ip: c.req.header("cf-connecting-ip"),
          userAgent: c.req.header("user-agent"),
          metadata: {
            connectionId: who.connectionId,
            since: report.since,
            until: report.until,
            videos: report.video.state === "reported" ? report.video.assets.length : null,
            images: report.images.state === "reported" ? report.images.assets.length : null,
          },
        });
        return c.json(report satisfies MediaDeliveryResponse, 200);
      },
    );

    app.post(
      `${base}/duplicates`,
      describeRoute({
        summary: "Find duplicates of a file.",
        description:
          "Exact matches by SHA-256, and near matches by perceptual hash for images, within the caller's organization — or the caller's own records when none is in force.",
        verification: AUTHENTICATED,
        responses: { 200: DuplicatesResponse },
      }),
      requireAuth(),
      validate("json", DuplicatesInput),
      async (c) => {
        const deps = await resolve(c);
        const result = await searchDuplicates(deps, c.req.valid("json"));
        return c.json({
          matches: result.matches.map((match) => ({ ...match, record: mediaView(match.record, deps.caller) })),
        });
      },
    );

    app.get(
      `${base}/admin/usage`,
      describeRoute({
        summary: "Count media held, per organization or per owner.",
        description:
          "Stored records and their bytes. A per-owner read names its organization, so no figure ever spans two.",
        verification: "control-plane",
        scopes: [MEDIA_USAGE_READ_SCOPE],
        responses: { 200: UsageResponse },
      }),
      requireControlPlane(MEDIA_USAGE_READ_SCOPE),
      validate("query", UsageQuery),
      async (c) => {
        const env = c.env as unknown as MediaEnv;
        const db = mediaDatabase(env.DB) as unknown as Kysely<unknown>;
        return c.json((await usageRollup(db, MEDIA_ASSETS_TABLE, c.req.valid("query"))) satisfies UsageResponse);
      },
    );

    app.post(
      base,
      describeRoute({
        summary: "Start an upload.",
        description:
          "Creates a pending record owned by the caller, in the organization in force, and answers with the URL to upload the bytes to, directly.",
        verification: AUTHENTICATED,
        responses: { 201: MediaUploadInitResponse },
      }),
      requireAuth(),
      validate("json", CreateMediaInput),
      async (c) => {
        const result = await createMedia(await resolve(c), c.req.valid("json"));
        return c.json(result satisfies MediaUploadInitResponse, 201);
      },
    );

    app.post(
      `${base}/:id/finalize`,
      describeRoute({
        summary: "Finish an upload.",
        description: "Marks the record stored and starts any configured enrichment. The owner's, or a manager's.",
        verification: AUTHENTICATED,
        responses: { 200: MediaRecordResponse },
      }),
      requireAuth(),
      validate("param", MediaIdParam),
      validate("json", FinalizeMediaInput),
      async (c) => {
        const deps = await resolve(c);
        const record = await finalizeMedia(deps, c.req.valid("param").id, c.req.valid("json"));
        return c.json(mediaView(record, deps.caller));
      },
    );

    // No `requireAuth`: a public record's URL must be reachable without a session. The handler authorizes.
    app.get(
      `${base}/:id/url`,
      describeRoute({
        summary: "Mint a delivery URL.",
        description:
          "For a record the caller may read. Signed and short-lived when its bytes are signed; plain for a public record.",
        verification: PUBLIC_OR_AUTHENTICATED,
        responses: { 200: MediaDeliveryUrlResponse },
      }),
      validate("param", MediaIdParam),
      validate("query", DeliveryUrlQuery),
      async (c) => {
        const result = await mediaDeliveryUrl(await resolve(c), c.req.valid("param").id, c.req.valid("query"));
        return c.json({
          url: result.url,
          expiresAt: result.expiresAt?.toISOString() ?? null,
        } satisfies MediaDeliveryUrlResponse);
      },
    );

    // No `requireAuth`: a public record must be readable without a session. The handler authorizes.
    app.get(
      `${base}/:id`,
      describeRoute({
        summary: "Read one media record.",
        description:
          "A public record needs no credential. Any other reads as not found to anyone it is not visible to.",
        verification: PUBLIC_OR_AUTHENTICATED,
        responses: { 200: MediaRecordResponse },
      }),
      validate("param", MediaIdParam),
      async (c) => {
        const deps = await resolve(c);
        const record = await getMedia(deps, c.req.valid("param").id);
        return c.json(mediaView(record, deps.caller));
      },
    );

    app.patch(
      `${base}/:id`,
      describeRoute({
        summary: "Rename a media record or change who may read it.",
        description:
          "The owner's, or a manager's. A visibility change that Cloudflare has not yet confirmed comes back with `signingPending`; send it again to finish it.",
        verification: AUTHENTICATED,
        responses: { 200: MediaRecordResponse },
      }),
      requireAuth(),
      validate("param", MediaIdParam),
      validate("json", UpdateMediaInput),
      async (c) => {
        const deps = await resolve(c);
        const record = await updateMedia(deps, c.req.valid("param").id, c.req.valid("json"));
        return c.json(mediaView(record, deps.caller));
      },
    );

    app.get(
      base,
      describeRoute({
        summary: "List media records.",
        description:
          "The caller's own records and their organization's, newest first. `includePublic=true` adds every public record.",
        verification: AUTHENTICATED,
        responses: { 200: MediaListResponse },
      }),
      requireAuth(),
      validate("query", ListMediaQuery),
      async (c) => {
        const deps = await resolve(c);
        const page = await listMedia(deps, c.req.valid("query"));
        const items = page.items.map((record) => mediaView(record, deps.caller));
        return c.json(page.cursor === undefined ? { items } : { items, cursor: page.cursor });
      },
    );

    app.delete(
      `${base}/:id`,
      describeRoute({
        summary: "Delete a media record and its bytes.",
        description: "The owner's, or a manager's.",
        verification: AUTHENTICATED,
        responses: { 200: MediaDeletedResponse },
      }),
      requireAuth(),
      validate("param", MediaIdParam),
      async (c) => {
        return c.json((await deleteMedia(await resolve(c), c.req.valid("param").id)) satisfies MediaDeletedResponse);
      },
    );
  };
}

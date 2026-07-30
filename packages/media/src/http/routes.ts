// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { zValidator } from "@hono/zod-validator";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { validationHook } from "@pithy-sh/core/src/http/validation";
import type { Context, Hono } from "hono";
import type { z } from "zod";
import type { MediaConfig } from "../config/config";
import { type RecordStoreEnv, resolveHashStore, resolveRecordStore } from "../record/resolve";
import { resolveStorage, type StorageEnv } from "../storage/resolve";
import { type EnrichmentBindings, makeEnrichmentDispatcher } from "./dispatch";
import { requireAuth } from "./guard";
import {
  createMedia,
  deleteMedia,
  finalizeMedia,
  getMedia,
  type HandlerDeps,
  listMedia,
  searchDuplicates,
} from "./handlers";
import { CreateMediaInput, DuplicatesInput, FinalizeMediaInput, ListMediaQuery, MediaIdParam } from "./schemas";

/**
 * The media routes, their declared verification strategies, and what each accepts:
 *
 *   POST   /media               → upload-init      (bearer | session) json: CreateMediaInput
 *   POST   /media/duplicates    → duplicate search (bearer | session) json: DuplicatesInput
 *   POST   /media/:id/finalize  → finalize upload  (bearer | session) param: MediaIdParam, json: FinalizeMediaInput
 *   GET    /media/:id           → fetch one        (bearer | session) param: MediaIdParam
 *   GET    /media               → list             (bearer | session) query: ListMediaQuery
 *   DELETE /media/:id           → delete           (bearer | session) param: MediaIdParam
 *
 * Every route is gated by {@link requireAuth} — there is no public media surface. The validators sit
 * AFTER the guard on purpose: an unauthenticated request with a malformed body is a 401, not a 400 —
 * shape is never leaked to a caller who has not been verified. Bytes never proxy through the Worker:
 * upload-init returns a direct-upload URL the client uploads to. Ownership scoping (e.g. filtering by a
 * `userId` extension field) is an adopter concern layered over these routes.
 */
export interface MediaRoutesOptions {
  /** The resolved media config. */
  config: MediaConfig;
  /** The effective record schema (base + adopter extension). */
  schema: z.ZodObject;
  /** The path the routes mount under. Defaults to `/media`. */
  basePath?: string;
  /** Test seam: resolve handler deps from the request context. Defaults to the env-based resolver. */
  resolveDeps?: (c: Context<PithyHonoEnv>) => Promise<HandlerDeps>;
}

/** The full request env the media routes read. */
type MediaEnv = RecordStoreEnv & StorageEnv & EnrichmentBindings;

/** Build the default per-request dependency resolver from config and the effective schema. */
function defaultResolveDeps(
  config: MediaConfig,
  schema: z.ZodObject,
): (c: Context<PithyHonoEnv>) => Promise<HandlerDeps> {
  return async (c) => {
    const env = c.env as unknown as MediaEnv;
    const store = resolveRecordStore(env, config, schema);
    const hashes = resolveHashStore(env);
    const storage = await resolveStorage(env, config);
    return {
      store,
      hashes,
      storage,
      schema,
      config,
      // The request logger, so an enrichment skipped for a missing binding says so in the request's log.
      dispatchEnrichment: makeEnrichmentDispatcher(env, config, c.var.log),
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    };
  };
}

/** Register the media sub-router. Returned as the capability's `routes` hook. */
export function registerMediaRoutes(options: MediaRoutesOptions): (app: Hono<PithyHonoEnv>) => void {
  const base = options.basePath ?? "/media";
  const resolve = options.resolveDeps ?? defaultResolveDeps(options.config, options.schema);

  return (app) => {
    app.post(`${base}/duplicates`, requireAuth(), zValidator("json", DuplicatesInput, validationHook), async (c) => {
      const result = await searchDuplicates(await resolve(c), c.req.valid("json"));
      return c.json(result);
    });

    app.post(base, requireAuth(), zValidator("json", CreateMediaInput, validationHook), async (c) => {
      const result = await createMedia(await resolve(c), c.req.valid("json"));
      return c.json(result, 201);
    });

    app.post(
      `${base}/:id/finalize`,
      requireAuth(),
      zValidator("param", MediaIdParam, validationHook),
      zValidator("json", FinalizeMediaInput, validationHook),
      async (c) => {
        const record = await finalizeMedia(await resolve(c), c.req.valid("param").id, c.req.valid("json"));
        return c.json(record);
      },
    );

    app.get(`${base}/:id`, requireAuth(), zValidator("param", MediaIdParam, validationHook), async (c) => {
      const record = await getMedia(await resolve(c), c.req.valid("param").id);
      return c.json(record);
    });

    app.get(base, requireAuth(), zValidator("query", ListMediaQuery, validationHook), async (c) => {
      return c.json(await listMedia(await resolve(c), c.req.valid("query")));
    });

    app.delete(`${base}/:id`, requireAuth(), zValidator("param", MediaIdParam, validationHook), async (c) => {
      return c.json(await deleteMedia(await resolve(c), c.req.valid("param").id));
    });
  };
}

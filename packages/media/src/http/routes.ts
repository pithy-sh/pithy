import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
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

/**
 * The media routes and their declared verification strategies:
 *
 *   POST   /media               → upload-init      (bearer | session — mints a URL, creates a record)
 *   POST   /media/duplicates    → duplicate search (bearer | session)
 *   POST   /media/:id/finalize  → finalize upload  (bearer | session — marks stored, dispatches enrichment)
 *   GET    /media/:id           → fetch one        (bearer | session)
 *   GET    /media               → list             (bearer | session)
 *   DELETE /media/:id           → delete           (bearer | session)
 *
 * Every route is gated by {@link requireAuth} — there is no public media surface. Bytes never proxy
 * through the Worker: upload-init returns a direct-upload URL the client uploads to. Ownership scoping
 * (e.g. filtering by an `userId` extension field) is an adopter concern layered over these routes.
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
    app.post(`${base}/duplicates`, requireAuth(), async (c) => {
      const result = await searchDuplicates(await resolve(c), await c.req.json());
      return c.json(result);
    });

    app.post(base, requireAuth(), async (c) => {
      const result = await createMedia(await resolve(c), await c.req.json());
      return c.json(result, 201);
    });

    app.post(`${base}/:id/finalize`, requireAuth(), async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const record = await finalizeMedia(await resolve(c), c.req.param("id"), body);
      return c.json(record);
    });

    app.get(`${base}/:id`, requireAuth(), async (c) => {
      const record = await getMedia(await resolve(c), c.req.param("id"));
      return c.json(record);
    });

    app.get(base, requireAuth(), async (c) => {
      return c.json(await listMedia(await resolve(c), c.req.query()));
    });

    app.delete(`${base}/:id`, requireAuth(), async (c) => {
      return c.json(await deleteMedia(await resolve(c), c.req.param("id")));
    });
  };
}

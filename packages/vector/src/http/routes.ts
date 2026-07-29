import type { D1Database } from "@cloudflare/workers-types";
import { zValidator } from "@hono/zod-validator";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { validationHook } from "@pithy-sh/core/src/http/validation";
import type { Context, Hono } from "hono";
import type { VectorConfig, VectorIndexConfig } from "../config/config";
import { vectorDocuments } from "../data/documents";
import { vectorDatabase } from "../data/tables";
import type { VectorAi } from "../embed/embed";
import { VectorIndexNotFoundError } from "../error/errors";
import type { VectorStore } from "../index/index";
import { type MetadataIndexDescriptor, metadataIndexes } from "../index/metadata";
import { requireAuth } from "./guard";
import { deleteDocument, getDocument, type HandlerDeps, queryDocuments, upsertDocuments } from "./handlers";
import { QueryInput, UpsertDocumentsInput, VectorDocumentParams, VectorIndexParams } from "./schemas";

/**
 * The vector routes, what each accepts, and their declared verification strategies — every one of them
 * `bearer | session`:
 *
 *   POST   /vector/:index/documents      → write one or many  param: VectorIndexParams, json: UpsertDocumentsInput
 *   POST   /vector/:index/query          → search             param: VectorIndexParams, json: QueryInput
 *   GET    /vector/:index/documents/:id  → fetch one hydrated param: VectorDocumentParams
 *   DELETE /vector/:index/documents/:id  → delete from both   param: VectorDocumentParams
 *
 * Every route is gated by {@link requireAuth} — there is no public vector surface. A corpus is content the
 * adopter owns, and an unauthenticated search endpoint is an exfiltration endpoint. `requireAuth` is copied
 * into this package rather than imported from `@pithy-sh/auth`, so a project with no auth capability
 * composed denies every route instead of serving them open.
 *
 * The validators sit **after** the guard, deliberately: an unauthenticated request carrying a malformed body
 * is a 401, not a 400 — shape is never answered for a caller who has not been verified.
 *
 * `:index` names an index in `pithy.config.ts`, never a Cloudflare resource — an unknown one is a 404 from
 * config alone, before any binding is touched. The param schema bounds the segment's *shape* only; the name
 * is still resolved in the dep resolver, so which indexes exist stays unprobeable. Each index's metadata
 * schema is introspected **once**, here at registration, rather than per request: the descriptors are what
 * the filter compiler checks against, and they change only when the config does.
 */

/** The bindings the vector routes read off the request env. */
export interface VectorRoutesEnv {
  /** The app database the document corpus lives in. */
  DB: D1Database;
  /** The Workers AI binding used to embed text. */
  AI: VectorAi;
}

export interface VectorRoutesOptions {
  /** The resolved vector config. */
  config: VectorConfig;
  /** The path the routes mount under. Defaults to `/vector`. */
  basePath?: string;
  /** Test seam: resolve handler deps for one index from the request context. Defaults to the env resolver. */
  resolveDeps?: (c: Context<PithyHonoEnv>, indexName: string) => HandlerDeps;
}

/** Read a binding by name, throwing rather than returning undefined — a missing binding is a config fault. */
function binding<T>(c: Context<PithyHonoEnv>, name: string, action: string): T {
  const value = (c.env as Record<string, unknown>)[name] as T | undefined;
  if (!value) {
    throw new InternalError({
      message: "Search is not configured.",
      action,
      detail: `the \`${name}\` binding was not present on env`,
    });
  }
  return value;
}

/** The config for a named index, or a 404 — index names come from config, so an unknown one is not found. */
function indexConfig(config: VectorConfig, name: string): VectorIndexConfig {
  const index = config.indexes[name];
  if (!index) {
    throw new VectorIndexNotFoundError({
      detail: `no index '${name}' in config; declared: ${Object.keys(config.indexes).join(", ") || "none"}`,
    });
  }
  return index;
}

/** Register the vector sub-router. Returned as the capability's `routes` hook. */
export function registerVectorRoutes(options: VectorRoutesOptions): (app: Hono<PithyHonoEnv>) => void {
  const base = options.basePath ?? "/vector";
  const { config } = options;

  // Introspect every index's metadata once. `metadataIndexes` throws on an unprovisionable schema, and doing
  // it here means that failure lands at assembly rather than on a caller's first filtered search.
  const filterable = new Map<string, MetadataIndexDescriptor[]>();
  for (const [name, index] of Object.entries(config.indexes)) {
    filterable.set(name, index.metadata ? metadataIndexes(index.metadata) : []);
  }

  const resolve =
    options.resolveDeps ??
    ((c: Context<PithyHonoEnv>, indexName: string): HandlerDeps => {
      const index = indexConfig(config, indexName);
      return {
        documents: vectorDocuments(vectorDatabase(binding<D1Database>(c, "DB", "Bind a D1 database named DB."))),
        store: binding<VectorStore>(
          c,
          index.binding,
          `Bind the Vectorize index as \`${index.binding}\` in wrangler.jsonc, then run \`pithy vector provision\`.`,
        ),
        ai: binding<VectorAi>(c, "AI", "Bind Workers AI as `AI` in wrangler.jsonc."),
        index,
        indexName,
        filterable: filterable.get(indexName) ?? [],
        defaultTopK: config.defaultTopK,
        newId: () => crypto.randomUUID(),
        now: () => new Date(),
      };
    });

  return (app) => {
    app.post(
      `${base}/:index/documents`,
      requireAuth(),
      zValidator("param", VectorIndexParams, validationHook),
      zValidator("json", UpsertDocumentsInput, validationHook),
      async (c) => {
        const deps = resolve(c, c.req.valid("param").index);
        return c.json(await upsertDocuments(deps, c.req.valid("json")), 201);
      },
    );

    app.post(
      `${base}/:index/query`,
      requireAuth(),
      zValidator("param", VectorIndexParams, validationHook),
      zValidator("json", QueryInput, validationHook),
      async (c) => {
        const deps = resolve(c, c.req.valid("param").index);
        return c.json(await queryDocuments(deps, c.req.valid("json")));
      },
    );

    app.get(
      `${base}/:index/documents/:id`,
      requireAuth(),
      zValidator("param", VectorDocumentParams, validationHook),
      async (c) => {
        const params = c.req.valid("param");
        return c.json(await getDocument(resolve(c, params.index), params.id));
      },
    );

    app.delete(
      `${base}/:index/documents/:id`,
      requireAuth(),
      zValidator("param", VectorDocumentParams, validationHook),
      async (c) => {
        const params = c.req.valid("param");
        return c.json(await deleteDocument(resolve(c, params.index), params.id));
      },
    );
  };
}

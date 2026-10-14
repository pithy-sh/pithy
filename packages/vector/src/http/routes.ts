// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { type AmbientEnv, compositionEnvironment } from "@pithy-sh/core/src/env/ambient";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { describeRoute } from "@pithy-sh/core/src/http/routeSpec";
import { validate } from "@pithy-sh/core/src/http/validation";
import type { VerificationStrategy } from "@pithy-sh/core/src/http/verification";
import type { Context, Hono } from "hono";
import type { VectorConfig, VectorIndexConfig } from "../config/config";
import { vectorDocuments } from "../data/documents";
import { vectorDatabase } from "../data/tables";
import type { VectorAi } from "../embed/embed";
import { VectorIndexNotFoundError } from "../error/errors";
import type { VectorStore } from "../index/index";
import { type MetadataIndexDescriptor, metadataIndexes } from "../index/metadata";
import { provisionVectors } from "../index/provisioned";
import { requireAuth } from "./guard";
import { deleteDocument, getDocument, type HandlerDeps, queryDocuments, upsertDocuments } from "./handlers";
import { DeleteResponse, QueryResponse, UpsertResponse, VectorDocumentResponse } from "./responses";
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

/**
 * Read a binding by name, throwing rather than returning undefined — a missing binding is a config fault. The
 * remedy is built only then: it is read off the Worker's environment, and building it on every request put a
 * sentence on the path of every search that only a missing binding ever needs (#711).
 */
function binding<T>(c: Context<PithyHonoEnv>, name: string, action: () => string): T {
  const value = (c.env as Record<string, unknown>)[name] as T | undefined;
  if (!value) {
    throw new InternalError({
      message: "Search is not configured.",
      action: action(),
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

/** `requireAuth()` lets either a bearer token or a session through. */
const AUTHENTICATED: readonly VerificationStrategy[] = ["bearer", "session"];

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
        documents: vectorDocuments(vectorDatabase(binding<D1Database>(c, "DB", () => "Bind a D1 database named DB."))),
        store: binding<VectorStore>(
          c,
          index.binding,
          () =>
            `Bind the Vectorize index as \`${index.binding}\` in wrangler.jsonc. ${provisionVectors(compositionEnvironment(c.env as AmbientEnv), "create it")}`,
        ),
        ai: binding<VectorAi>(c, "AI", () => "Bind Workers AI as `AI` in wrangler.jsonc."),
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
      describeRoute({
        summary: "Write documents into an index.",
        description:
          "Embeds any text with the index's model. The vectors are enqueued, so a query may not see them at once.",
        verification: AUTHENTICATED,
        responses: { 201: UpsertResponse },
      }),
      requireAuth(),
      validate("param", VectorIndexParams),
      validate("json", UpsertDocumentsInput),
      async (c) => {
        const deps = resolve(c, c.req.valid("param").index);
        return c.json(await upsertDocuments(deps, c.req.valid("json")), 201);
      },
    );

    app.post(
      `${base}/:index/query`,
      describeRoute({
        summary: "Search an index.",
        description: "Each match is hydrated with its document from the corpus.",
        verification: AUTHENTICATED,
        responses: { 200: QueryResponse },
      }),
      requireAuth(),
      validate("param", VectorIndexParams),
      validate("json", QueryInput),
      async (c) => {
        const deps = resolve(c, c.req.valid("param").index);
        return c.json(await queryDocuments(deps, c.req.valid("json")));
      },
    );

    app.get(
      `${base}/:index/documents/:id`,
      describeRoute({
        summary: "Read one document.",
        verification: AUTHENTICATED,
        responses: { 200: VectorDocumentResponse },
      }),
      requireAuth(),
      validate("param", VectorDocumentParams),
      async (c) => {
        const params = c.req.valid("param");
        return c.json(await getDocument(resolve(c, params.index), params.id));
      },
    );

    app.delete(
      `${base}/:index/documents/:id`,
      describeRoute({
        summary: "Delete a document.",
        description: "Removes it from the index and from the corpus.",
        verification: AUTHENTICATED,
        responses: { 200: DeleteResponse },
      }),
      requireAuth(),
      validate("param", VectorDocumentParams),
      async (c) => {
        const params = c.req.valid("param");
        return c.json(await deleteDocument(resolve(c, params.index), params.id));
      },
    );
  };
}

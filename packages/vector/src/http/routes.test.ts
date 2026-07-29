import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { VectorConfig } from "../config/config";
import type { VectorDocument } from "../data/document";
import type { DocumentStore } from "../data/documents";
import type { VectorAi } from "../embed/embed";
import { filterable } from "../index/filter";
import type { VectorStore } from "../index/index";
import type { HandlerDeps } from "./handlers";
import { registerVectorRoutes } from "./routes";

/**
 * The route surface: the mount paths, the auth gate on every one of them, and the 404 an unknown index name
 * gets out of config alone — before any binding is touched.
 */

const metadata = z.object({
  ownerId: filterable(z.string().describe("Owner.")),
  title: z.string().describe("Title."),
});

const config = VectorConfig.parse({
  indexes: { docs: { model: "current-model", dimensions: 3, metadata } },
  defaultTopK: 5,
});

const at = new Date("2026-07-01T00:00:00.000Z");

const stored: VectorDocument = {
  id: "a",
  indexName: "docs",
  namespace: null,
  content: "text a",
  metadata: { ownerId: "ada" },
  model: "current-model",
  createdAt: at,
  updatedAt: at,
};

const documents: DocumentStore = {
  async put() {},
  async get(_indexName, id) {
    return id === "a" ? stored : null;
  },
  async byIds(_indexName, ids) {
    return ids.includes("a") ? [stored] : [];
  },
  async remove() {
    return true;
  },
  async page() {
    return [];
  },
  async markEmbedded() {},
};

const store: VectorStore = {
  async upsert() {
    return { mutationId: "m1" };
  },
  async query() {
    return { count: 1, matches: [{ id: "a", score: 0.9 }] };
  },
  async deleteByIds() {
    return { mutationId: "m2" };
  },
};

const ai: VectorAi = {
  async run(_model, input) {
    return { data: (input as { text: string[] }).text.map(() => [1, 2, 3]) };
  },
};

/** An app with the vector routes, an auth middleware gated on an `x-user` header, and the error codec. */
function app(): Hono<PithyHonoEnv> {
  const hono = new Hono<PithyHonoEnv>();
  hono.use("*", async (c, next) => {
    const user = c.req.header("x-user");
    c.set("auth", user ? { userId: user, sessionId: "s1", scopes: [] } : null);
    await next();
  });
  hono.onError(pithyErrorHandler);

  const index = config.indexes.docs;
  if (!index) throw new Error("test config lost its index");
  registerVectorRoutes({
    config,
    resolveDeps: (_c, indexName): HandlerDeps => {
      if (indexName !== "docs") {
        // Mirrors the real resolver: an unknown index is a 404 from config, before any binding is read.
        throw Object.assign(new Error("unreachable"), { name: "unreachable" });
      }
      return {
        documents,
        store,
        ai,
        index,
        indexName,
        filterable: [{ propertyName: "ownerId", indexType: "string" }],
        defaultTopK: config.defaultTopK,
        newId: () => "generated-id",
        now: () => at,
      };
    },
  })(hono);
  return hono;
}

const authed = { "x-user": "ada", "content-type": "application/json" };

describe("the vector routes", () => {
  it("denies every route without an authenticated caller", async () => {
    const hono = app();
    const denied = await Promise.all([
      hono.request("/vector/docs/documents", { method: "POST", body: "{}" }),
      hono.request("/vector/docs/query", { method: "POST", body: "{}" }),
      hono.request("/vector/docs/documents/a"),
      hono.request("/vector/docs/documents/a", { method: "DELETE" }),
    ]);
    expect(denied.map((response) => response.status)).toEqual([401, 401, 401, 401]);
  });

  it("writes a document", async () => {
    const response = await app().request("/vector/docs/documents", {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ text: "hello" }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ids: ["generated-id"], mutationId: "m1" });
  });

  it("searches and returns hydrated matches, not bare ids", async () => {
    const response = await app().request("/vector/docs/query", {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ text: "hello" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { matches: { id: string; document: { content: string } | null }[] };
    expect(body.matches[0]?.id).toBe("a");
    expect(body.matches[0]?.document?.content).toBe("text a");
  });

  it("fetches one document and 404s an unknown id", async () => {
    const hono = app();
    expect((await hono.request("/vector/docs/documents/a", { headers: authed })).status).toBe(200);
    expect((await hono.request("/vector/docs/documents/zz", { headers: authed })).status).toBe(404);
  });

  it("deletes a document", async () => {
    const response = await app().request("/vector/docs/documents/a", { method: "DELETE", headers: authed });
    expect(await response.json()).toEqual({ id: "a", mutationId: "m2" });
  });

  it("404s an index the config does not declare, before any binding is read", async () => {
    // The real resolver, not the test seam: an unknown name must fail on config alone.
    const hono = new Hono<PithyHonoEnv>();
    hono.use("*", async (c, next) => {
      c.set("auth", { userId: "ada", sessionId: "s1", scopes: [] });
      await next();
    });
    hono.onError(pithyErrorHandler);
    registerVectorRoutes({ config })(hono);

    const response = await hono.request("/vector/nope/documents/a", { headers: authed });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "vector/index_not_found" } });
  });
});

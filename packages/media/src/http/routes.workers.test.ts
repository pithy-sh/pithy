import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { MediaConfig } from "../config/config";
import { extendMediaAsset } from "../data/extend";
import type { MediaStorage } from "../storage/storage";
import type { HandlerDeps } from "./handlers";
import { registerMediaRoutes } from "./routes";

const schema = extendMediaAsset();

/** A fake storage seam. */
const storage: MediaStorage = {
  mintUpload: async (p) => ({ uploadUrl: `https://up/${p.id}`, storageBackend: "cf-images", storageKey: `k-${p.id}` }),
  deleteObject: async () => {},
  readR2Object: async () => new Uint8Array(),
  presignedDownloadUrl: async (l) => `https://dl/${l.storageKey}`,
};

/** An in-memory record store so the authorized path returns real data without D1. */
function memStore() {
  const map = new Map<string, Record<string, unknown>>();
  return {
    create: async (r: Record<string, unknown>) => {
      map.set(String(r.id), r);
      return r;
    },
    get: async (id: string) => map.get(id) ?? null,
    patch: async (id: string, c: Record<string, unknown>) => {
      const merged = { ...map.get(id), ...c };
      map.set(id, merged);
      return merged;
    },
    delete: async (id: string) => {
      map.delete(id);
    },
    list: async () => ({ items: [...map.values()] }),
  };
}

/** A no-op hash store — the route tests don't exercise dedup. */
const hashes = {
  upsert: async () => {},
  deleteByMedia: async () => {},
  findBySha256: async () => [],
  listImagePhashes: async () => [],
};

/** Build a Hono app with the media routes, an auth middleware gated by an `x-user` header, and the error codec. */
function makeApp() {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  // Simulate @pithy-sh/auth: populate c.var.auth only when an `x-user` header is present.
  app.use("*", async (c, next) => {
    const user = c.req.header("x-user");
    if (user) c.set("auth", { userId: user, sessionId: "s1", scopes: [] });
    else c.set("auth", null);
    await next();
  });
  const deps = {
    store: memStore(),
    hashes,
    storage,
    schema,
    config: MediaConfig.parse({}),
    dispatchEnrichment: async () => {},
    newId: () => "fixed",
    now: () => new Date(0),
  } as unknown as HandlerDeps;
  registerMediaRoutes({ config: MediaConfig.parse({}), schema, resolveDeps: async () => deps })(app);
  return app;
}

describe("media routes — verification strategy", () => {
  test("an unauthenticated request is denied (401)", async () => {
    const app = makeApp();
    const res = await app.request("/media", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "image", name: "n", filename: "a.png", contentType: "image/png" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; detail?: string } };
    expect(body.error.code).toBe("auth/invalid_token");
    // The HTTP codec strips internal detail.
    expect(body.error.detail).toBeUndefined();
  });

  test("an authenticated upload-init mints a URL and creates a record (201)", async () => {
    const app = makeApp();
    const res = await app.request("/media", {
      method: "POST",
      headers: { "content-type": "application/json", "x-user": "u-1" },
      body: JSON.stringify({ type: "image", name: "n", filename: "a.png", contentType: "image/png" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; uploadUrl: string };
    expect(body.id).toBe("fixed");
    expect(body.uploadUrl).toContain("https://up/");
  });

  test("an authenticated GET of a missing record is a 404 with the media code", async () => {
    const app = makeApp();
    const res = await app.request("/media/ghost", { headers: { "x-user": "u-1" } });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("media/not_found");
  });
});

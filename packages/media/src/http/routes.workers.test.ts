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

/** The `PithyError` payload the HTTP codec wrote, for the rejection-path assertions. */
async function errorOf(res: Response) {
  const body = (await res.json()) as { error: { code: string; status: number; message: string } };
  return body.error;
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
    // `MediaIdParam` is a bounded generic string, not `z.uuid()`, so a well-formed but unknown id still
    // reaches the store and answers the domain 404 — the param validator is a shape check, not a lookup.
    const res = await app.request("/media/ghost", { headers: { "x-user": "u-1" } });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("media/not_found");
  });

  test("the guard runs before the validator — an unauthenticated malformed request is 401, not 400", async () => {
    const app = makeApp();
    const res = await app.request("/media", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "hologram" }),
    });
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe("auth/invalid_token");
  });
});

describe("media routes — declared request shapes", () => {
  // These assertions moved here from handlers.workers.test.ts: the handlers no longer parse their input,
  // so a malformed request is now rejected by the route's zValidator before any handler runs.

  test("a malformed body is a 400 with the validation code (bad media type)", async () => {
    const app = makeApp();
    const res = await app.request("/media", {
      method: "POST",
      headers: { "content-type": "application/json", "x-user": "u-1" },
      body: JSON.stringify({ type: "hologram", name: "n", filename: "a.png", contentType: "image/png" }),
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("validation/invalid_input");
  });

  test("an unparseable JSON body is a 400, not the 500 the old bare body read produced", async () => {
    const app = makeApp();
    const res = await app.request("/media", {
      method: "POST",
      headers: { "content-type": "application/json", "x-user": "u-1" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("validation/invalid_input");
  });

  test("a malformed duplicate-search body is a 400", async () => {
    const app = makeApp();
    const res = await app.request("/media/duplicates", {
      method: "POST",
      headers: { "content-type": "application/json", "x-user": "u-1" },
      body: JSON.stringify({ type: "image", sha256: "not-a-sha" }),
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("validation/invalid_input");
  });

  test("a malformed query is a 400 (limit over the cap)", async () => {
    const app = makeApp();
    const res = await app.request("/media?limit=999", { headers: { "x-user": "u-1" } });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("validation/invalid_input");
  });

  test("an over-long cursor is a 400 — the free-form continuation token is bounded", async () => {
    const app = makeApp();
    const res = await app.request(`/media?cursor=${"9".repeat(65)}`, { headers: { "x-user": "u-1" } });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("validation/invalid_input");
  });

  test("an empty cursor still lists — `?cursor=` decoded to offset 0 before, and still does", async () => {
    const app = makeApp();
    const res = await app.request("/media?cursor=", { headers: { "x-user": "u-1" } });
    expect(res.status).toBe(200);
  });

  test("a malformed param is a 400 — the validator now wins over the handler's 404", async () => {
    const app = makeApp();
    // Over the 128-character bound AND unresolvable. Order is deliberate: the param validator runs first,
    // so this is the validator's 400, not the store lookup's `media/not_found` 404.
    const res = await app.request(`/media/${"x".repeat(129)}`, { headers: { "x-user": "u-1" } });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("validation/invalid_input");
  });

  test("a malformed finalize body is a 400 even though every field is optional", async () => {
    const app = makeApp();
    const res = await app.request("/media/fixed/finalize", {
      method: "POST",
      headers: { "content-type": "application/json", "x-user": "u-1" },
      body: JSON.stringify({ sha256: "zz" }),
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("validation/invalid_input");
  });

  test("a well-formed request reaches the handler with the parsed values", async () => {
    const app = makeApp();
    const created = await app.request("/media", {
      method: "POST",
      headers: { "content-type": "application/json", "x-user": "u-1" },
      body: JSON.stringify({ type: "image", name: "n", filename: "a.png", contentType: "image/png" }),
    });
    expect(created.status).toBe(201);
    const res = await app.request("/media/fixed/finalize", {
      method: "POST",
      headers: { "content-type": "application/json", "x-user": "u-1" },
      body: JSON.stringify({ size: 2048 }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ id: "fixed", status: "stored", size: 2048 });
  });
});

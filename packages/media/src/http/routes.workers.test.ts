// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import type { z } from "zod";
import { MediaConfig } from "../config/config";
import { extendMediaAsset } from "../data/extend";
import { caller, makeDeps, resetMediaTables } from "../test-utils/harness";
import {
  DuplicatesResponse,
  MediaDeletedResponse,
  MediaDeliveryUrlResponse,
  MediaListResponse,
  MediaRecordResponse,
  MediaUploadInitResponse,
} from "./responses";
import { registerMediaRoutes } from "./routes";

const schema = extendMediaAsset();

beforeEach(() => resetMediaTables(env.DB));

/**
 * Build a Hono app with the media routes over a real D1, an auth middleware gated by an `x-user` header,
 * an `x-org` header standing in for the organization in force, and the error codec.
 */
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
  registerMediaRoutes({
    config: MediaConfig.parse({}),
    schema,
    resolveDeps: async (c) =>
      makeDeps(env.DB, caller(c.var.auth?.userId ?? null, c.req.header("x-org") ?? null), { newId: () => "fixed" }),
  })(app);
  return app;
}

/**
 * Read a response through its schema in `responses.ts`, and require the parse to hand back exactly what
 * arrived. That is the binding between the contract and the handler: a field the handler adds or drops
 * without the schema fails here, on a real answer.
 */
async function conforming<Schema extends z.ZodType>(res: Response, schema: Schema): Promise<z.infer<Schema>> {
  const body: unknown = await res.json();
  expect(schema.parse(body)).toEqual(body);
  return body as z.infer<Schema>;
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
    const body = await conforming(res, MediaUploadInitResponse);
    expect(body.id).toBe("fixed");
    expect(body.uploadUrl).toContain("https://upload.example/");
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
  // so a malformed request is now rejected by the route's validator before any handler runs.

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
    expect(await conforming(res, MediaRecordResponse)).toMatchObject({ id: "fixed", status: "stored", size: 2048 });
  });
});

describe("media routes — response shapes", () => {
  test("read, list, duplicate search and delete each answer with their declared shape", async () => {
    const app = makeApp();
    const headers = { "content-type": "application/json", "x-user": "u-1" };
    await app.request("/media", {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "image", name: "n", filename: "a.png", contentType: "image/png" }),
    });

    const one = await app.request("/media/fixed", { headers });
    expect(one.status).toBe(200);
    expect(await conforming(one, MediaRecordResponse)).toMatchObject({
      id: "fixed",
      status: "pending",
      ownerId: "u-1",
      organizationId: null,
      visibility: "private",
      signedDelivery: true,
      signingPending: false,
    });

    const url = await app.request("/media/fixed/url", { headers });
    expect(url.status).toBe(200);
    expect((await conforming(url, MediaDeliveryUrlResponse)).expiresAt).not.toBeNull();

    const patched = await app.request("/media/fixed", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "renamed" }),
    });
    expect(patched.status).toBe(200);
    expect(await conforming(patched, MediaRecordResponse)).toMatchObject({ name: "renamed" });

    const list = await app.request("/media", { headers });
    expect(list.status).toBe(200);
    expect((await conforming(list, MediaListResponse)).items.map((item) => item.id)).toEqual(["fixed"]);

    const duplicates = await app.request("/media/duplicates", {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "image", sha256: "a".repeat(64) }),
    });
    expect(duplicates.status).toBe(200);
    expect(await conforming(duplicates, DuplicatesResponse)).toEqual({ matches: [] });

    const deleted = await app.request("/media/fixed", { method: "DELETE", headers });
    expect(deleted.status).toBe(200);
    expect(await conforming(deleted, MediaDeletedResponse)).toEqual({ id: "fixed", deleted: true });
  });
});

describe("media routes — who may reach a record", () => {
  const create = (app: ReturnType<typeof makeApp>, visibility: string) =>
    app.request("/media", {
      method: "POST",
      headers: { "content-type": "application/json", "x-user": "owner", "x-org": "org-a" },
      body: JSON.stringify({ type: "image", name: "n", filename: "a.png", contentType: "image/png", visibility }),
    });

  test("a public record reads without signing in", async () => {
    const app = makeApp();
    expect((await create(app, "public")).status).toBe(201);
    const res = await app.request("/media/fixed");
    expect(res.status).toBe(200);
    expect(await conforming(res, MediaRecordResponse)).toMatchObject({ id: "fixed", visibility: "public" });
    expect((await app.request("/media/fixed/url")).status).toBe(200);
  });

  test("a public record names its owner and organization only to a reader acting for that organization", async () => {
    const app = makeApp();
    expect((await create(app, "public")).status).toBe(201);
    const hidden = { ownerId: null, organizationId: null };

    // Read by nobody in particular, or from another organization, the pair would disclose a membership.
    expect(await conforming(await app.request("/media/fixed"), MediaRecordResponse)).toMatchObject(hidden);
    const outsider = { "x-user": "stranger", "x-org": "org-b" };
    expect(
      await conforming(await app.request("/media/fixed", { headers: outsider }), MediaRecordResponse),
    ).toMatchObject(hidden);
    const listed = await conforming(
      await app.request("/media?includePublic=true", { headers: outsider }),
      MediaListResponse,
    );
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject(hidden);

    // A colleague acting for org-a is told who holds it there.
    const colleague = { "x-user": "colleague", "x-org": "org-a" };
    expect(
      await conforming(await app.request("/media/fixed", { headers: colleague }), MediaRecordResponse),
    ).toMatchObject({ ownerId: "owner", organizationId: "org-a" });
  });

  test("a private record is not found — never forbidden — without a session, or for anyone else", async () => {
    const app = makeApp();
    await create(app, "private");
    const callers: Record<string, string>[] = [{}, { "x-user": "stranger" }, { "x-user": "owner", "x-org": "org-b" }];
    for (const headers of callers) {
      const read = await app.request("/media/fixed", { headers });
      expect(read.status).toBe(404);
      expect((await errorOf(read)).code).toBe("media/not_found");
      const url = await app.request("/media/fixed/url", { headers });
      expect(url.status).toBe(404);
    }
    const strangerDelete = await app.request("/media/fixed", { method: "DELETE", headers: { "x-user": "stranger" } });
    expect(strangerDelete.status).toBe(404);
    // Without a session a delete is refused before any record is looked up — a 401 that says nothing about it.
    const anonymousDelete = await app.request("/media/fixed", { method: "DELETE" });
    expect(anonymousDelete.status).toBe(401);
    const list = await app.request("/media?includePublic=true", { headers: { "x-user": "stranger" } });
    expect((await conforming(list, MediaListResponse)).items).toEqual([]);
  });

  test("a member who may read an organization record is forbidden to delete it", async () => {
    const app = makeApp();
    await create(app, "organization");
    const res = await app.request("/media/fixed", {
      method: "DELETE",
      headers: { "x-user": "colleague", "x-org": "org-a" },
    });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("media/forbidden");
  });

  test("an upload naming a level outside the policy is a 400, not a quiet default", async () => {
    const app = makeApp();
    const res = await app.request("/media", {
      method: "POST",
      headers: { "content-type": "application/json", "x-user": "owner" },
      body: JSON.stringify({
        type: "image",
        name: "n",
        filename: "a.png",
        contentType: "image/png",
        visibility: "organization",
      }),
    });
    expect(res.status).toBe(400);
  });
});

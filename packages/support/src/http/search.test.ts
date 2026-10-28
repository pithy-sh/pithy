// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { validate } from "@pithy-sh/core/src/http/validation";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { ListThreadsQuery, SearchThreadsQuery } from "./schemas";
import { supportAdminRoutes } from "./scopes";

/**
 * The listing and search request contracts, through the real `validate` and the real error handler: the listing
 * takes no `q`, and says so, and the search route takes `q`, a mode, a limit and the inbox filters.
 */

function app() {
  const hono = new Hono<PithyHonoEnv>();
  hono.onError(pithyErrorHandler);
  hono.get("/list", validate("query", ListThreadsQuery), (c) => c.json(c.req.valid("query")));
  hono.get("/search", validate("query", SearchThreadsQuery), (c) => c.json(c.req.valid("query")));
  return hono;
}

describe("the inbox listing", () => {
  test("refuses `q` as validation/invalid_input rather than ignoring it", async () => {
    const response = await app().request("/list?q=refund");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "validation/invalid_input" } });
  });

  test("still takes its filters and its cursor", async () => {
    const response = await app().request("/list?archived=true&assignee=none&limit=5&cursor=abc");
    expect(response.status).toBe(200);
  });
});

describe("the search query", () => {
  test("takes q, a mode, a limit and every inbox filter", async () => {
    const response = await app().request(
      "/search?q=ORD-40912&mode=hybrid&limit=50&archived=false&category=billing&declaredCategory=billing&priority=urgent&sentiment=angry&channel=email&inbox=support%40help.example.com&assignee=none",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ q: "ORD-40912", mode: "hybrid", limit: 50 });
  });

  test("defaults are the handler's: no mode and no limit is a valid search", async () => {
    expect(SearchThreadsQuery.parse({ q: "refund" })).toEqual({ q: "refund" });
  });

  test("refuses a limit over 50, an unknown mode, an empty q, a cursor, and no q at all", async () => {
    for (const query of ["q=x&limit=51", "q=x&mode=fuzzy", "q=%20", "q=x&cursor=abc", "mode=keyword"]) {
      expect((await app().request(`/search?${query}`)).status, query).toBe(400);
    }
  });
});

describe("the manifest", () => {
  test("advertises the search route under the read scope, as the threads.search operation", () => {
    expect(supportAdminRoutes("/inbox")).toContainEqual(
      expect.objectContaining({
        method: "GET",
        operation: "threads.search",
        path: "/inbox/threads/search",
        scope: "support:threads:read",
      }),
    );
  });
});

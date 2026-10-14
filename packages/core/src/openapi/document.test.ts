// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { pithyErrorHandler } from "../error/http";
import { NotFoundError } from "../error/pithyError";
import { ErrorBody } from "../error/wire";
import { describeRoute } from "../http/routeSpec";
import { validate } from "../http/validation";
import {
  type OpenApiDocument,
  openApiDocument,
  openApiPath,
  operationId,
  type RouteGroup,
  undescribedFields,
  undescribedRoutes,
} from "./document";

const BoardParam = z.object({ board: z.string().describe("The board's key.") }).describe("Which board.");
const TopQuery = z
  .object({
    limit: z.coerce.number().int().default(10).describe("How many entries."),
    after: z.string().optional().describe("Resume after this cursor."),
  })
  .describe("Paging.");
const Submit = z.object({ score: z.number().describe("The score.") }).describe("A score to record.");
const Entry = z.object({ rank: z.number().describe("Position, from 1.") }).describe("One ranked entry.");

const INFO = { title: "Test", version: "1.0.0" };

/** A group made the way `createBackend` makes one: a fresh app, one hook, its route slice. */
function group(tag: string, register: (app: Hono) => void): RouteGroup {
  const app = new Hono();
  register(app);
  return { tag, routes: app.routes };
}

const games = group("games", (app) => {
  app.get(
    "/games/:board/top",
    describeRoute({ summary: "Read the top.", verification: ["bearer", "session"], responses: { 200: Entry } }),
    validate("param", BoardParam),
    validate("query", TopQuery),
    (c) => c.json({ rank: 1 }),
  );
  app.post(
    "/games/:board",
    describeRoute({
      summary: "Submit a score.",
      verification: "bearer",
      scopes: ["games:submit"],
      responses: { 201: Entry },
    }),
    validate("param", BoardParam),
    validate("json", Submit),
    (c) => c.json({ rank: 1 }, 201),
  );
});

function operation(document: OpenApiDocument, path: string, method: string) {
  return document.paths[path]?.[method] as Record<string, unknown>;
}

describe("openApiPath", () => {
  test("turns Hono params into templates, dropping a regex and an optional marker", () => {
    expect(openApiPath("/a/:id/b/:name")).toBe("/a/{id}/b/{name}");
    expect(openApiPath("/a/:id{[0-9]+}")).toBe("/a/{id}");
    expect(openApiPath("/a/:id?")).toBe("/a/{id}");
  });

  test("names a wildcard tail as one path parameter", () => {
    expect(openApiPath("/auth/*")).toBe("/auth/{path}");
  });
});

describe("operationId", () => {
  test("is the method and the path's words, camel-cased", () => {
    expect(operationId("GET", "/leaderboard/{board}/top")).toBe("getLeaderboardByBoardTop");
    expect(operationId("delete", "/control-plane/tokens/{id}")).toBe("deleteControlPlaneTokensById");
  });

  test("a parameter does not read as the literal segment it shares a name with", () => {
    expect(operationId("get", "/items/{id}")).not.toBe(operationId("get", "/items/id"));
  });
});

describe("openApiDocument", () => {
  const document = openApiDocument(INFO, [games]);

  test("is OpenAPI 3.1 with the info it was given, and one tag per described group", () => {
    expect(document.openapi).toBe("3.1.0");
    expect(document.info).toEqual(INFO);
    expect(document.tags).toEqual([{ name: "games" }]);
  });

  test("reads path and query parameters off the validators, with their descriptions", () => {
    const get = operation(document, "/games/{board}/top", "get");
    expect(get.parameters).toEqual([
      { name: "board", in: "path", required: true, description: "The board's key.", schema: { type: "string" } },
      {
        name: "limit",
        in: "query",
        required: false,
        description: "How many entries.",
        schema: expect.objectContaining({ type: "integer" }),
      },
      {
        name: "after",
        in: "query",
        required: false,
        description: "Resume after this cursor.",
        schema: { type: "string" },
      },
    ]);
  });

  test("reads the JSON body off the json validator", () => {
    const post = operation(document, "/games/{board}", "post");
    expect(post.requestBody).toEqual({
      required: true,
      description: "A score to record.",
      content: {
        "application/json": {
          schema: expect.objectContaining({
            type: "object",
            properties: { score: { type: "number", description: "The score." } },
          }),
        },
      },
    });
  });

  test("takes summary, responses and verification from describeRoute", () => {
    const get = operation(document, "/games/{board}/top", "get");
    expect(get.summary).toBe("Read the top.");
    expect(get.operationId).toBe("getGamesByBoardTop");
    expect(get.tags).toEqual(["games"]);
    expect(get.security).toEqual([{ bearer: [] }, { session: [] }]);
    expect(get["x-pithy-verification"]).toEqual(["bearer", "session"]);
    expect(get.responses).toEqual({
      200: {
        description: "One ranked entry.",
        content: { "application/json": { schema: expect.objectContaining({ type: "object" }) } },
      },
      default: { $ref: "#/components/responses/Error" },
    });
  });

  test("names the scopes a route requires", () => {
    expect(operation(document, "/games/{board}", "post")["x-pithy-scopes"]).toEqual(["games:submit"]);
    expect(operation(document, "/games/{board}/top", "get")["x-pithy-scopes"]).toBeUndefined();
  });

  test("a public route is open, and a signed webhook has no scheme to require", () => {
    const hooks = group("hooks", (app) => {
      app.get("/open", describeRoute({ summary: "Open.", verification: "public", responses: { 200: Entry } }), (c) =>
        c.json({ rank: 1 }),
      );
      app.post(
        "/hook",
        describeRoute({
          summary: "Receive.",
          verification: "signed-webhook",
          responses: { 204: { description: "Accepted." } },
        }),
        (c) => c.body(null, 204),
      );
    });
    const doc = openApiDocument(INFO, [hooks]);
    expect(operation(doc, "/open", "get").security).toEqual([{}]);
    expect(operation(doc, "/hook", "post").security).toEqual([]);
    expect(operation(doc, "/hook", "post").responses).toEqual({
      204: { description: "Accepted." },
      default: { $ref: "#/components/responses/Error" },
    });
  });

  test("a non-JSON response carries its media type", () => {
    const files = group("files", (app) => {
      app.get(
        "/file",
        describeRoute({
          summary: "Read bytes.",
          verification: "bearer",
          responses: { 200: { description: "The bytes.", contentType: "application/octet-stream" } },
        }),
        (c) => c.body("x"),
      );
    });
    const get = operation(openApiDocument(INFO, [files]), "/file", "get");
    expect((get.responses as Record<string, unknown>)[200]).toEqual({
      description: "The bytes.",
      content: { "application/octet-stream": { schema: {} } },
    });
  });

  test("an app.all route is documented under the methods its spec names, with the wildcard as a parameter", () => {
    const auth = group("auth", (app) => {
      app.all(
        "/auth/*",
        describeRoute({
          summary: "Better Auth.",
          verification: ["public", "session"],
          methods: ["get", "post"],
          responses: { 200: { description: "Better Auth's answer.", contentType: "application/json" } },
        }),
        (c) => c.text("x"),
      );
    });
    const doc = openApiDocument(INFO, [auth]);
    expect(Object.keys(doc.paths["/auth/{path}"] ?? {})).toEqual(["get", "post"]);
    expect(operation(doc, "/auth/{path}", "get").parameters).toEqual([
      expect.objectContaining({ name: "path", in: "path", required: true }),
    ]);
  });

  test("leaves out middleware and undescribed routes rather than guessing at them", () => {
    const mixed = group("mixed", (app) => {
      app.use("/mixed/*", async (_c, next) => next());
      app.get("/mixed/bare", (c) => c.text("x"));
    });
    const doc = openApiDocument(INFO, [mixed]);
    expect(doc.paths).toEqual({});
    expect(doc.tags).toEqual([]);
  });

  test("under undescribed: include, an undescribed route is written from its validators and marked", () => {
    const mine = group("app", (app) => {
      app.use("/mine/*", async (_c, next) => next());
      app.get("/mine/:id", validate("param", BoardParam), (c) => c.text("x"));
    });
    const doc = openApiDocument(INFO, [mine], { undescribed: "include" });
    expect(Object.keys(doc.paths)).toEqual(["/mine/{id}"]);
    const get = operation(doc, "/mine/{id}", "get");
    expect(get["x-pithy-undescribed"]).toBe(true);
    expect(get.security).toBeUndefined();
    expect(get.parameters).toEqual([
      { name: "board", in: "path", required: true, description: "The board's key.", schema: { type: "string" } },
      { name: "id", in: "path", required: true, schema: { type: "string" } },
    ]);
    expect(doc.tags).toEqual([{ name: "app" }]);
  });

  test("numbers a repeated operation id rather than writing an invalid document", () => {
    const clash = group("clash", (app) => {
      app.get("/a-b", describeRoute({ summary: "One.", verification: "public", responses: {} }), (c) => c.text("1"));
      app.get("/a/b", describeRoute({ summary: "Two.", verification: "public", responses: {} }), (c) => c.text("2"));
    });
    const doc = openApiDocument(INFO, [clash]);
    expect(operation(doc, "/a-b", "get").operationId).toBe("getAB");
    expect(operation(doc, "/a/b", "get").operationId).toBe("getAB2");
  });

  test("describes the one error body every route can return", () => {
    expect(document.components.responses.Error).toEqual({
      description: expect.any(String),
      content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
    });
    expect(document.components.schemas.Error).toEqual(expect.objectContaining({ type: "object" }));
  });
});

describe("ErrorBody", () => {
  test("is the body pithyErrorHandler actually renders", async () => {
    const app = new Hono();
    app.onError(pithyErrorHandler);
    app.get("/", () => {
      throw new NotFoundError({ message: "No such board." });
    });
    const body = await (await app.request("/")).json();
    expect(ErrorBody.parse(body)).toEqual(body);
  });
});

describe("undescribedRoutes", () => {
  test("names every route with no describeRoute, and passes app.use middleware", () => {
    const mixed = group("mixed", (app) => {
      app.use("*", async (_c, next) => next());
      app.get("/bare", (c) => c.text("x"));
      app.post("/described", describeRoute({ summary: "x.", verification: "public", responses: {} }), (c) =>
        c.text("x"),
      );
    });
    expect(undescribedRoutes([mixed, games])).toEqual([{ method: "GET", path: "/bare" }]);
  });
});

describe("undescribedFields", () => {
  test("is empty for a fully described document", () => {
    expect(undescribedFields(openApiDocument(INFO, [games]))).toEqual([]);
  });

  test("names a property and a path parameter that carry no description", () => {
    const loose = group("loose", (app) => {
      app.get(
        "/loose/:id",
        describeRoute({
          summary: "Loose.",
          verification: "public",
          responses: { 200: z.object({ name: z.string() }).describe("A name.") },
        }),
        (c) => c.json({ name: "x" }),
      );
    });
    expect(undescribedFields(openApiDocument(INFO, [loose])).map((field) => field.pointer)).toEqual([
      "/paths/~1loose~1{id}/get/parameters/0",
      "/paths/~1loose~1{id}/get/responses/200/content/application~1json/schema/properties/name",
    ]);
  });
});

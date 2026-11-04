// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { pithyErrorHandler } from "../error/http";
import { NotFoundError } from "../error/pithyError";
import { ErrorBody } from "../error/wire";
import { freeText, notFreeText } from "../http/freeText";
import { describeRoute } from "../http/routeSpec";
import { validate } from "../http/validation";
import { pii } from "../privacy/classes";
import {
  addressedParameters,
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

  test("describes the bearer scheme as the session token, not the access token", () => {
    const bearer = document.components.securitySchemes.bearer as { description: string };
    expect(bearer.description).toContain("session token");
    expect(bearer.description).toContain("refreshToken");
    expect(bearer.description).not.toMatch(/short-lived access token/i);
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

  test("publishes a route's power, operation and tool effect, and says nothing when none is declared", () => {
    const declared = group("notes", (app) => {
      app.post(
        "/notes",
        describeRoute({
          summary: "Write.",
          verification: "bearer",
          responses: { 200: Entry },
          power: "notes:write",
          operation: "notes.write",
          tool: { effect: "writes" },
        }),
        (c) => c.json({ rank: 1 }),
      );
      app.get(
        "/notes",
        describeRoute({
          summary: "List.",
          verification: "bearer",
          responses: { 200: Entry },
          operation: "notes.list",
          tool: true,
        }),
        (c) => c.json({ rank: 1 }),
      );
    });
    const written = openApiDocument({ title: "T", version: "1" }, [declared]);
    expect(operation(written, "/notes", "post")).toMatchObject({
      "x-pithy-power": "notes:write",
      "x-pithy-operation": "notes.write",
      "x-pithy-tool": { effect: "writes" },
    });
    expect(operation(written, "/notes", "get")["x-pithy-tool"]).toEqual({ effect: null });
    expect(operation(written, "/notes", "get")["x-pithy-power"]).toBeUndefined();
    expect(operation(document, "/games/{board}/top", "get")["x-pithy-tool"]).toBeUndefined();
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

describe("addressedParameters", () => {
  /** One `GET` route whose query or path carries `field`, for the sweep to judge. */
  function carrying(target: "query" | "param", field: z.ZodType): OpenApiDocument {
    const Shape = z.object({ who: field.describe("Who.") }).describe("Who to look up.");
    const routed = group("people", (app) => {
      app.get(
        target === "param" ? "/people/:who" : "/people",
        describeRoute({ summary: "Look one up.", verification: "control-plane", responses: { 200: Entry } }),
        validate(target, Shape),
        (c) => c.json({ rank: 1 }),
      );
    });
    return openApiDocument(INFO, [routed]);
  }

  test("is empty for a document whose parameters are ids, keys and filters", () => {
    expect(addressedParameters(openApiDocument(INFO, [games]))).toEqual([]);
  });

  test.each([
    ["an address", z.email()],
    ["an optional address", z.email().optional()],
    ["a nullable address", z.email().nullable()],
    ["a string that must hold an @", z.string().min(3).includes("@")],
    ["a pattern that demands an @", z.string().regex(/^[^\s]+@[^\s]+$/)],
    ["a phone number", z.e164()],
    ["a field marked with a privacy class", pii(z.string().max(200))],
  ])("names %s in a query string", (_, field) => {
    expect(addressedParameters(carrying("query", field))).toEqual([
      { method: "GET", path: "/people", in: "query", name: "who" },
    ]);
  });

  test.each([
    ["a field marked free text", "who", freeText(z.string().max(200))],
    ["an optional field marked free text", "who", freeText(z.string().max(200)).optional()],
    ["a field described as free text", "who", z.string().max(200)],
    ["a search term by its name", "q", z.string().max(200)],
    ["a search by its name", "search", z.string().min(1).max(200).optional()],
    ["a reason by its name", "reason", z.string().min(1).max(500)],
    ["a note by its name", "note", z.string().max(500).optional()],
    ["a search term by a compound name", "searchTerm", z.string().max(200)],
    ["a reason by a snake-case name", "reason_text", z.string().max(200)],
    ["a list of terms", "terms", z.array(z.string().max(200))],
    ["a field described as free-form", "who", z.string().max(200)],
  ])("names %s in a query string", (label, name, field) => {
    const descriptions: Record<string, string> = {
      "a field described as free text": "Free text to match.",
      "a field described as free-form": "A free-form note.",
    };
    const described = field.describe(descriptions[label] ?? "Words.");
    const Shape = z.object({ [name]: described }).describe("What to find.");
    const routed = group("people", (app) => {
      app.get(
        "/people",
        describeRoute({ summary: "Find people.", verification: "control-plane", responses: { 200: Entry } }),
        validate("query", Shape),
        (c) => c.json({ rank: 1 }),
      );
    });
    expect(addressedParameters(openApiDocument(INFO, [routed]))).toEqual([
      { method: "GET", path: "/people", in: "query", name },
    ]);
  });

  test("names free text in a path segment", () => {
    expect(addressedParameters(carrying("param", freeText(z.string().max(200))))).toEqual([
      { method: "GET", path: "/people/{who}", in: "path", name: "who" },
    ]);
  });

  /** A `GET /people` whose query is `shape`, as the gate sees it. */
  function queried(shape: z.ZodObject): OpenApiDocument {
    const routed = group("people", (app) => {
      app.get(
        "/people",
        describeRoute({ summary: "Find people.", verification: "control-plane", responses: { 200: Entry } }),
        validate("query", shape.describe("What to find.")),
        (c) => c.json({ rank: 1 }),
      );
    });
    return openApiDocument(INFO, [routed]);
  }

  test("passes a description that says the value is not free text", () => {
    const shape = z.object({ key: z.string().max(64).describe("A key, not free text.") });
    expect(addressedParameters(queried(shape))).toEqual([]);
  });

  test("passes a free-text name declared `notFreeText()`, and still names an address under one", () => {
    const signed = z.object({ oauth_query: notFreeText(z.string().max(8192)).describe("A signed query string.") });
    expect(addressedParameters(queried(signed))).toEqual([]);
    const addressed = z.object({ query: notFreeText(z.email()).describe("An address.") });
    expect(addressedParameters(queried(addressed))).toEqual([
      { method: "GET", path: "/people", in: "query", name: "query" },
    ]);
  });

  test("passes a name that only contains a free-text word's letters", () => {
    const shape = z.object({
      subjectId: z.string().max(64).describe("Whose."),
      notebook: z.string().describe("Which."),
    });
    expect(addressedParameters(queried(shape))).toEqual([]);
  });

  test("passes a free-text name whose schema closes the value to a set", () => {
    const Shape = z
      .object({
        reason: z.enum(["hard_bounce", "complaint"]).optional().describe("Which reason."),
        message: z.coerce.number().int().optional().describe("A message number."),
      })
      .describe("Which rows.");
    const routed = group("people", (app) => {
      app.get(
        "/people",
        describeRoute({ summary: "Find people.", verification: "control-plane", responses: { 200: Entry } }),
        validate("query", Shape),
        (c) => c.json({ rank: 1 }),
      );
    });
    expect(addressedParameters(openApiDocument(INFO, [routed]))).toEqual([]);
  });

  test("passes free text in a body", () => {
    const bodied = group("people", (app) => {
      app.post(
        "/people/search",
        describeRoute({ summary: "Search people.", verification: "control-plane", responses: { 200: Entry } }),
        validate("json", z.object({ q: freeText(z.string().max(200)).describe("Words.") }).describe("What to find.")),
        (c) => c.json({ rank: 1 }),
      );
    });
    expect(addressedParameters(openApiDocument(INFO, [bodied]))).toEqual([]);
  });

  test("names an address in a path segment", () => {
    expect(addressedParameters(carrying("param", z.email()))).toEqual([
      { method: "GET", path: "/people/{who}", in: "path", name: "who" },
    ]);
  });

  test("passes an address in a body, which no access log records", () => {
    const bodied = group("people", (app) => {
      app.post(
        "/people/lookup",
        describeRoute({ summary: "Look one up.", verification: "control-plane", responses: { 200: Entry } }),
        validate("json", z.object({ who: z.email().describe("Who.") }).describe("Who to look up.")),
        (c) => c.json({ rank: 1 }),
      );
    });
    expect(addressedParameters(openApiDocument(INFO, [bodied]))).toEqual([]);
  });
});

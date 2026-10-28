// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { AppTool } from "@pithy-sh/core/src/mcp/tools";
import { describe, expect, test } from "vitest";
import { dispatchedAuth, dispatchedOutcome, dispatchRequest, toolArguments, toolUrl } from "./dispatch";

function tool(method: string, path: string): AppTool {
  return {
    name: "notes_x",
    capability: "notes",
    operation: "x",
    method,
    path,
    summary: "X.",
    description: "X.",
    inputSchema: {},
    effect: method === "GET" ? null : "writes",
    annotations: { readOnlyHint: method === "GET", destructiveHint: false, openWorldHint: false },
    power: undefined,
    scopes: [],
  };
}

const auth = { userId: "u1", sessionId: "s1", scopes: [] };

describe("toolUrl", () => {
  test("fills each path parameter, encoded so a value cannot add a segment", () => {
    expect(toolUrl(tool("GET", "/notes/:id/tags/:tag{[a-z]+}"), { path: { id: "a/b", tag: "x" } })).toBe(
      "/notes/a%2Fb/tags/x",
    );
  });

  test("refuses a call missing a path parameter, naming it", () => {
    expect(() => toolUrl(tool("GET", "/notes/:id"), {})).toThrow(PithyError);
    expect(() => toolUrl(tool("GET", "/notes/:id"), {})).toThrow(/path\.id/);
  });

  test("writes the query, repeating a list", () => {
    expect(toolUrl(tool("GET", "/notes"), { query: { tag: ["a", "b"], limit: 5, skip: undefined } })).toBe(
      "/notes?tag=a&tag=b&limit=5",
    );
  });

  test("fills a trailing wildcard from path.path, segment by segment", () => {
    expect(toolUrl(tool("GET", "/files/*"), { path: { path: "a b/c" } })).toBe("/files/a%20b/c");
  });

  // `encodeURIComponent` leaves `.` alone, and the URL parser collapses a dot segment, so either would carry the
  // call to a route that never declared itself a tool.
  test("refuses a path parameter that is a dot segment", () => {
    for (const value of ["..", "."]) {
      expect(() => toolUrl(tool("GET", "/leaderboards/:board/rank"), { path: { board: value } }), value).toThrow(
        PithyError,
      );
    }
  });

  test("refuses a path parameter that is empty", () => {
    expect(() => toolUrl(tool("GET", "/notes/:id"), { path: { id: "" } })).toThrow(/path\.id/);
  });

  test("refuses a wildcard holding a dot segment anywhere in it", () => {
    for (const value of ["..", "a/../../admin", "./x", "a/."]) {
      expect(() => toolUrl(tool("GET", "/files/*"), { path: { path: value } }), value).toThrow(PithyError);
    }
  });

  test("keeps a value that only contains dots among other characters", () => {
    expect(toolUrl(tool("GET", "/notes/:id"), { path: { id: "a..b" } })).toBe("/notes/a..b");
    expect(toolUrl(tool("GET", "/notes/:id"), { path: { id: "..." } })).toBe("/notes/...");
  });
});

describe("toolArguments", () => {
  test("splits the three parts back out and drops anything else", () => {
    expect(toolArguments({ path: { id: "1" }, query: { a: "b" }, body: { x: 1 }, extra: true })).toEqual({
      path: { id: "1" },
      query: { a: "b" },
      body: { x: 1 },
    });
    expect(toolArguments({ path: "nope" })).toEqual({});
  });
});

describe("dispatchRequest", () => {
  test("builds the route's own request, with a JSON body for a write", async () => {
    const request = dispatchRequest("https://app.test", tool("POST", "/notes"), { body: { text: "hi" } }, auth);
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://app.test/notes");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(await request.json()).toEqual({ text: "hi" });
  });

  test("carries no credential on the wire, and the identity beside it in process", () => {
    const request = dispatchRequest("https://app.test", tool("GET", "/notes"), {}, auth);
    expect(request.headers.has("authorization")).toBe(false);
    expect(request.headers.has("cookie")).toBe(false);
    expect(dispatchedAuth(request)).toBe(auth);
  });

  test("a request that arrived over the network has no dispatched identity, whatever it carries", () => {
    const forged = new Request("https://app.test/notes", { headers: { "x-pithy-dispatched": "u1" } });
    expect(dispatchedAuth(forged)).toBeUndefined();
  });

  test("refuses a call whose URL would resolve to a path other than the one built for the tool", () => {
    expect(() =>
      dispatchRequest("https://app.test", tool("GET", "/support/threads/:id/reply"), { path: { id: ".." } }, auth),
    ).toThrow(PithyError);
  });

  test("carries the correlation it is handed, so the route's own rows share the tool call's request id", () => {
    const request = dispatchRequest("https://app.test", tool("GET", "/notes"), {}, auth, {
      "cf-ray": "ray-1",
      "cf-connecting-ip": "203.0.113.9",
      "user-agent": "agent/1.0",
    });
    expect(request.headers.get("cf-ray")).toBe("ray-1");
    expect(request.headers.get("cf-connecting-ip")).toBe("203.0.113.9");
    expect(request.headers.get("user-agent")).toBe("agent/1.0");
  });

  test("a GET sends no body even when one was passed", () => {
    const request = dispatchRequest("https://app.test", tool("GET", "/notes"), { body: { x: 1 } }, auth);
    expect(request.body).toBeNull();
  });
});

describe("dispatchedOutcome", () => {
  test("parses a JSON body and keeps any other as text", async () => {
    expect(await dispatchedOutcome(Response.json({ ok: true }, { status: 201 }))).toMatchObject({
      status: 201,
      body: { ok: true },
    });
    expect(await dispatchedOutcome(new Response("plain", { status: 200 }))).toMatchObject({
      status: 200,
      body: "plain",
    });
  });

  test("measures the route's response in bytes, not characters", async () => {
    expect((await dispatchedOutcome(new Response("héllo", { status: 200 }))).bytes).toBe(6);
    expect((await dispatchedOutcome(new Response(null, { status: 204 }))).bytes).toBe(0);
  });
});

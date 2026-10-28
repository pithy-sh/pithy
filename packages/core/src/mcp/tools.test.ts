// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { PithyError } from "../error/pithyError";
import { describeRoute, type RouteSpec } from "../http/routeSpec";
import { validate } from "../http/validation";
import type { RouteGroup } from "../openapi/document";
import { appTools, assertToolDeclarations, offeredTools, toolAnnotations } from "./tools";

const Ok = z.object({ ok: z.boolean().describe("Always true.") }).describe("A plain answer.");
const base: RouteSpec = { summary: "Read a note.", verification: ["bearer", "session"], responses: { 200: Ok } };
const NoteParam = z.object({ id: z.string().describe("The note's id.") }).describe("Which note.");
const NoteBody = z.object({ text: z.string().describe("What the note says.") }).describe("A note.");

/** One capability's routes, registered on a fresh app, as `createBackend` records them. */
function group(tag: string, register: (app: Hono) => void): RouteGroup {
  const app = new Hono();
  register(app);
  return { tag, routes: app.routes };
}

const notes = group("notes", (app) => {
  app.get(
    "/notes/:id",
    describeRoute({ ...base, operation: "notes.read", tool: true, power: "notes:read" }),
    validate("param", NoteParam),
    (c) => c.json({ ok: true }),
  );
  app.post(
    "/notes",
    describeRoute({
      ...base,
      summary: "Write a note.",
      description: "Replaces nothing.",
      operation: "notes.write",
      tool: { effect: "writes" },
    }),
    validate("json", NoteBody),
    (c) => c.json({ ok: true }),
  );
  app.delete(
    "/notes/:id",
    describeRoute({ ...base, summary: "Delete a note.", operation: "notes.delete", tool: { effect: "deletes" } }),
    validate("param", NoteParam),
    (c) => c.json({ ok: true }),
  );
  // Declared, described, and not a tool: it never said so.
  app.get("/notes", describeRoute({ ...base, summary: "List notes.", operation: "notes.list" }), (c) =>
    c.json({ ok: true }),
  );
  app.get(
    "/notes/attested",
    describeRoute({ ...base, operation: "notes.attested", tool: true, scopes: ["notes:backend"] }),
    (c) => c.json({ ok: true }),
  );
});

function refusal(groups: readonly RouteGroup[]): string {
  try {
    assertToolDeclarations(groups);
  } catch (error) {
    if (error instanceof PithyError) return `${error.message} ${error.payload.detail ?? ""}`;
    throw error;
  }
  return "";
}

describe("appTools", () => {
  const tools = appTools([notes]);

  test("a route is a tool only when it declares itself one", () => {
    expect(tools.map((tool) => tool.name)).toEqual([
      "notes_notes_read",
      "notes_notes_write",
      "notes_notes_delete",
      "notes_notes_attested",
    ]);
  });

  test("names it <capability>_<operation> through the control-plane normalizer", () => {
    const tool = tools.find((entry) => entry.operation === "notes.read");
    expect(tool?.name).toBe("notes_notes_read");
    expect(tool?.capability).toBe("notes");
  });

  test("takes its input from the route's own validators, in the control-plane shape", () => {
    const write = tools.find((tool) => tool.operation === "notes.write");
    expect(write?.inputSchema).toMatchObject({
      type: "object",
      properties: { body: { properties: { text: { type: "string", description: "What the note says." } } } },
      required: ["body"],
      additionalProperties: false,
    });
    const read = tools.find((tool) => tool.operation === "notes.read");
    expect(read?.inputSchema).toMatchObject({ required: ["path"] });
  });

  test("describes it in the route's own words, with its effect said aloud", () => {
    const write = tools.find((tool) => tool.operation === "notes.write");
    expect(write?.summary).toBe("Write a note.");
    expect(write?.description).toContain("Write a note.");
    expect(write?.description).toContain("Replaces nothing.");
    expect(write?.description).toContain("Changes data");
    const read = tools.find((tool) => tool.operation === "notes.read");
    expect(read?.description).toBe("Read a note.");
  });

  test("carries the route's power and required scopes, read off the same declaration", () => {
    expect(tools.find((tool) => tool.operation === "notes.read")?.power).toBe("notes:read");
    expect(tools.find((tool) => tool.operation === "notes.write")?.power).toBeUndefined();
    expect(tools.find((tool) => tool.operation === "notes.attested")?.scopes).toEqual(["notes:backend"]);
  });

  test("keeps the method and the mounted path, which is what a call dispatches to", () => {
    expect(tools.find((tool) => tool.operation === "notes.delete")).toMatchObject({
      method: "DELETE",
      path: "/notes/:id",
      effect: "deletes",
    });
  });
});

describe("toolAnnotations", () => {
  test("a read is read-only and not destructive", () => {
    expect(toolAnnotations(null)).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
  });

  test("a write is neither read-only nor destructive", () => {
    expect(toolAnnotations("writes")).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
  });

  test("sending reaches outside the application", () => {
    expect(toolAnnotations("sends")).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
  });

  test("charging and deleting are destructive", () => {
    expect(toolAnnotations("charges")).toEqual({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    expect(toolAnnotations("deletes")).toEqual({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
  });
});

describe("assertToolDeclarations", () => {
  test("accepts the kit's own shapes", () => {
    expect(refusal([notes])).toBe("");
  });

  test("refuses a non-GET route that opts in without an effect", () => {
    const loose = group("notes", (app) => {
      app.post("/notes", describeRoute({ ...base, operation: "notes.write", tool: true }), (c) => c.json({ ok: true }));
    });
    expect(refusal([loose])).toContain("POST /notes");
    expect(refusal([loose])).toContain("effect");
  });

  test("refuses a GET route that declares an effect, because a read has none", () => {
    const odd = group("notes", (app) => {
      app.get("/notes", describeRoute({ ...base, operation: "notes.list", tool: { effect: "writes" } }), (c) =>
        c.json({ ok: true }),
      );
    });
    expect(refusal([odd])).toContain("GET /notes");
  });

  test("refuses a tool with no operation, because its name would have nothing to come from", () => {
    const nameless = group("notes", (app) => {
      app.get("/notes", describeRoute({ ...base, tool: true }), (c) => c.json({ ok: true }));
    });
    expect(refusal([nameless])).toContain("operation");
  });

  test("refuses two routes sharing an operation within one capability", () => {
    const twice = group("notes", (app) => {
      app.get("/a", describeRoute({ ...base, operation: "notes.read", tool: true }), (c) => c.json({ ok: true }));
      app.get("/b", describeRoute({ ...base, operation: "notes.read" }), (c) => c.json({ ok: true }));
    });
    expect(refusal([twice])).toContain("notes.read");
  });

  test("lets two capabilities use one operation, because the capability is in the name", () => {
    const other = group("drafts", (app) => {
      app.get("/drafts/:id", describeRoute({ ...base, operation: "notes.read", tool: true }), (c) =>
        c.json({ ok: true }),
      );
    });
    expect(refusal([notes, other])).toBe("");
  });

  test("refuses an operation outside the published alphabet", () => {
    const shouty = group("notes", (app) => {
      app.get("/notes", describeRoute({ ...base, operation: "Notes Read", tool: true }), (c) => c.json({ ok: true }));
    });
    expect(refusal([shouty])).toContain("Notes Read");
  });

  test("refuses two capabilities whose names normalize to one tool", () => {
    const a = group("a-b", (app) => {
      app.get("/x", describeRoute({ ...base, operation: "c", tool: true }), (c) => c.json({ ok: true }));
    });
    const b = group("a", (app) => {
      app.get("/y", describeRoute({ ...base, operation: "b-c", tool: true }), (c) => c.json({ ok: true }));
    });
    // `a-b_c` and `a_b-c` stay distinct; only a true collision is refused.
    expect(refusal([a, b])).toBe("");
    const c = group("a", (app) => {
      app.get("/z", describeRoute({ ...base, operation: "b_c", tool: true }), (ctx) => ctx.json({ ok: true }));
    });
    const d = group("a_b", (app) => {
      app.get("/w", describeRoute({ ...base, operation: "c", tool: true }), (ctx) => ctx.json({ ok: true }));
    });
    expect(refusal([c, d])).toContain("a_b_c");
  });
});

describe("offeredTools", () => {
  const tools = appTools([notes]);
  const names = (held: readonly string[] | null, scopes: readonly string[] = []) =>
    offeredTools(tools, {
      roleAllows: held === null ? null : (power) => held.includes(power),
      scopes,
    }).map((tool) => tool.operation);

  test("a withheld tool is absent, not locked", () => {
    expect(names([])).toEqual(["notes.write", "notes.delete"]);
    expect(names(["notes:read"])).toEqual(["notes.read", "notes.write", "notes.delete"]);
  });

  test("with no organization in force, a tool behind a power is absent", () => {
    expect(names(null)).toEqual(["notes.write", "notes.delete"]);
  });

  test("a tool needing an attestation the caller lacks is absent", () => {
    expect(names(["notes:read"], ["notes:backend"])).toContain("notes.attested");
    expect(names(["notes:read"])).not.toContain("notes.attested");
  });
});

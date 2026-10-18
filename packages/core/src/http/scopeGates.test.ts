// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { PithyHonoEnv } from "../capability/capability";
import { describeRoute } from "./routeSpec";
import { scopeGatesOf } from "./scopeGates";

const Ok = z.object({ ok: z.boolean().describe("Always true.") }).describe("A probe answer.");

/** A registrar with one route of every shape the walk has to tell apart. */
function register(app: Hono<PithyHonoEnv>): void {
  app.post(
    "/board/:board",
    describeRoute({
      summary: "Submit.",
      verification: ["bearer", "session"],
      scopes: ["board:submit"],
      responses: { 201: Ok },
    }),
    (c) => c.json({ ok: true }, 201),
  );
  app.get(
    "/board/:board",
    describeRoute({ summary: "Read.", verification: ["bearer", "session"], responses: { 200: Ok } }),
    (c) => c.json({ ok: true }),
  );
  app.get(
    "/board/admin/all",
    describeRoute({
      summary: "Manage.",
      verification: "control-plane",
      scopes: ["board:read"],
      responses: { 200: Ok },
    }),
    (c) => c.json({ ok: true }),
  );
  app.delete(
    "/board/:board/entries/:userId",
    describeRoute({
      summary: "Remove.",
      verification: "bearer",
      scopes: ["board:admin", "board:audit"],
      responses: { 200: Ok },
    }),
    (c) => c.json({ ok: true }),
  );
}

describe("scopeGatesOf", () => {
  test("names every bearer or session route that requires an AuthContext scope, one entry per scope", () => {
    expect(scopeGatesOf(register)).toEqual([
      { scope: "board:submit", route: "POST /board/:board" },
      { scope: "board:admin", route: "DELETE /board/:board/entries/:userId" },
      { scope: "board:audit", route: "DELETE /board/:board/entries/:userId" },
    ]);
  });

  test("leaves out a control-plane scope, which is a different credential and never reads AuthContext", () => {
    expect(scopeGatesOf(register).map((gate) => gate.scope)).not.toContain("board:read");
  });

  test("declares nothing for a registrar with no scoped route", () => {
    expect(scopeGatesOf((app) => app.get("/x", (c) => c.text("x")))).toEqual([]);
  });
});

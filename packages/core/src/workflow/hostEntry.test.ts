// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { PublicErrorPayload } from "../error/payload";
import { workflowHostEntry } from "./hostEntry";

/**
 * The refusal a Workflow host answers HTTP with.
 *
 * Two things are being asserted, and only one of them is the status. The other is that the body is a public
 * payload — `action` names the Workflow binding an operator should be using, and an action on the wire is
 * the boundary breach `clientError` exists to prevent (CLAUDE.md §Errors).
 */
describe("a workflow host with no HTTP surface", () => {
  test("refuses with 404 and names the capability that answered", async () => {
    const response = await workflowHostEntry("support").fetch();
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/json");

    const body = (await response.json()) as { error: unknown };
    const payload = PublicErrorPayload.parse(body.error);
    expect(payload).toEqual({
      code: "core/not_found",
      status: 404,
      message: "The support workflow host serves no HTTP requests.",
    });
  });

  test("carries no action and no detail — the same boundary every other transport crosses", async () => {
    const response = await workflowHostEntry("vector").fetch();
    const body = (await response.json()) as { error: Record<string, unknown> };
    // Asserted by absence rather than by the parse above: `PublicErrorPayload` would strip an unknown key
    // silently, so a leak would survive a green `.parse` and fail only here.
    expect(Object.keys(body.error).sort()).toEqual(["code", "message", "status"]);
  });
});

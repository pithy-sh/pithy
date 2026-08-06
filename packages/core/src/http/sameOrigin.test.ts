// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import type { PithyHonoEnv } from "../capability/capability";
import { pithyErrorHandler } from "../error/http";
import { requireSameOrigin, type SameOriginGate } from "./sameOrigin";

/** An app whose only route is the gate, with `gate` published on every request (or nothing published). */
function app(gate: SameOriginGate | null) {
  const a = new Hono<PithyHonoEnv>();
  a.onError(pithyErrorHandler);
  a.use("*", async (c, next) => {
    c.set("sameOrigin", gate);
    await next();
  });
  a.post("/x", requireSameOrigin(), (c) => c.text("ok"));
  return a;
}

/** A gate that admits one origin — standing in for the one a capability binds from its own config. */
const admits =
  (origin: string): SameOriginGate =>
  async (c, next) => {
    if (c.req.raw.headers.get("origin") !== origin) return c.text("refused", 403);
    await next();
  };

describe("requireSameOrigin", () => {
  test("takes no argument — there is no origin list a caller could supply", () => {
    expect(requireSameOrigin.length).toBe(0);
  });

  test("runs the published gate", async () => {
    const allowed = await app(admits("https://app.example.com")).request("/x", {
      method: "POST",
      headers: { origin: "https://app.example.com" },
    });
    expect(allowed.status).toBe(200);

    const refused = await app(admits("https://app.example.com")).request("/x", {
      method: "POST",
      headers: { origin: "https://evil.example.com" },
    });
    expect(refused.status).toBe(403);
  });

  // The same rule the entitlement seam follows: a gate that arrives with a capability must deny when
  // that capability is absent, or the route stands open exactly where its protection is missing.
  test("denies when no capability published a policy", async () => {
    const response = await app(null).request("/x", { method: "POST", headers: { origin: "https://app.example.com" } });
    expect(response.status).toBe(403);
    const body = await response.json<{ error: { code: string; detail?: string } }>();
    expect(body.error.code).toBe("auth/forbidden");
    // The reason an operator needs is in `detail`, which the HTTP codec strips before it ships.
    expect(body.error.detail).toBeUndefined();
  });
});

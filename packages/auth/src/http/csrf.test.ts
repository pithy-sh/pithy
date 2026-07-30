// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { allowedOrigins, requireSameOrigin } from "./csrf";

const ORIGINS = allowedOrigins("https://api.example.com", ["https://app.example.com", "myapp://"]);

function app() {
  const a = new Hono<PithyHonoEnv>();
  a.onError(pithyErrorHandler);
  a.post("/x", requireSameOrigin(ORIGINS), (c) => c.text("ok"));
  return a;
}

describe("requireSameOrigin", () => {
  test("allowedOrigins includes the baseURL origin and every trusted origin", () => {
    expect(ORIGINS).toContain("https://api.example.com");
    expect(ORIGINS).toContain("https://app.example.com");
  });

  test("a bearer request is CSRF-exempt regardless of origin", async () => {
    const res = await app().request("/x", {
      method: "POST",
      headers: { authorization: "Bearer t", origin: "https://evil.example.com" },
    });
    expect(res.status).toBe(200);
  });

  test("a cookie request from an allowed origin passes", async () => {
    const res = await app().request("/x", {
      method: "POST",
      headers: { cookie: "session=t", origin: "https://app.example.com" },
    });
    expect(res.status).toBe(200);
  });

  test("a cookie request from a foreign origin is rejected (403)", async () => {
    const res = await app().request("/x", {
      method: "POST",
      headers: { cookie: "session=t", origin: "https://evil.example.com" },
    });
    expect(res.status).toBe(403);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("auth/forbidden");
  });

  test("a cookie request with no Origin (and no Referer) is rejected", async () => {
    const res = await app().request("/x", { method: "POST", headers: { cookie: "session=t" } });
    expect(res.status).toBe(403);
  });

  test("falls back to the Referer origin when Origin is absent", async () => {
    const res = await app().request("/x", {
      method: "POST",
      headers: { cookie: "session=t", referer: "https://app.example.com/account" },
    });
    expect(res.status).toBe(200);
  });
});

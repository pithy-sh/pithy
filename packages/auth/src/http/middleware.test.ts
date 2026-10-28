// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { noteRefusal } from "../lifecycle/enforce";
import { lifecycleRefusal } from "../lifecycle/state";
import { accountHolder, carriesCredential, requireAccountHolder } from "./middleware";

/**
 * The one gate a suspended account passes (#622): deleting its own account. Every other route keeps
 * `requireAuth()`, which refuses it.
 */

type Seed = "signed-in" | "suspended" | "deleted" | "anonymous";

function app(seed: Seed) {
  const hono = new Hono<PithyHonoEnv>();
  hono.onError(pithyErrorHandler);
  hono.use("*", async (c, next) => {
    c.set("auth", null);
    if (seed === "signed-in") {
      c.set("auth", { userId: "u1", sessionId: "s1", scopes: [], locale: null, authenticatedAt: null });
    }
    const standing =
      seed === "suspended"
        ? ({ state: "suspended", until: null } as const)
        : seed === "deleted"
          ? ({ state: "deleted", purgeAfter: null } as const)
          : null;
    const refusal = standing ? lifecycleRefusal("u1", standing, null) : null;
    if (refusal) noteRefusal(c, refusal, { userId: "u1", sessionId: "s1" });
    await next();
  });
  hono.delete("/account", requireAccountHolder(), (c) => c.json(accountHolder(c)));
  return hono;
}

describe("requireAccountHolder and accountHolder", () => {
  test("a signed-in account is its own holder", async () => {
    const res = await app("signed-in").request("/account", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "u1", sessionId: "s1", suspended: false });
  });

  test("a suspended account's genuine credential is admitted, and says it is suspended", async () => {
    const res = await app("suspended").request("/account", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "u1", sessionId: "s1", suspended: true });
  });

  test("a deleted account is refused with its code", async () => {
    const res = await app("deleted").request("/account", { method: "DELETE" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("auth/account_deleted");
  });

  test("no credential is a 401", async () => {
    const res = await app("anonymous").request("/account", { method: "DELETE" });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("auth/invalid_token");
  });
});

describe("carriesCredential", () => {
  test.each([
    [{ authorization: "Bearer t" }, true],
    [{ cookie: "s=1" }, true],
    [{ "x-api-key": "k" }, true],
    [{ "x-other": "k" }, false],
    [{}, false],
  ])("%o is %s", (headers, expected) => {
    expect(carriesCredential(new Headers(headers))).toBe(expected);
  });
});

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { type EntitlementResolver, noEntitlementProvider } from "@pithy-sh/core/src/entitlement/entitlement";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { StorageConfig } from "../config/config";
import { storageCeiling } from "./ceiling";

const configured = StorageConfig.parse({ quota: { bytesPerOwner: 100 } });

async function ceilingWith(resolver: EntitlementResolver): Promise<number | null | string> {
  const app = new Hono<PithyHonoEnv>();
  let answer: number | null | string = "unset";
  app.use("*", async (c, next) => {
    c.set("entitlements", resolver);
    c.set("log", noopLogger);
    await next();
  });
  app.get("/", async (c) => {
    try {
      answer = await storageCeiling(c, configured);
    } catch (error) {
      answer = error instanceof PithyError ? error.payload.code : "thrown";
    }
    return c.body(null, 204);
  });
  await app.request("/");
  return answer;
}

const enforced = (limit: number | null): EntitlementResolver => ({
  provider: "payments",
  list: async () => [],
  meterLimit: async () => ({ enforced: true, limit }),
});

describe("storageCeiling", () => {
  test("with no entitlement provider, the configured bytesPerOwner — unchanged", async () => {
    expect(await ceilingWith(noEntitlementProvider)).toBe(100);
  });

  test("an advisory storageBytes meter leaves the configured number in force", async () => {
    expect(
      await ceilingWith({ provider: "payments", list: async () => [], meterLimit: async () => ({ enforced: false }) }),
    ).toBe(100);
  });

  test("an enforced meter makes the caller's effective quota the ceiling", async () => {
    expect(await ceilingWith(enforced(5000))).toBe(5000);
  });

  test("an unrestricted subject is unlimited, whatever bytesPerOwner says", async () => {
    expect(await ceilingWith(enforced(null))).toBeNull();
  });

  test("a provider whose read fails refuses, rather than serving unbounded", async () => {
    expect(
      await ceilingWith({
        provider: "payments",
        list: async () => [],
        meterLimit: async () => {
          throw new Error("D1 is down");
        },
      }),
    ).toBe("core/internal");
  });
});

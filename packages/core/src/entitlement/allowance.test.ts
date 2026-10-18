// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Context, Hono } from "hono";
import { describe, expect, test } from "vitest";
import type { PithyHonoEnv } from "../capability/capability";
import { PithyError } from "../error/pithyError";
import { createLogger } from "../logger/logger";
import type { LogRecord } from "../logger/record";
import { feature, meterLimit, quota } from "./allowance";
import { type EntitlementResolver, noEntitlementProvider } from "./entitlement";

/** Run `read` inside a request whose resolver is `resolver`, and hand back what it answered or threw. */
async function within<T>(
  resolver: EntitlementResolver,
  read: (c: Context<PithyHonoEnv>) => Promise<T>,
  logs: LogRecord[] = [],
): Promise<{ value?: T; error?: PithyError }> {
  const app = new Hono<PithyHonoEnv>();
  let outcome: { value?: T; error?: PithyError } = {};
  app.use("*", async (c, next) => {
    c.set("entitlements", resolver);
    c.set("log", createLogger({ level: "debug", sink: (record) => logs.push(record) }));
    await next();
  });
  app.get("/", async (c) => {
    try {
      outcome = { value: await read(c) };
    } catch (error) {
      if (!(error instanceof PithyError)) throw error;
      outcome = { error };
    }
    return c.body(null, 204);
  });
  await app.request("/");
  return outcome;
}

const allowances: EntitlementResolver = {
  provider: "payments",
  list: async () => [],
  quota: async (name) => (name === "seats" ? 10 : null),
  feature: async (name) => name === "sso",
  meterLimit: async (meter) => (meter === "storageBytes" ? { enforced: true, limit: 1024 } : { enforced: false }),
};

describe("quota and feature", () => {
  test("read through the provider, with no key argument", async () => {
    expect((await within(allowances, (c) => quota(c, "seats"))).value).toBe(10);
    expect((await within(allowances, (c) => quota(c, "emails"))).value).toBeNull();
    expect((await within(allowances, (c) => feature(c, "sso"))).value).toBe(true);
    expect((await within(allowances, (c) => feature(c, "auditExport"))).value).toBe(false);
  });

  test("with no provider composed both refuse with core/internal — never 0, never unlimited", async () => {
    const read = await within(noEntitlementProvider, (c) => quota(c, "seats"));
    expect(read.value).toBeUndefined();
    expect(read.error?.payload.code).toBe("core/internal");
    expect(read.error?.payload.detail).toContain("no entitlement provider is composed");
    expect((await within(noEntitlementProvider, (c) => feature(c, "sso"))).error?.payload.code).toBe("core/internal");
  });

  test("a provider that declares no allowances refuses the same way, and says it is composed", async () => {
    const keysOnly: EntitlementResolver = { provider: "payments", list: async () => [] };
    expect((await within(keysOnly, (c) => quota(c, "seats"))).error?.payload.detail).toContain(
      "payments resolves entitlements and declares no allowances",
    );
  });
});

describe("meterLimit", () => {
  test("answers the provider's ceiling for a meter it binds", async () => {
    expect((await within(allowances, (c) => meterLimit(c, "storageBytes"))).value).toEqual({
      enforced: true,
      limit: 1024,
    });
    expect((await within(allowances, (c) => meterLimit(c, "mediaItems"))).value).toEqual({ enforced: false });
  });

  test("no provider is unenforced, so a capability keeps its own configured ceiling", async () => {
    expect((await within(noEntitlementProvider, (c) => meterLimit(c, "storageBytes"))).value).toEqual({
      enforced: false,
    });
  });

  test("a provider that throws refuses and logs — a failed read is never an unbounded allowance", async () => {
    const logs: LogRecord[] = [];
    const broken: EntitlementResolver = {
      provider: "payments",
      list: async () => [],
      meterLimit: async () => {
        throw new Error("D1 is down");
      },
    };
    const read = await within(broken, (c) => meterLimit(c, "storageBytes"), logs);
    expect(read.error?.payload.code).toBe("core/internal");
    expect(logs.some((record) => record.msg === "meter limit resolution failed")).toBe(true);
  });
});

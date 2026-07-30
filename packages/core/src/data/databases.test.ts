// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { defineCapability } from "../capability/capability";
import { PithyError } from "../error/pithyError";
import { composeDatabases } from "./databases";

const User = z.object({ id: z.number().describe("PK."), email: z.string().describe("Email.") }).describe("A user.");
const Post = z.object({ id: z.number().describe("PK."), title: z.string().describe("Title.") }).describe("A post.");
const Event = z.object({ id: z.number().describe("PK."), kind: z.string().describe("Kind.") }).describe("An event.");

const authCap = defineCapability({
  name: "auth",
  requiredBindings: [],
  databases: { app: { binding: "APP_DB", tables: { auth_users: User } } },
});
const blogCap = defineCapability({
  name: "blog",
  requiredBindings: [],
  databases: { app: { binding: "APP_DB", tables: { blog_posts: Post } } },
});
const analyticsCap = defineCapability({
  name: "analytics",
  requiredBindings: [],
  databases: { metrics: { binding: "ANALYTICS_DB", tables: { events: Event } } },
});

describe("composeDatabases", () => {
  test("merges tables for the same database across capabilities", () => {
    const merged = composeDatabases([authCap, blogCap]);
    expect(Object.keys(merged)).toEqual(["app"]);
    expect(merged.app?.binding).toBe("APP_DB");
    expect(Object.keys(merged.app?.items ?? {}).sort()).toEqual(["auth_users", "blog_posts"]);
  });

  test("keeps distinct databases separate, each with its own binding", () => {
    const merged = composeDatabases([authCap, analyticsCap]);
    expect(Object.keys(merged).sort()).toEqual(["app", "metrics"]);
    expect(merged.app?.binding).toBe("APP_DB");
    expect(merged.metrics?.binding).toBe("ANALYTICS_DB");
    expect(Object.keys(merged.metrics?.items ?? {})).toEqual(["events"]);
  });

  test("ignores capabilities that declare no databases", () => {
    const audit = defineCapability({ name: "audit", requiredBindings: [] });
    expect(composeDatabases([audit, authCap])).toHaveProperty("app");
    expect(Object.keys(composeDatabases([audit, authCap]))).toEqual(["app"]);
  });

  test("throws when one database name is bound to two different bindings", () => {
    const conflicting = defineCapability({
      name: "conflicting",
      requiredBindings: [],
      databases: { app: { binding: "OTHER_DB", tables: {} } },
    });
    try {
      composeDatabases([authCap, conflicting]);
      throw new Error("expected composeDatabases to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PithyError);
      expect((err as PithyError).payload.code).toBe("core/internal");
      expect((err as PithyError).message).toMatch(/app/);
      expect((err as PithyError).message).toMatch(/APP_DB/);
      expect((err as PithyError).message).toMatch(/OTHER_DB/);
    }
  });

  test("throws when two capabilities declare the same table in one database", () => {
    const dupe = defineCapability({
      name: "dupe",
      requiredBindings: [],
      databases: { app: { binding: "APP_DB", tables: { auth_users: Post } } },
    });
    try {
      composeDatabases([authCap, dupe]);
      throw new Error("expected composeDatabases to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PithyError);
      expect((err as PithyError).message).toMatch(/auth_users/);
      expect((err as PithyError).message).toMatch(/app/);
      expect((err as PithyError).message).toMatch(/"auth"/);
      expect((err as PithyError).message).toMatch(/"dupe"/);
    }
  });
});

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { defineCapability } from "../capability/capability";
import { PithyError } from "../error/pithyError";
import { composeKv, type KvStoreSpec } from "./namespaces";

const Session = z
  .object({ userId: z.string().describe("Owner."), createdAt: z.number().describe("ms-epoch.") })
  .describe("A session value.");
const SessionKey = z.object({ sessionId: z.string().describe("Session id.") }).describe("Session key.");
const Page = z.object({ html: z.string().describe("HTML.") }).describe("A cached page.");
const PageKey = z.object({ slug: z.string().describe("Slug.") }).describe("Page key.");

const sessions: KvStoreSpec = { prefix: "session", key: SessionKey, value: Session };
const refresh: KvStoreSpec = { prefix: "refresh", key: SessionKey, value: Session };
const pages: KvStoreSpec = { prefix: "page", key: PageKey, value: Page };

const authCap = defineCapability({
  name: "auth",
  requiredBindings: [],
  kvNamespaces: { auth: { binding: "SESSIONS", stores: { sessions } } },
});
const authExtra = defineCapability({
  name: "authExtra",
  requiredBindings: [],
  kvNamespaces: { auth: { binding: "SESSIONS", stores: { refresh } } },
});
const cmsCap = defineCapability({
  name: "cms",
  requiredBindings: [],
  kvNamespaces: { cms: { binding: "CACHE", stores: { pages } } },
});

describe("composeKv", () => {
  test("merges stores for the same namespace across capabilities", () => {
    const merged = composeKv([authCap, authExtra]);
    expect(Object.keys(merged)).toEqual(["auth"]);
    expect(merged.auth?.binding).toBe("SESSIONS");
    expect(Object.keys(merged.auth?.items ?? {}).sort()).toEqual(["refresh", "sessions"]);
  });

  test("keeps distinct namespaces separate, each with its own binding", () => {
    const merged = composeKv([authCap, cmsCap]);
    expect(Object.keys(merged).sort()).toEqual(["auth", "cms"]);
    expect(merged.auth?.binding).toBe("SESSIONS");
    expect(merged.cms?.binding).toBe("CACHE");
    expect(Object.keys(merged.cms?.items ?? {})).toEqual(["pages"]);
  });

  test("ignores capabilities that declare no namespaces", () => {
    const audit = defineCapability({ name: "audit", requiredBindings: [] });
    expect(Object.keys(composeKv([audit, authCap]))).toEqual(["auth"]);
  });

  test("throws when one namespace name is bound to two different bindings", () => {
    const conflicting = defineCapability({
      name: "conflicting",
      requiredBindings: [],
      kvNamespaces: { auth: { binding: "OTHER", stores: { refresh } } },
    });
    try {
      composeKv([authCap, conflicting]);
      throw new Error("expected composeKv to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PithyError);
      expect((err as PithyError).payload.code).toBe("core/internal");
      expect((err as PithyError).message).toMatch(/auth/);
      expect((err as PithyError).message).toMatch(/SESSIONS/);
      expect((err as PithyError).message).toMatch(/OTHER/);
    }
  });

  test("throws when two capabilities declare the same store in one namespace", () => {
    const dupe = defineCapability({
      name: "dupe",
      requiredBindings: [],
      kvNamespaces: { auth: { binding: "SESSIONS", stores: { sessions: refresh } } },
    });
    try {
      composeKv([authCap, dupe]);
      throw new Error("expected composeKv to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PithyError);
      expect((err as PithyError).message).toMatch(/sessions/);
      expect((err as PithyError).message).toMatch(/auth/);
      expect((err as PithyError).message).toMatch(/"authExtra"|"dupe"/);
    }
  });
});

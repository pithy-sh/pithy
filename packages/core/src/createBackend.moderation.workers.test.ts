// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { defineCapability } from "./capability/capability";
import { createBackend } from "./createBackend";
import type { ModerationContext, TextModerator } from "./moderation/moderator";

/** An app with one route that checks the `text` query value as `context` and answers the verdict. */
function probe() {
  return defineCapability({
    name: "app",
    requiredBindings: [],
    routes: (a) => {
      a.get("/check/:context/:text", async (c) => {
        const verdict = await c.var.moderator.check(
          decodeURIComponent(c.req.param("text")),
          c.req.param("context") as ModerationContext,
        );
        return c.json(verdict);
      });
    },
  });
}

async function check(app: ReturnType<typeof createBackend>, context: ModerationContext, text: string) {
  const res = await app.request(`/check/${context}/${encodeURIComponent(text)}`, {}, env);
  expect(res.status).toBe(200);
  return res.json();
}

describe("c.var.moderator", () => {
  test("is present with no moderation config, and checks the shipped list", async () => {
    const app = createBackend({ capabilities: [], app: probe() });
    expect(await check(app, "handle", "$h1t")).toEqual({ verdict: "reject", reason: "blocklist" });
    expect(await check(app, "handle", "as hit")).toEqual({ verdict: "allow" });
  });

  test("checks the words config adds", async () => {
    const app = createBackend({ capabilities: [], app: probe(), moderation: { words: ["crate"] } });
    expect(await check(app, "title", "The CRATE")).toEqual({ verdict: "reject", reason: "blocklist" });
  });

  test("is the moderator config supplies, and the context reaches it", async () => {
    const seen: ModerationContext[] = [];
    const own: TextModerator = {
      async check(_text, context) {
        seen.push(context);
        return { verdict: "review", reason: "classifier_unsure" };
      },
    };
    const app = createBackend({ capabilities: [], app: probe(), moderation: { moderator: own } });
    expect(await check(app, "free_text", "anything")).toEqual({ verdict: "review", reason: "classifier_unsure" });
    expect(seen).toEqual(["free_text"]);
  });

  test("answers review for a moderator that throws or never answers", async () => {
    const throws: TextModerator = {
      check: () => Promise.reject(new Error("binding missing")),
    };
    const hangs: TextModerator = { check: () => new Promise(() => {}) };
    const failing = createBackend({ capabilities: [], app: probe(), moderation: { moderator: throws } });
    const slow = createBackend({ capabilities: [], app: probe(), moderation: { moderator: hangs, timeoutMs: 10 } });
    expect(await check(failing, "title", "x")).toEqual({ verdict: "review", reason: "moderator_failed" });
    expect(await check(slow, "title", "x")).toEqual({ verdict: "review", reason: "moderator_timeout" });
  });

  test("a moderation block that does not parse refuses to assemble", () => {
    expect(() => createBackend({ capabilities: [], moderation: { words: ["*"] } })).toThrow(/moderation block/);
  });
});

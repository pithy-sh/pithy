// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { CONSENT_VISITOR_COOKIE } from "../config/config";
import { readVisitor } from "./visitor";

/**
 * The device-id cookie is client-controlled and picks the subject consent is written against, and the subject a
 * sign-in merges into an account. Only a UUID, as this capability mints them, is ever read as a visitor.
 */

const UUID = "6f1d2e40-7b3a-4c9e-8d51-2a4b6c8e0f13";

async function read(cookie: string | null): Promise<string | null> {
  const app = new Hono<PithyHonoEnv>();
  app.get("/", (c) => c.json({ visitor: readVisitor(c) }));
  const headers: Record<string, string> = cookie === null ? {} : { cookie: `${CONSENT_VISITOR_COOKIE}=${cookie}` };
  const body = (await (await app.request("https://acme.example/", { headers })).json()) as { visitor: string | null };
  return body.visitor;
}

describe("readVisitor", () => {
  test("reads a device id this capability minted", async () => {
    expect(await read(UUID)).toBe(UUID);
  });

  test("ignores no cookie, an empty one, and anything that is not a lowercase UUID", async () => {
    for (const value of [null, "", "not-a-uuid", "account:ada", UUID.toUpperCase(), `${UUID}x`, "a".repeat(4096)]) {
      expect(await read(value), String(value)).toBeNull();
    }
  });
});

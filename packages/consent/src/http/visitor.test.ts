// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { CONSENT_VISITOR_HEADER } from "../client/api";
import { CONSENT_VISITOR_COOKIE } from "../config/config";
import { readVisitor, type Visitor } from "./visitor";

/**
 * The device-id cookie is client-controlled and picks the subject consent is written against, and the subject a
 * sign-in merges into an account. Only a UUID, as this capability mints them, is ever read as a visitor.
 *
 * A phone holds no cookie, so it sends the visitor id in a header of consent's own instead — held to the same shape,
 * and read only from a request that carries no cookie at all, so a header never stands in for a browser's cookie.
 * The device id auth registers is not secret, so it is never read as a visitor.
 */

const UUID = "6f1d2e40-7b3a-4c9e-8d51-2a4b6c8e0f13";
const DEVICE = "0b6e9a52-3c1d-4f7e-9a2b-5d8c1e4f6a70";

async function read(cookie: string | null, device: string | null = null, raw?: string): Promise<Visitor | null> {
  const app = new Hono<PithyHonoEnv>();
  app.get("/", (c) => c.json({ visitor: readVisitor(c) }));
  const headers: Record<string, string> = {};
  if (cookie !== null) headers.cookie = `${CONSENT_VISITOR_COOKIE}=${cookie}`;
  if (raw !== undefined) headers.cookie = raw;
  if (device !== null) headers[CONSENT_VISITOR_HEADER] = device;
  const body = (await (await app.request("https://acme.example/", { headers })).json()) as { visitor: Visitor | null };
  return body.visitor;
}

describe("readVisitor", () => {
  test("reads a device id this capability minted, from its cookie", async () => {
    expect(await read(UUID)).toEqual({ id: UUID, carriedBy: "cookie" });
  });

  test("ignores no cookie, an empty one, and anything that is not a lowercase UUID", async () => {
    for (const value of [null, "", "not-a-uuid", "account:ada", UUID.toUpperCase(), `${UUID}x`, "a".repeat(4096)]) {
      expect(await read(value), String(value)).toBeNull();
    }
  });

  test("reads the visitor header from a request that carries no cookie", async () => {
    expect(await read(null, DEVICE)).toEqual({ id: DEVICE, carriedBy: "device" });
  });

  test("never reads the device id auth registers, which anyone who can see a device listing knows", async () => {
    const app = new Hono<PithyHonoEnv>();
    app.get("/", (c) => c.json({ visitor: readVisitor(c) }));
    const response = await app.request("https://acme.example/", { headers: { "x-pithy-device-id": DEVICE } });
    expect(((await response.json()) as { visitor: Visitor | null }).visitor).toBeNull();
  });

  test("holds the visitor header to the cookie's shape", async () => {
    for (const value of ["", "device-1", DEVICE.toUpperCase(), `${DEVICE}x`, `${DEVICE},${DEVICE}`, "a".repeat(4096)]) {
      expect(await read(null, value), JSON.stringify(value)).toBeNull();
    }
  });

  test("never lets the header stand in for a cookie: the cookie wins, and any cookie shuts the header out", async () => {
    expect(await read(UUID, DEVICE)).toEqual({ id: UUID, carriedBy: "cookie" });
    expect(await read("not-a-uuid", DEVICE)).toBeNull();
    expect(await read(null, DEVICE, "locale=es")).toBeNull();
  });
});

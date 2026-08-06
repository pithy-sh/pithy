// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { PithyHonoEnv } from "../capability/capability";
import { pithyErrorHandler } from "../error/http";
import { PithyError } from "../error/pithyError";
import { requireSignedWebhook, verifySignedWebhook } from "./signedWebhook";
import { validationHook } from "./validation";

/**
 * The same gate, inside workerd.
 *
 * `signedWebhook.test.ts` states the scheme case by case in node. This file exists because none of what the
 * scheme rests on is ours: `crypto.subtle` is the platform's, and workerd's is a different implementation from
 * Node's — it is the one that rejects a zero-length HMAC key with its own message, and the one that decides
 * whether a signature verifies in production. Hono's body cache is the other half: the gate reads the bytes
 * with `c.req.text()` and the route's json validator must be served the same ones, and "must" there is a
 * property of a runtime's `Request`, not of this package.
 *
 * So this is deliberately thin — the happy path end to end, a forgery, and the misconfiguration — and its job
 * is to fail if the runtime ever disagrees with node about any of them. No D1 and no KV: this path touches
 * neither, and a binding it does not use would only make the file look like it did.
 */

const SECRET = "whsec_a_secret_nobody_should_ever_read_back";
const HEADER = "x-pithy-signature";
const NOW = new Date("2026-08-05T12:00:00.000Z");
const BODY = '{"event":"invoice.paid","amount":1200}';

/** The sender's side of the scheme: HMAC-SHA256 over `<timestamp>.<body>`, hex. */
async function header(body: string, at: Date, secret = SECRET): Promise<string> {
  const timestamp = Math.floor(at.getTime() / 1000);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret) as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`) as unknown as ArrayBuffer,
  );
  const hex = [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `t=${timestamp},v1=${hex}`;
}

const Delivery = z
  .object({
    event: z.string().describe("The event name the sender assigned."),
    amount: z.number().describe("Minor units."),
  })
  .describe("A test webhook body, validated after the guard has already read the same bytes.");

function guardedApp(overrides: Record<string, unknown> = {}) {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.post(
    "/hooks/inbound",
    requireSignedWebhook({ header: HEADER, secret: SECRET, now: () => NOW, ...overrides }),
    zValidator("json", Delivery, validationHook),
    (c) => c.json({ event: c.req.valid("json").event }),
  );
  return app;
}

describe("requireSignedWebhook — inside workerd", () => {
  test("a verified delivery reaches the handler, and the json validator sees identical bytes", async () => {
    const response = await guardedApp().request("/hooks/inbound", {
      method: "POST",
      headers: { [HEADER]: await header(BODY, NOW), "content-type": "application/json" },
      body: BODY,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ event: "invoice.paid" });
  });

  test("a delivery signed under another secret is refused 401, and the wire body carries no detail", async () => {
    const response = await guardedApp().request("/hooks/inbound", {
      method: "POST",
      headers: { [HEADER]: await header(BODY, NOW, "whsec_the_wrong_one"), "content-type": "application/json" },
      body: BODY,
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error.code).toBe("core/webhook_unverified");
    expect(body.error).not.toHaveProperty("detail");
  });

  test("a blank version in the rotation does not take the endpoint down here either", async () => {
    // workerd refuses a zero-length HMAC key in its own words. Whatever it calls one, it must not be what
    // leaves this Worker — and it must not decide the answer by which index the blank sat at.
    for (const secret of [
      ["", SECRET],
      [SECRET, ""],
    ]) {
      await expect(
        verifySignedWebhook(BODY, await header(BODY, NOW), { header: HEADER, secret, now: NOW }),
      ).resolves.toBeUndefined();
    }
  });

  test("an endpoint left with no usable secret is a PithyError, not a DOMException", async () => {
    const caught = await verifySignedWebhook(BODY, await header(BODY, NOW), {
      header: HEADER,
      secret: [""],
      now: NOW,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(PithyError);
    expect((caught as PithyError).payload.code).toBe("core/internal");
  });
});

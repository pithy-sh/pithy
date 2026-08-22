// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import type { PithyHonoEnv } from "../capability/capability";
import { pithyErrorHandler } from "../error/http";
import { PithyError } from "../error/pithyError";
import {
  checkSignedWebhook,
  parseSignedWebhookHeader,
  requireSignedWebhook,
  SIGNED_WEBHOOK_MAX_CANDIDATES,
  SIGNED_WEBHOOK_TOLERANCE_SECONDS,
  verifySignedWebhook,
} from "./signedWebhook";
import { validationHook } from "./validation";

const SECRET = "whsec_a_secret_nobody_should_ever_read_back";
const HEADER = "x-pithy-signature";
const NOW = new Date("2026-08-05T12:00:00.000Z");
const BODY = '{"event":"invoice.paid","amount":1200}';

/** Seconds since the epoch, the unit the header's `t` is written in. */
const epochSeconds = (at: Date): number => Math.floor(at.getTime() / 1000);

/** The sender's side of the scheme: HMAC-SHA256 over `<timestamp>.<body>`, hex. */
async function sign(secret: string, timestamp: number, body: string): Promise<string> {
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
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A well-formed delivery header for these bytes at this instant. */
async function header(body: string, at: Date, secret = SECRET): Promise<string> {
  const timestamp = epochSeconds(at);
  return `t=${timestamp},v1=${await sign(secret, timestamp, body)}`;
}

/** Seconds offset from {@link NOW}, as a Date. */
const at = (offsetSeconds: number): Date => new Date(NOW.getTime() + offsetSeconds * 1000);

/** Verify with the fixed clock and the defaults, so each case states only what it is about. */
const verify = (body: string, value: string | null, overrides: Record<string, unknown> = {}) =>
  verifySignedWebhook(body, value, { header: HEADER, secret: SECRET, now: NOW, ...overrides });

/** The payload of the `PithyError` a refusal throws, or a failure if it did not throw. */
async function refusal(promise: Promise<unknown>) {
  const caught = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(PithyError);
  return (caught as PithyError).payload;
}

describe("verifySignedWebhook — the timestamped-HMAC scheme", () => {
  test("verifies a delivery signed over these exact bytes", async () => {
    await expect(verify(BODY, await header(BODY, NOW))).resolves.toBeUndefined();
  });

  test("refuses a signature made over other bytes", async () => {
    const captured = await header(BODY, NOW);
    expect((await refusal(verify(`${BODY} `, captured))).code).toBe("core/webhook_unverified");
  });

  test("refuses a signature made under another secret", async () => {
    const captured = await header(BODY, NOW, "whsec_the_wrong_one");
    expect((await refusal(verify(BODY, captured))).code).toBe("core/webhook_unverified");
  });
});

describe("verifySignedWebhook — the timestamp is inside the signed payload", () => {
  test("re-dating a captured delivery invalidates its own signature", async () => {
    // A delivery captured an hour ago, outside any tolerance.
    const stale = await header(BODY, at(-3600));
    expect((await refusal(verify(BODY, stale))).code).toBe("core/webhook_unverified");

    // The only way out of the window is to re-date it — which changes the signed payload, so the
    // captured signature no longer matches. That is what makes the window a boundary, not a hint.
    const redated = stale.replace(/^t=\d+/, `t=${epochSeconds(NOW)}`);
    expect(redated).toContain(`t=${epochSeconds(NOW)}`);
    expect((await refusal(verify(BODY, redated))).code).toBe("core/webhook_unverified");
  });
});

describe("verifySignedWebhook — the freshness window, in both directions", () => {
  test("accepts a delivery at either edge of the window", async () => {
    await expect(verify(BODY, await header(BODY, at(-SIGNED_WEBHOOK_TOLERANCE_SECONDS)))).resolves.toBeUndefined();
    await expect(verify(BODY, await header(BODY, at(SIGNED_WEBHOOK_TOLERANCE_SECONDS)))).resolves.toBeUndefined();
  });

  test("refuses a stale delivery", async () => {
    const stale = await header(BODY, at(-(SIGNED_WEBHOOK_TOLERANCE_SECONDS + 1)));
    expect((await refusal(verify(BODY, stale))).code).toBe("core/webhook_unverified");
  });

  test("refuses a delivery from the future — a clock problem or a crafted one, never a delivery to act on", async () => {
    const ahead = await header(BODY, at(SIGNED_WEBHOOK_TOLERANCE_SECONDS + 1));
    expect((await refusal(verify(BODY, ahead))).code).toBe("core/webhook_unverified");
  });

  test("honors a narrower tolerance", async () => {
    const delivery = await header(BODY, at(-60));
    await expect(verify(BODY, delivery, { toleranceSeconds: 120 })).resolves.toBeUndefined();
    expect((await refusal(verify(BODY, delivery, { toleranceSeconds: 30 }))).code).toBe("core/webhook_unverified");
  });
});

describe("verifySignedWebhook — a clock that is not a clock", () => {
  test("an unreadable clock fails closed, and as our fault rather than the sender's", async () => {
    // `Math.abs(NaN - t) > tolerance` is false, so an invalid Date would slip a delivery of any age through
    // the one window in this file — the single check that could fail open. Only a caller-supplied clock can
    // be one: the header's timestamp is regex-checked before it is a number.
    const payload = await refusal(verify(BODY, await header(BODY, NOW), { now: new Date("not a date") }));
    expect(payload.code).toBe("core/internal");
    expect(payload.status).toBe(500);
  });

  test("a delivery outside the window is still refused when the clock is a clock", async () => {
    const stale = await header(BODY, at(-(SIGNED_WEBHOOK_TOLERANCE_SECONDS + 1)));
    expect((await refusal(verify(BODY, stale, { now: at(0) }))).code).toBe("core/webhook_unverified");
  });
});

describe("verifySignedWebhook — the comparison", () => {
  test("compares through crypto.subtle.verify, never ===", async () => {
    const spy = vi.spyOn(crypto.subtle, "verify");
    try {
      await verify(BODY, await header(BODY, NOW));
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("refuses a candidate that is a truncated prefix of the correct signature", async () => {
    const timestamp = epochSeconds(NOW);
    const correct = await sign(SECRET, timestamp, BODY);
    const prefix = correct.slice(0, correct.length - 2);
    expect((await refusal(verify(BODY, `t=${timestamp},v1=${prefix}`))).code).toBe("core/webhook_unverified");
  });

  test("refuses a candidate that matches every byte but the last", async () => {
    const timestamp = epochSeconds(NOW);
    const correct = await sign(SECRET, timestamp, BODY);
    const lastNibble = correct.slice(-1);
    const flipped = `${correct.slice(0, -1)}${lastNibble === "0" ? "1" : "0"}`;
    expect((await refusal(verify(BODY, `t=${timestamp},v1=${flipped}`))).code).toBe("core/webhook_unverified");
  });
});

describe("verifySignedWebhook — several candidates in one header", () => {
  test("tries every candidate, so a rotation's second signature still verifies", async () => {
    const timestamp = epochSeconds(NOW);
    const stale = await sign("whsec_the_secret_being_rotated_out", timestamp, BODY);
    const good = await sign(SECRET, timestamp, BODY);
    await expect(verify(BODY, `t=${timestamp},v1=${stale},v1=${good}`)).resolves.toBeUndefined();
  });

  test("skips a candidate that is not 32 bytes of hex rather than refusing on it", async () => {
    const timestamp = epochSeconds(NOW);
    const good = await sign(SECRET, timestamp, BODY);
    await expect(verify(BODY, `t=${timestamp},v1=not-hex,v1=${good}`)).resolves.toBeUndefined();
  });

  test("accepts a delivery signed with any secret the endpoint still honors", async () => {
    const outgoing = "whsec_the_secret_being_rotated_out";
    const delivery = await header(BODY, NOW, outgoing);
    await expect(verify(BODY, delivery, { secret: [SECRET, outgoing] })).resolves.toBeUndefined();
    expect((await refusal(verify(BODY, delivery, { secret: [SECRET] }))).code).toBe("core/webhook_unverified");
  });
});

describe("verifySignedWebhook — headers that prove nothing", () => {
  test("refuses a missing header", async () => {
    expect((await refusal(verify(BODY, null))).code).toBe("core/webhook_unverified");
  });

  test.each([
    ["empty", ""],
    ["no key=value pairs at all", "garbage"],
    ["no timestamp", "v1=0123456789abcdef"],
    ["no signature", "t=1785931200"],
    ["a non-integer timestamp", "t=1785931200.5,v1=0123456789abcdef"],
    ["an empty timestamp", "t=,v1=0123456789abcdef"],
    ["only an unknown scheme", "t=1785931200,v0=0123456789abcdef"],
  ])("refuses a malformed header: %s", async (_case, value) => {
    expect((await refusal(verify(BODY, value))).code).toBe("core/webhook_unverified");
  });

  test("parses a well-formed header and nothing else", async () => {
    const timestamp = epochSeconds(NOW);
    const signature = await sign(SECRET, timestamp, BODY);
    expect(parseSignedWebhookHeader(`t=${timestamp},v1=${signature}`, "t", "v1")).toEqual({
      timestamp,
      signatures: [signature],
    });
    expect(parseSignedWebhookHeader("garbage", "t", "v1")).toBeUndefined();
  });
});

describe("verifySignedWebhook — a sender that names the header keys differently", () => {
  test("honors the configured timestamp and signature keys", async () => {
    const timestamp = epochSeconds(NOW);
    const signature = await sign(SECRET, timestamp, BODY);
    const keys = { timestampKey: "ts", signatureKey: "v0" };
    await expect(verify(BODY, `ts=${timestamp},v0=${signature}`, keys)).resolves.toBeUndefined();
    // The defaults are not also accepted — an endpoint that answered to both would verify a delivery
    // under a scheme its sender never agreed to.
    expect((await refusal(verify(BODY, `t=${timestamp},v1=${signature}`, keys))).code).toBe("core/webhook_unverified");
  });
});

describe("verifySignedWebhook — an endpoint holding no secret", () => {
  test("is a configuration fault, not an unverified delivery", async () => {
    const payload = await refusal(verify(BODY, await header(BODY, NOW), { secret: [] }));
    // Reporting this as `core/webhook_unverified` would send an operator hunting a forger who is not
    // there, while the real answer is a secret that never resolved.
    expect(payload.code).toBe("core/internal");
    expect(payload.status).toBe(500);
  });
});

describe("verifySignedWebhook — a secret that resolved to nothing", () => {
  test.each([
    ["one empty string", ""],
    ["an array holding only an empty string", [""]],
  ])("%s is the same configuration fault as no secret at all", async (_case, secret) => {
    // The shape an unresolved secret actually arrives in. A resolver ends in `?? ""` or reads a version
    // that is not set, so `""` is far likelier than `[]` — and `importKey` answers a zero-length key with
    // a raw DOMException, which is neither a PithyError nor a sentence an operator can act on.
    const payload = await refusal(verify(BODY, await header(BODY, NOW), { secret }));
    expect(payload.code).toBe("core/internal");
    expect(payload.status).toBe(500);
  });

  test.each([
    ["ahead of", ["", SECRET]],
    ["behind", [SECRET, ""]],
  ])("a blank version %s the good one does not take the endpoint down", async (_case, secret) => {
    // A rotation where one version resolves blank still has a usable one. Whether the endpoint verifies
    // must not depend on which index the blank sits at.
    await expect(verify(BODY, await header(BODY, NOW), { secret })).resolves.toBeUndefined();
  });
});

describe("verifySignedWebhook — how many candidates one delivery may spend", () => {
  /** A well-formed but wrong candidate: 32 bytes of hex that no secret produced. */
  const junk = (index: number) => index.toString(16).padStart(64, "0");

  test("tries a rotation's worth of candidates", async () => {
    const timestamp = epochSeconds(NOW);
    const good = await sign(SECRET, timestamp, BODY);
    const before = Array.from({ length: SIGNED_WEBHOOK_MAX_CANDIDATES - 1 }, (_, index) => `v1=${junk(index)}`);
    await expect(verify(BODY, `t=${timestamp},${before.join(",")},v1=${good}`)).resolves.toBeUndefined();
  });

  test("refuses beyond the cap, so a header cannot buy unbounded HMAC work", async () => {
    // Every listed candidate costs a full HMAC over the whole body, once per configured secret, and the
    // list is written by whoever sent the request. Uncapped, one anonymous POST with a 16 KiB header and
    // a large body costs hundreds of times what a real delivery does. No sender lists this many.
    const timestamp = epochSeconds(NOW);
    const good = await sign(SECRET, timestamp, BODY);
    const before = Array.from({ length: SIGNED_WEBHOOK_MAX_CANDIDATES }, (_, index) => `v1=${junk(index)}`);
    expect((await refusal(verify(BODY, `t=${timestamp},${before.join(",")},v1=${good}`))).code).toBe(
      "core/webhook_unverified",
    );
  });

  test("the cap counts candidates that could be signatures, not the junk padding them out", async () => {
    // Dropping the unusable ones first means a flood of malformed entries cannot crowd the real signature
    // out of the window — the cap is a work bound, not a way to hide a good signature behind noise.
    const timestamp = epochSeconds(NOW);
    const good = await sign(SECRET, timestamp, BODY);
    const noise = Array.from({ length: 200 }, () => "v1=not-hex").join(",");
    await expect(verify(BODY, `t=${timestamp},${noise},v1=${good}`)).resolves.toBeUndefined();
  });

  test("spends at most cap × secrets verifications on a flood", async () => {
    const spy = vi.spyOn(crypto.subtle, "verify");
    try {
      const timestamp = epochSeconds(NOW);
      const flood = Array.from({ length: 200 }, (_, index) => `v1=${junk(index)}`).join(",");
      await refusal(verify(BODY, `t=${timestamp},${flood}`, { secret: [SECRET, "whsec_the_other_one"] }));
      expect(spy.mock.calls.length).toBeLessThanOrEqual(SIGNED_WEBHOOK_MAX_CANDIDATES * 2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("verifySignedWebhook — a header no legitimate sender writes", () => {
  test("refuses two timestamps in one header rather than taking the last", async () => {
    // Not exploitable — the winning `t` must also be the one inside the signature and inside the window —
    // but a header carrying two answers to one question has not stated when it was signed, and silently
    // picking one is how a parser and a sender come to disagree about what was signed.
    const timestamp = epochSeconds(NOW);
    const signature = await sign(SECRET, timestamp, BODY);
    expect(parseSignedWebhookHeader(`t=999,v1=${signature},t=${timestamp}`, "t", "v1")).toBeUndefined();
    expect((await refusal(verify(BODY, `t=999,v1=${signature},t=${timestamp}`))).code).toBe("core/webhook_unverified");
  });

  test("refuses a non-canonical timestamp as an unreadable header, not as a bad signature", async () => {
    // `t=0001785931200` parses to the same instant but is not the string the sender signed over, so it
    // could only ever be refused. Refusing it here names the digit; refusing it at the HMAC would send an
    // operator hunting a rotated secret.
    const timestamp = epochSeconds(NOW);
    expect(parseSignedWebhookHeader(`t=000${timestamp},v1=${"a".repeat(64)}`, "t", "v1")).toBeUndefined();
    const payload = await refusal(verify(BODY, `t=000${timestamp},v1=${"a".repeat(64)}`));
    expect(payload.detail).toContain("no readable");
  });

  test("still reads a bare zero", async () => {
    expect(parseSignedWebhookHeader("t=0,v1=aa", "t", "v1")).toEqual({ timestamp: 0, signatures: ["aa"] });
  });
});

describe("verifySignedWebhook — an empty body", () => {
  test("verifies an empty body signed as an empty body", async () => {
    await expect(verify("", await header("", NOW))).resolves.toBeUndefined();
  });

  test("refuses an empty body carrying a signature made over content", async () => {
    expect((await refusal(verify("", await header(BODY, NOW)))).code).toBe("core/webhook_unverified");
  });
});

describe("verifySignedWebhook — what a refusal says", () => {
  test.each([
    ["a missing header", null],
    ["a malformed header", "garbage"],
  ])("%s echoes neither the secret, the signature, nor the body", async (_case, value) => {
    const payload = await refusal(verify(BODY, value));
    const said = `${payload.message} ${payload.action ?? ""} ${payload.detail ?? ""}`;
    expect(said).not.toContain(SECRET);
    expect(said).not.toContain(BODY);
    expect(said).not.toContain("invoice.paid");
  });

  test.each([
    ["a stale delivery", -(SIGNED_WEBHOOK_TOLERANCE_SECONDS + 1)],
    ["a future delivery", SIGNED_WEBHOOK_TOLERANCE_SECONDS + 1],
    ["a fresh delivery whose signature is wrong", 0],
  ])("%s echoes neither the secret, the signature, nor the body", async (label, offset) => {
    const secret = label.includes("signature is wrong") ? "whsec_the_wrong_one" : SECRET;
    const value = await header(BODY, at(offset), secret);
    const signature = value.slice(value.indexOf("v1=") + 3);
    const payload = await refusal(verify(BODY, value));
    const said = `${payload.message} ${payload.action ?? ""} ${payload.detail ?? ""}`;
    expect(said).not.toContain(SECRET);
    expect(said).not.toContain(signature);
    expect(said).not.toContain(BODY);
    expect(said).not.toContain("invoice.paid");
  });

  test("claims no comparison when there was nothing to compare", async () => {
    // Every listed value fell to the 32-byte hex filter, so no secret was ever tried. Saying "no signature
    // matches under a configured signing secret" would assert a comparison that never ran, and send an
    // operator hunting a rotated secret while the sender's signature format is what is wrong.
    const timestamp = epochSeconds(NOW);
    expect(
      await checkSignedWebhook(BODY, `t=${timestamp},v1=not-hex`, { header: HEADER, secret: SECRET, now: NOW }),
    ).toEqual({ reason: "unmatched", compared: 0 });

    const payload = await refusal(verify(BODY, `t=${timestamp},v1=not-hex`));
    expect(payload.detail).toContain("no signature was compared");
    expect(payload.detail).not.toContain("configured signing secret");
  });

  test("counts what it compared when a comparison did run", async () => {
    const timestamp = epochSeconds(NOW);
    const junk = (index: number) => index.toString(16).padStart(64, "0");
    const value = `t=${timestamp},v1=${junk(1)},v1=${junk(2)}`;
    expect(await checkSignedWebhook(BODY, value, { header: HEADER, secret: SECRET, now: NOW })).toEqual({
      reason: "unmatched",
      compared: 2,
    });

    const payload = await refusal(verify(BODY, value));
    expect(payload.detail).toContain("2 signatures");
    expect(payload.detail).toContain("configured signing secret");
  });

  test("a refusal is a 401 whose wire body carries no detail", async () => {
    const payload = await refusal(verify(BODY, null));
    expect(payload.status).toBe(401);
    expect(payload.detail).toBeTruthy();
  });
});

/** The one route shape the guard has to survive: a guard, then a json validator, then a handler. */
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

/**
 * A POST whose body is a stream nobody has pulled yet, so a test can ask whether the guard buffered it.
 *
 * A spy on `c.req.text` would prove the same call was made; this proves the bytes never left the socket, which
 * is the property that matters when the caller chose the body's size.
 */
function streamedDelivery(headers: Record<string, string>): { request: Request; buffered: () => boolean } {
  let buffered = false;
  // `highWaterMark: 0`, deliberately: a default stream pulls once as soon as it starts, to fill a queue nobody
  // asked for, and the probe would then report a read that never happened.
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        buffered = true;
        controller.enqueue(new TextEncoder().encode(BODY));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const request = new Request("http://pithy.test/hooks/inbound", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit);
  return { request, buffered: () => buffered };
}

describe("requireSignedWebhook — the Hono guard", () => {
  test("a verified delivery reaches the handler, and the json validator sees identical bytes", async () => {
    const response = await guardedApp().request("/hooks/inbound", {
      method: "POST",
      headers: { [HEADER]: await header(BODY, NOW), "content-type": "application/json" },
      body: BODY,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ event: "invoice.paid" });
  });

  test("an unsigned delivery is refused 401, and the response carries no detail", async () => {
    const response = await guardedApp().request("/hooks/inbound", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: BODY,
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error.code).toBe("core/webhook_unverified");
    expect(body.error).not.toHaveProperty("detail");
  });

  test.each([
    ["no proof header at all", {}],
    ["a proof header that proves nothing", { [HEADER]: "garbage" }],
  ])("%s is refused before the body is buffered and before a secret is resolved", async (_case, proof) => {
    // The cheapest possible rejection, on the route whose whole purpose is to refuse unauthenticated callers.
    // A delivery with no readable proof is refused whatever the body holds, so buffering it — and resolving a
    // secret, which is a D1 read and a decrypt — would be unauthenticated work bought by an anonymous POST.
    const resolver = vi.fn(() => SECRET);
    const { request, buffered } = streamedDelivery({ "content-type": "application/json", ...proof });
    const response = await guardedApp({ secret: resolver }).request(request);
    expect(response.status).toBe(401);
    expect(buffered()).toBe(false);
    expect(resolver).not.toHaveBeenCalled();
  });

  test("an endpoint whose secret never resolved tells a proof-less caller nothing", async () => {
    // The consequence of checking the header first, and the right one. A caller with nothing to verify gets
    // the same 401 every endpoint gives it; the configuration fault surfaces on the first delivery that
    // actually carries a proof, where an operator is the one reading it.
    const app = guardedApp({ secret: "" });
    const anonymous = await app.request("/hooks/inbound", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: BODY,
    });
    expect(anonymous.status).toBe(401);

    const signed = await app.request("/hooks/inbound", {
      method: "POST",
      headers: { [HEADER]: await header(BODY, NOW), "content-type": "application/json" },
      body: BODY,
    });
    expect(signed.status).toBe(500);
  });

  test("a readable proof header still buys the body read the scheme needs", async () => {
    // The other half: the early exit must refuse the unreadable, never the unverified-but-well-formed.
    const { request, buffered } = streamedDelivery({
      [HEADER]: await header(BODY, NOW),
      "content-type": "application/json",
    });
    const response = await guardedApp().request(request);
    expect(response.status).toBe(200);
    expect(buffered()).toBe(true);
  });

  test("reads the header the scheme names, not a hard-coded one", async () => {
    const app = guardedApp({ header: "x-acme-signature" });
    const value = await header(BODY, NOW);
    const wrongHeader = await app.request("/hooks/inbound", {
      method: "POST",
      headers: { [HEADER]: value, "content-type": "application/json" },
      body: BODY,
    });
    expect(wrongHeader.status).toBe(401);

    const rightHeader = await app.request("/hooks/inbound", {
      method: "POST",
      headers: { "x-acme-signature": value, "content-type": "application/json" },
      body: BODY,
    });
    expect(rightHeader.status).toBe(200);
  });

  test("resolves the secret from the Worker env at the point of need", async () => {
    const resolver = vi.fn(async (env: Record<string, unknown>) => String(env.WEBHOOK_SECRET));
    const app = guardedApp({ secret: resolver });
    const response = await app.request(
      "/hooks/inbound",
      {
        method: "POST",
        headers: { [HEADER]: await header(BODY, NOW), "content-type": "application/json" },
        body: BODY,
      },
      { WEBHOOK_SECRET: SECRET },
    );
    expect(response.status).toBe(200);
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  test("a forged delivery never reaches the handler", async () => {
    let reached = false;
    const app = new Hono<PithyHonoEnv>();
    app.onError(pithyErrorHandler);
    app.post("/hooks/inbound", requireSignedWebhook({ header: HEADER, secret: SECRET, now: () => NOW }), (c) => {
      reached = true;
      return c.json({ ok: true });
    });
    const response = await app.request("/hooks/inbound", {
      method: "POST",
      headers: { [HEADER]: `t=${epochSeconds(NOW)},v1=${"0".repeat(64)}`, "content-type": "application/json" },
      body: BODY,
    });
    expect(response.status).toBe(401);
    expect(reached).toBe(false);
  });
});

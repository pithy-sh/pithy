// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { clientError } from "./client";
import { defineErrorPayload } from "./extend";
import { HttpError } from "./http";
import { ErrorPayload, PublicErrorPayload } from "./payload";
import { NotFoundError, RateLimitError } from "./pithyError";
import { operatorError, renderTerminal } from "./terminal";

/**
 * **The server never localizes an error, and `params` is what lets a client do it instead.**
 *
 * `message` is English permanently, because it is two things at once: the operator's diagnostic — the
 * sentence in the log line, the audit row, the Cloudflare dashboard — and the fallback for any client
 * that does not translate. Translating it server-side would trade the first for the second and require
 * guessing a locale for a caller that may have declared none.
 *
 * So the wire carries the two halves a translation needs and nothing more: the `code`, which every
 * member already declares as its discriminator and which *is* the catalog key (`../i18n/catalog`), and
 * the values its placeholders take. A translating client renders
 * `t.maybe(payload.code, payload.params) ?? payload.message`, and a client that does not translate reads the
 * message it always read.
 *
 * The tests below hold three properties that are easy to lose one at a time: an error with no params
 * puts no key on the wire, an error with params gets them **past** `clientError` (this is the first
 * public field added since the boundary was written, and the boundary strips by name and by schema),
 * and the operator's two surfaces still say what they said.
 */

/** A placeholder set of the shape a throw site actually fills: the value already inside the sentence. */
const PARAMS = Object.freeze({ retryAfter: 30, plan: "free", upgradable: true });

describe("an error that names no placeholders is byte-identical to what it always was", () => {
  test("the wire body is exactly the three fields, with no empty record in sight", () => {
    // `toEqual` treats an `undefined` property as absent, so the bytes are asserted rather than the
    // shape. This is the property that makes `params` optional-and-absent rather than `.default({})`:
    // every client already deployed receives the response it parsed yesterday.
    expect(JSON.stringify(clientError(new NotFoundError({ message: "No such session." }).payload))).toBe(
      '{"code":"core/not_found","status":404,"message":"No such session."}',
    );
  });

  test("a payload with no params parses, and parsing does not invent one", () => {
    const parsed = ErrorPayload.parse({ code: "core/not_found", status: 404, message: "No such session." });
    expect(parsed).toEqual({ code: "core/not_found", status: 404, message: "No such session." });
    expect(JSON.stringify(PublicErrorPayload.parse(parsed))).not.toContain("params");
  });
});

describe("params reach the client, because the client is who they are for", () => {
  test("`clientError` carries them through — unlike `action` and `detail`, which it drops", () => {
    const wire = clientError(
      new RateLimitError({
        message: "Too many requests. Try again in 30 seconds.",
        action: "Raise `rateLimit.perMinute` in pithy.config.ts.",
        detail: "bucket auth:otp:192.0.2.1 exhausted",
        params: PARAMS,
      }).payload,
    );
    expect(wire).toEqual({
      code: "rate_limit/exceeded",
      status: 429,
      message: "Too many requests. Try again in 30 seconds.",
      params: PARAMS,
    });
  });

  test("`HttpError.encode` round-trips them — the codec is a caller of the boundary, not a second one", () => {
    const payload = new RateLimitError({ message: "Too many requests.", params: PARAMS }).payload;
    const wire = HttpError.encode(payload);
    expect(wire.params).toEqual(PARAMS);
    // Decode is the client SDK's direction. The values that went out are the values that come back.
    expect(HttpError.decode(wire)).toEqual({
      code: "rate_limit/exceeded",
      status: 429,
      message: "Too many requests.",
      params: PARAMS,
    });
  });

  test("an adopter's own code carries them too — the seam is not narrower than the kit", () => {
    // `defineErrorPayload`'s parameter type is hand-written and the return is cast, so a field missing
    // from that literal is not a compile error anywhere: it is simply a field an adopter cannot pass.
    // This is the test that would have caught it.
    const payload = defineErrorPayload({
      code: "connect/device_code_expired",
      status: 410,
      message: "That device code expired 5 minutes ago.",
      action: "Run `pithy dashboard connect` again.",
      detail: "code 9f2c bound to org 3",
      params: { minutes: 5 },
    });
    expect(payload.params).toEqual({ minutes: 5 });
    expect(clientError(payload)).toEqual({
      code: "connect/device_code_expired",
      status: 410,
      message: "That device code expired 5 minutes ago.",
      params: { minutes: 5 },
    });
  });
});

describe("the operator's surfaces are unchanged", () => {
  const payload = new RateLimitError({
    message: "Too many requests. Try again in 30 seconds.",
    action: "Raise `rateLimit.perMinute` in pithy.config.ts.",
    detail: "bucket auth:otp:192.0.2.1 exhausted",
    params: PARAMS,
  }).payload;

  test("`renderTerminal` prints the same two lines, params or no params", () => {
    // The operator reads English by definition — they are reading our logs against our source. So the
    // terminal never consults `params`, and its output is identical to the same error without them.
    const bare = new RateLimitError({
      message: "Too many requests. Try again in 30 seconds.",
      action: "Raise `rateLimit.perMinute` in pithy.config.ts.",
    }).payload;
    expect(renderTerminal(payload)).toBe(renderTerminal(bare));
    expect(renderTerminal(payload)).toBe(
      "Too many requests. Try again in 30 seconds.\nRaise `rateLimit.perMinute` in pithy.config.ts.",
    );
  });

  test("`operatorError` still keeps the remedy and still drops the throw-site context", () => {
    // Params ride along on the public half rather than being stripped, and that is correct rather than
    // incidental: they are client-safe by classification, and `--json` is a superset of the wire plus
    // the remedy. What must not change is the boundary either side of them.
    const json = operatorError(payload);
    expect(json.action).toBe("Raise `rateLimit.perMinute` in pithy.config.ts.");
    expect(JSON.stringify(json)).not.toContain("192.0.2.1");
    expect(json.params).toEqual(PARAMS);
  });
});

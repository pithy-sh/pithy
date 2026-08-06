// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { ErrorPayload, KitErrorPayload, KitPublicErrorPayload, PublicErrorPayload, ValidationIssue } from "./payload";

describe("ErrorPayload (the kit taxonomy)", () => {
  test("accepts a well-formed member and narrows on `code`", () => {
    const parsed = ErrorPayload.parse({
      code: "auth/forbidden",
      status: 403,
      message: "Forbidden.",
    });
    expect(parsed.code).toBe("auth/forbidden");
    expect(parsed.status).toBe(403);
  });

  test("rejects a code it does not define", () => {
    // `nope/unknown` is well-formed, so `ErrorPayload` accepts it through the adopter seam below.
    // The kit union is the one that stays closed.
    expect(() => KitErrorPayload.parse({ code: "nope/unknown", status: 400, message: "x" })).toThrow();
  });

  test("rejects a status that does not match its code", () => {
    expect(() => ErrorPayload.parse({ code: "auth/forbidden", status: 401, message: "x" })).toThrow();
  });

  test("carries an optional internal `detail`", () => {
    const parsed = ErrorPayload.parse({
      code: "core/internal",
      status: 500,
      message: "Something unexpected happened.",
      detail: "stack-ish context",
    });
    expect(parsed.detail).toBe("stack-ish context");
  });

  test("the validation member carries field-level issues", () => {
    const parsed = ErrorPayload.parse({
      code: "validation/invalid_input",
      status: 400,
      message: "Invalid input.",
      issues: [{ path: ["email"], message: "Required", code: "invalid_type" }],
    });
    if (parsed.code !== "validation/invalid_input") throw new Error("narrowing failed");
    // Also the compile-time guard on the adopter seam: `.issues` resolves only because the open
    // member narrowed away with every other. Unbrand `ExtendedErrorCode` and this line stops
    // typechecking — for us here, and for every consumer that narrows on a code.
    expect(parsed.issues[0]?.path).toEqual(["email"]);
  });

  test("covers every code in the initial taxonomy", () => {
    const taxonomy: Array<[string, number]> = [
      ["validation/invalid_input", 400],
      ["auth/invalid_token", 401],
      ["auth/forbidden", 403],
      ["core/not_found", 404],
      ["core/conflict", 409],
      ["rate_limit/exceeded", 429],
      ["core/internal", 500],
      ["cloudflare/not_configured", 500],
      ["cloudflare/request_failed", 502],
      ["cloudflare/invalid_response", 502],
      ["secrets/not_found", 404],
      ["secrets/already_exists", 409],
      ["secrets/invalid_value", 400],
      ["secrets/crypto_failed", 500],
      ["turnstile/missing_token", 400],
      ["turnstile/failed", 403],
      ["turnstile/config", 500],
      ["core/upstream_failed", 502],
      ["core/upstream_timeout", 504],
      ["core/webhook_unverified", 401],
    ];
    for (const [code, status] of taxonomy) {
      const base: Record<string, unknown> = { code, status, message: "m" };
      if (code === "validation/invalid_input") base.issues = [];
      expect(() => ErrorPayload.parse(base)).not.toThrow();
    }
  });
});

describe("upstream failure (a dependency we do not control)", () => {
  test("`core/upstream_failed` is a 502 — the dependency answered, and unusably", () => {
    const parsed = ErrorPayload.parse({
      code: "core/upstream_failed",
      status: 502,
      message: "An upstream service could not be reached.",
      detail: "GET https://customer.example/admin/users → 500",
    });
    expect(parsed.code).toBe("core/upstream_failed");
    expect(parsed.status).toBe(502);
  });

  test("`core/upstream_timeout` is a 504 — the hop, not this service, ran out of time", () => {
    const parsed = ErrorPayload.parse({
      code: "core/upstream_timeout",
      status: 504,
      message: "An upstream service did not answer in time.",
    });
    expect(parsed.status).toBe(504);
  });

  test("neither upstream code may be pinned to a 500 — that would blame the wrong system", () => {
    expect(() => ErrorPayload.parse({ code: "core/upstream_failed", status: 500, message: "x" })).toThrow();
    expect(() => ErrorPayload.parse({ code: "core/upstream_timeout", status: 500, message: "x" })).toThrow();
  });
});

describe("ExtendedErrorPayload (the adopter seam)", () => {
  test("accepts an adopter-namespaced code the kit does not define", () => {
    const parsed = ErrorPayload.parse({
      code: "connect/device_code_expired",
      status: 410,
      message: "That device code has expired.",
      action: "Run pithy dashboard connect again.",
    });
    expect(parsed.code).toBe("connect/device_code_expired");
    expect(parsed.status).toBe(410);
  });

  test("carries `detail` in memory, exactly like a kit member", () => {
    const parsed = ErrorPayload.parse({
      code: "keys/rotation_locked",
      status: 409,
      message: "A rotation is already running.",
      detail: "lock held by job 7",
    });
    expect(parsed.detail).toBe("lock held by job 7");
  });

  test("refuses a code the kit already owns — the seam extends the taxonomy, it never redefines it", () => {
    // The guard that keeps the closed set closed: without it, `auth/forbidden` with the wrong
    // status would stop failing and start parsing as an adopter code.
    expect(() => ErrorPayload.parse({ code: "auth/forbidden", status: 401, message: "x" })).toThrow();
    expect(() => ErrorPayload.parse({ code: "core/internal", status: 418, message: "x" })).toThrow();
  });

  test("refuses any code in a kit domain, not just the exact ones the kit spells today", () => {
    // The reserved-namespace rule. It is what keeps a capability's typo — `payments/verifcation_failed`
    // — a hard failure instead of a valid adopter code with a status nobody pinned, and it leaves the
    // kit free to add codes under its own domains without landing on top of an adopter's.
    expect(() => ErrorPayload.parse({ code: "payments/verifcation_failed", status: 400, message: "x" })).toThrow();
    expect(() => ErrorPayload.parse({ code: "core/anything_at_all", status: 400, message: "x" })).toThrow();
    expect(() => ErrorPayload.parse({ code: "testers/brand_new", status: 409, message: "x" })).toThrow();
  });

  test("refuses a code that is not `domain/reason`", () => {
    for (const code of ["unnamespaced", "Connect/DeviceCode", "connect/", "/expired", "a/b/c", "connect/device code"]) {
      expect(() => ErrorPayload.parse({ code, status: 400, message: "x" })).toThrow();
    }
  });

  test("refuses a status outside the 4xx/5xx error range", () => {
    for (const status of [200, 302, 399, 600, 404.5]) {
      expect(() => ErrorPayload.parse({ code: "connect/nope", status, message: "x" })).toThrow();
    }
  });

  test("KitErrorPayload stays closed — the adopter seam is on ErrorPayload, not under it", () => {
    expect(() => KitErrorPayload.parse({ code: "connect/device_code_expired", status: 410, message: "x" })).toThrow();
  });

  test("refuses a code segment long enough to be a payload of its own", () => {
    // Every kit code was a literal, so `code` was bounded by construction. The open member has to
    // bound it by rule: this string arrives from a customer's Worker on the decode side, and lands
    // whole in a log line and an audit row.
    expect(() => ErrorPayload.parse({ code: `connect/${"a".repeat(200)}`, status: 400, message: "x" })).toThrow();
    expect(() => ErrorPayload.parse({ code: `${"a".repeat(200)}/expired`, status: 400, message: "x" })).toThrow();
  });
});

describe("META: the kit's two unions", () => {
  test("define exactly the same codes", () => {
    // The reserved-domain set and the wire projection are both derived from these unions. A code
    // added to one and not the other unreserves its domain *and* makes `HttpError.encode` throw
    // from inside Hono's onError — a failure on the error path, which is the worst place for one.
    const codesOf = (union: typeof KitErrorPayload | typeof KitPublicErrorPayload) =>
      union.options.map((member) => member.shape.code.value).sort();
    expect(codesOf(KitPublicErrorPayload)).toEqual(codesOf(KitErrorPayload));
  });
});

describe("PublicErrorPayload (the wire shape)", () => {
  test("strips `detail` on parse — it is not part of the public shape", () => {
    const parsed = PublicErrorPayload.parse({
      code: "core/internal",
      status: 500,
      message: "Something unexpected happened.",
      detail: "secret context",
    });
    expect("detail" in parsed).toBe(false);
  });

  test("strips `detail` from an adopter-defined payload too — the boundary is not per-code", () => {
    const parsed = PublicErrorPayload.parse({
      code: "connect/device_code_expired",
      status: 410,
      message: "That device code has expired.",
      detail: "code 9f2c issued to org 3",
    });
    expect("detail" in parsed).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain("9f2c");
  });
});

describe("ValidationIssue", () => {
  test("validates a field-level failure", () => {
    const issue = ValidationIssue.parse({ path: ["user", 0, "email"], message: "Required", code: "invalid_type" });
    expect(issue.path).toEqual(["user", 0, "email"]);
  });
});

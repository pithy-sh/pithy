// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  ErrorPayload,
  KitErrorPayload,
  KitPublicErrorPayload,
  kitErrorStatus,
  PublicErrorPayload,
  ValidationIssue,
} from "./payload";
import { PithyError } from "./pithyError";

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
      ["secrets/rotation_unrecorded", 500],
      ["secrets/rotation_unsupported", 409],
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

/**
 * The population of the kit's closed taxonomy. Written down, deliberately, rather than read off
 * either union — an expectation computed from its own subject passes whatever the subject says, and
 * a parity check alone cannot see a *matched pair* of deletions, because the two lists stay equal
 * all the way down to empty. Both unions are measured against this number and never against each
 * other's length. Changing the taxonomy's size is a deliberate act; changing this line is part of it.
 *
 * Verified 2026-08-18: 120 members in each union, no duplicates, sorted lists identical.
 *
 * `payments/subject_unresolved` (#412) — a payments write path that could not learn which subject the
 * caller acts for. It needs its own code because it is the one refusal in the domain the *adopter*
 * causes and only the adopter can repair: under organization billing the subject comes from their
 * resolver, and an unanswered seam is neither a denial about entitlement nor a fault in our code. On a
 * read the gate simply holds nothing and denies; on a write there is no row to write, and silence there
 * is a purchase that vanishes.
 *
 * `auth/provider_unavailable` (#381) — a social sign-in provider the deployment enables whose credential
 * would not resolve. It needs its own code because the instance now builds *without* that provider, and
 * Better Auth answers a provider it does not hold with `PROVIDER_NOT_FOUND` 404 — the same answer it
 * gives for one nobody ever enabled. Sharing that code would have made a broken provider and an absent
 * one indistinguishable from outside the Worker, which is precisely the distinction the fix turns on.
 *
 * The three before it took it to 118, and **two of those were added the same day on separate branches**,
 * each moving this line to 117 on its own — so that merge was 118 and not a repeat. Which is the case
 * this comment exists for: the number is maintained by hand precisely so that two people cannot each be
 * right and the taxonomy still be miscounted.
 *
 * `secrets/rotation_unsupported` (#372) — a rotation asked of a Worker-side route for a secret no single
 * Worker can replace. It needs its own code because a client must tell it from a denial and from a fault:
 * the remedy is the `pithy secrets rotate` command, not a wider grant and not a retry.
 *
 * `core/workflow_failed` (#365) — a dispatched Workflow that ran and ended without completing. It needs
 * its own code because it had been arriving as `cloudflare/request_failed` 502, which tells an operator
 * the far side is broken and to wait, for a run that is permanently over.
 *
 * The one before both was `secrets/rotation_unrecorded` (#367), which took it to 116 — a credential
 * rolled at its issuer whose successor the store never took, the one secrets failure a retry cannot
 * repair.
 */
const KIT_ERROR_CODE_COUNT = 120;

/** One member of either kit union — the public projection or its `action`/`detail` twin. */
type KitUnionMember = (typeof KitErrorPayload | typeof KitPublicErrorPayload)["options"][number];

/**
 * The `code` literal of one union member, or a throw. A member whose discriminator cannot be read is
 * the one case a gate must never wave through: skipping it drops that code out of both lists at once,
 * which is precisely the drift the gate exists to catch, and the suite goes green on it.
 */
function codeOf(member: KitUnionMember): string {
  const read = z.string().min(1).safeParse(member.shape.code.value);
  if (!read.success) {
    throw new PithyError({
      code: "core/internal",
      status: 500,
      message: "A member of the kit error taxonomy has no readable `code` literal.",
      detail: `Member: ${member.description ?? "(no description)"}`,
    });
  }
  return read.data;
}

/** Every code in one union, sorted. Sorted rather than a set, so a duplicated member still shows. */
function codesOf(union: typeof KitErrorPayload | typeof KitPublicErrorPayload): string[] {
  return union.options.map(codeOf).sort();
}

describe("META: the kit's two unions", () => {
  // The reserved-domain set and the wire projection are both derived from these unions. A code
  // added to one and not the other unreserves its domain *and* makes `HttpError.encode` throw
  // from inside Hono's onError — a failure on the error path, which is the worst place for one.
  // Worse than the throw: `KitPublicErrorPayload` is the security boundary, the shape with no
  // `detail`. A code that reaches the wire without a member there is a field somebody assumed was
  // stripped, no longer stripped. Two hand-maintained lists are the whole of what stands in the way.
  const internalCodes = codesOf(KitErrorPayload);
  const publicCodes = codesOf(KitPublicErrorPayload);

  test("the internal union holds exactly the pinned population", () => {
    expect(internalCodes.length).toBe(KIT_ERROR_CODE_COUNT);
    expect(new Set(internalCodes).size).toBe(KIT_ERROR_CODE_COUNT);
  });

  test("the public union holds exactly the pinned population", () => {
    expect(publicCodes.length).toBe(KIT_ERROR_CODE_COUNT);
    expect(new Set(publicCodes).size).toBe(KIT_ERROR_CODE_COUNT);
  });

  test("every code in the full union has a public projection", () => {
    // Direction one: a code added to `KitErrorPayload` alone. Its throw would be on the encode side
    // of the HTTP codec, and its `detail` would have no shape declared to strip it.
    expect(internalCodes.filter((code) => !publicCodes.includes(code))).toEqual([]);
  });

  test("every code in the public union has a full member", () => {
    // Direction two: a code added to `KitPublicErrorPayload` alone. A gate that only ran the other
    // way would be green here, and half a gate is the shape this repo keeps shipping.
    expect(publicCodes.filter((code) => !internalCodes.includes(code))).toEqual([]);
  });

  test("define exactly the same codes, member for member", () => {
    expect(publicCodes).toEqual(internalCodes);
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

/**
 * **`kitErrorStatus` — the status a code carries when the payload it came from did not survive**
 * (pithy-sh/pithy#365).
 *
 * Every expectation here is a hand-written pair. Reading either half off `KitErrorPayload` would be
 * asking the subject to grade itself: the function is derived from that union, so a test derived
 * from it too would pass on any union at all, including one where every status had moved.
 */
describe("kitErrorStatus", () => {
  test("a kit code answers the status its member pins", () => {
    expect(kitErrorStatus("secrets/already_exists")).toBe(409);
    expect(kitErrorStatus("secrets/invalid_value")).toBe(400);
    expect(kitErrorStatus("core/not_found")).toBe(404);
    expect(kitErrorStatus("cloudflare/request_failed")).toBe(502);
    expect(kitErrorStatus("core/upstream_timeout")).toBe(504);
    expect(kitErrorStatus("core/workflow_failed")).toBe(500);
  });

  test("a code the kit does not define answers nothing, rather than a guess", () => {
    // An adopter's own, a D1 fault class, `classifiedSteps`' word for a throw nothing recognizes, and
    // a typo. None has a pinned status, and inventing one is how a 502 got attached to a 409.
    expect(kitErrorStatus("connect/device_code_expired")).toBeUndefined();
    expect(kitErrorStatus("d1/transient")).toBeUndefined();
    expect(kitErrorStatus("unclassified")).toBeUndefined();
    expect(kitErrorStatus("secrets/already_exsits")).toBeUndefined();
  });

  test("`core/workflow_failed` and `cloudflare/request_failed` are a different pair, both halves", () => {
    // The whole of what #365 fixed, stated as two literals: a Workflow that ran and terminally failed
    // is not the Cloudflare API refusing a call, and neither the code nor the status may say it is.
    expect(kitErrorStatus("core/workflow_failed")).not.toBe(kitErrorStatus("cloudflare/request_failed"));
    expect(kitErrorStatus("core/workflow_failed")).toBe(500);
    expect(kitErrorStatus("cloudflare/request_failed")).toBe(502);
  });
});

describe("ValidationIssue", () => {
  test("validates a field-level failure", () => {
    const issue = ValidationIssue.parse({ path: ["user", 0, "email"], message: "Required", code: "invalid_type" });
    expect(issue.path).toEqual(["user", 0, "email"]);
  });
});

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { classifySendError } from "./errorMapping";

describe("classifySendError", () => {
  test("suppressed recipient is terminal and flags local suppression", () => {
    const c = classifySendError({ code: "E_RECIPIENT_SUPPRESSED", message: "bounced before" });
    expect(c).toMatchObject({ retryable: false, suppressed: true });
    expect(c.error.payload.code).toBe("email/suppressed");
  });

  test("rate and daily limits are retryable and map to the rate-limited error", () => {
    for (const code of ["E_RATE_LIMIT_EXCEEDED", "E_DAILY_LIMIT_EXCEEDED"]) {
      const c = classifySendError({ code });
      expect(c.retryable).toBe(true);
      expect(c.error.payload.code).toBe("email/rate_limited");
    }
  });

  test("transient delivery/server faults are retryable send failures", () => {
    for (const code of ["E_DELIVERY_FAILED", "E_INTERNAL_SERVER_ERROR"]) {
      const c = classifySendError({ code });
      expect(c).toMatchObject({ retryable: true, suppressed: false });
      expect(c.error.payload.code).toBe("email/send_failed");
    }
  });

  test("validation/sender/content codes are terminal", () => {
    for (const code of ["E_VALIDATION_ERROR", "E_SENDER_NOT_VERIFIED", "E_CONTENT_TOO_LARGE", "E_HEADER_NOT_ALLOWED"]) {
      const c = classifySendError({ code });
      expect(c.retryable).toBe(false);
      expect(c.error.payload.code).toBe("email/send_failed");
    }
  });

  test("an unknown error gets one bounded retry and never leaks its raw text publicly", () => {
    const c = classifySendError(new Error("boom"));
    expect(c).toMatchObject({ code: "E_UNKNOWN", retryable: true });
    // The public message is the safe default; the raw cause text only rides in `detail`.
    expect(c.error.payload.message).not.toContain("boom");
    expect(c.error.payload.detail).toContain("E_UNKNOWN");
  });

  test("carries the cause on `detail`, so the row a retry writes is not just the code again", () => {
    // `runSend` wrote `classified.code` into the job's `error` column, which is how a failed magic link
    // came to read `E_UNKNOWN` five times with nothing about why (pithy-sh/pithy#555). The cause was
    // already being composed here and was only reachable through the error object.
    const c = classifySendError({ code: "E_DELIVERY_FAILED", message: "upstream refused" });
    expect(c.detail).toContain("E_DELIVERY_FAILED");
    expect(c.detail).toContain("upstream refused");
    expect(c.detail).toBe(c.error.payload.detail);
  });

  test("a numeric provider code is recorded as itself, not flattened to E_UNKNOWN", () => {
    // Cloudflare answers an unauthorized send with `{ code: 10000, message: "Authentication error" }`
    // (#534 captured the body). Read as E_UNKNOWN it said nothing and was retried; read as itself it
    // names the fault and ends the diagnosis.
    const c = classifySendError({ code: 10000, message: "Authentication error" });
    expect(c.code).toBe("10000");
    expect(c.detail).toContain("Authentication error");
  });

  test("the authentication class is terminal — no retry clears a credential fault", () => {
    // Five attempts against a token for the wrong account is what #555 cost. `10000` is Cloudflare's
    // own answer for a token that cannot send as this domain, and no backoff changes it.
    for (const code of [10000, "E_UNAUTHORIZED", "E_FORBIDDEN"]) {
      expect(classifySendError({ code, message: "Authentication error" }).retryable, String(code)).toBe(false);
    }
  });

  test("an unlisted numeric code keeps its bounded retry — terminal is the auth class, not all numbers", () => {
    // The first shape of this fix made *every* numeric code terminal, which bought the auth case by
    // turning a momentary account-layer fault into a permanent failure on attempt 1. A code nobody here
    // lists is still unknown, and unknown has earned its retry since this module was written.
    expect(classifySendError({ code: 10013, message: "try again" }).retryable).toBe(true);
    expect(classifySendError({ code: 1015, message: "slow down" }).retryable).toBe(true);
  });

  test("an unlisted E_* code stays terminal, exactly as it always has", () => {
    // The other half of that line, and the one a looser rule would have quietly reversed: the binding's
    // undocumented codes are validation/sender/content faults, and retrying one cannot help.
    expect(classifySendError({ code: "E_SOMETHING_NEW", message: "nope" }).retryable).toBe(false);
  });

  test("a coded throw with no message records the code alone, not `[object Object]`", () => {
    // `String(err)` earns its place only where nothing named itself. This string is what the job row and
    // the admin detail route read, so padding it with a stringified object costs the operator a line.
    const c = classifySendError({ code: "E_INVALID_SENDER" });
    expect(c.detail).toBe("email send failed: E_INVALID_SENDER");
    expect(c.detail).not.toContain("[object Object]");
  });

  test("an opaque throw still leaves a trace rather than an empty message", () => {
    expect(classifySendError("just a string").detail).toContain("just a string");
    expect(classifySendError({ weird: true }).detail).toContain("[object Object]");
  });
});

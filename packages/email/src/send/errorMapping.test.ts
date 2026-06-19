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
});

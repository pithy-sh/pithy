// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { EmailRateLimitedError, EmailSendFailedError, EmailSuppressedError } from "../error/errors";

/**
 * Map a Cloudflare Email Service binding error (thrown with an `E_*` `.code`) to a Pithy error and a
 * retry decision. The codes are documented at
 * https://developers.cloudflare.com/email-service/api/send-emails/rest-api/ and in the binding's error
 * table. Retryable codes (rate/quota/transient delivery) are surfaced so the send Workflow re-drives
 * them with backoff; validation/sender/content codes are terminal — retrying cannot help.
 */

/** How a given send error is handled: which Pithy error to raise, and whether the send Workflow retries. */
export interface ClassifiedSendError {
  /** The `E_*` code reported by the binding, or `E_UNKNOWN` when none was present. */
  code: string;
  /** Whether the send should be retried with backoff. */
  retryable: boolean;
  /** Whether the failure means the recipient is suppressed (so the address should be locally suppressed). */
  suppressed: boolean;
  /** The Pithy error carrying the public-safe message and the code/detail for logs. */
  error: PithyError;
}

/** Codes the Email Service retries past — rate, daily quota, and transient delivery/server faults. */
const RETRYABLE = new Set([
  "E_RATE_LIMIT_EXCEEDED",
  "E_DAILY_LIMIT_EXCEEDED",
  "E_DELIVERY_FAILED",
  "E_INTERNAL_SERVER_ERROR",
]);

/** Rate/quota codes map to the dedicated 429 error so the cause reads clearly in logs. */
const RATE_LIMITED = new Set(["E_RATE_LIMIT_EXCEEDED", "E_DAILY_LIMIT_EXCEEDED"]);

/** Read a thrown value's `.code`/`.message` without assuming its shape. */
function readError(err: unknown): { code: string; message: string } {
  if (err && typeof err === "object") {
    const code = "code" in err && typeof err.code === "string" ? err.code : "E_UNKNOWN";
    const message = "message" in err && typeof err.message === "string" ? err.message : "";
    return { code, message };
  }
  return { code: "E_UNKNOWN", message: typeof err === "string" ? err : "" };
}

/**
 * Classify a send failure. `E_RECIPIENT_SUPPRESSED` is terminal and means the address must be
 * suppressed locally too; rate/quota and transient delivery codes are retryable; everything else
 * (validation, sender, content, headers) is terminal. An unknown code is treated as a transient
 * failure so a momentary fault gets one bounded retry rather than failing the job outright.
 */
export function classifySendError(err: unknown): ClassifiedSendError {
  const { code, message } = readError(err);
  const detail = `email send failed: ${code}${message ? ` — ${message}` : ""}`;

  if (code === "E_RECIPIENT_SUPPRESSED") {
    return {
      code,
      retryable: false,
      suppressed: true,
      error: new EmailSuppressedError({ detail }, { cause: err }),
    };
  }

  if (RATE_LIMITED.has(code)) {
    return { code, retryable: true, suppressed: false, error: new EmailRateLimitedError({ detail }, { cause: err }) };
  }

  const retryable = RETRYABLE.has(code) || code === "E_UNKNOWN";
  return { code, retryable, suppressed: false, error: new EmailSendFailedError({ detail }, { cause: err }) };
}

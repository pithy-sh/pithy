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
  /** The `E_*` code reported by the binding, a numeric provider code as a string, or `E_UNKNOWN` for none. */
  code: string;
  /**
   * The cause, as one operator-facing line: the code, whatever the provider said with it, and the sending domain
   * when the code says that domain cannot send.
   *
   * `runSend` writes it to `pithy_email_jobs.error`, so the row names the cause rather than the bare code.
   * Identical to `error.payload.detail`: one composition, two readers, so the row and the log cannot drift.
   * `detail` is stripped at the client boundary, which is where a provider's own words belong.
   */
  detail: string;
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

/**
 * Codes that mean **this Worker could not authenticate** — terminal, because no retry clears a credential.
 *
 * `10000` is Cloudflare's own: a token that is alive but not scoped for Email Sending, or scoped for an
 * account that does not own the sending domain, is answered `{ code: 10000, message: "Authentication
 * error" }` (`liveSend.integration.test.ts` documents the same rejection for a general account token).
 *
 * **Listed rather than inferred from the code being numeric.** Treating every numeric code as terminal would
 * make a momentary numeric failure permanent too — one attempt, `status: "failed"`, where the retry budget
 * applies. A code nobody here recognizes is still unknown, whichever alphabet it is written in, and unknown
 * keeps its bounded retry.
 */
const UNAUTHORIZED = new Set(["10000", "E_UNAUTHORIZED", "E_FORBIDDEN"]);

/**
 * Codes that mean **the sender's domain cannot send**: not onboarded onto Email Service, or not verified.
 * Terminal like every unlisted `E_*`, and named so the job's error says which domain to onboard.
 */
const SENDER_DOMAIN = new Set(["E_SENDER_DOMAIN_NOT_AVAILABLE", "E_SENDER_NOT_VERIFIED"]);

/** The domain half of an address, lowercased, or `null` when it carries none. */
function domainOf(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at < 0 || at === address.length - 1) return null;
  return address
    .slice(at + 1)
    .trim()
    .toLowerCase();
}

/**
 * Whether a code is one of Cloudflare's numeric ones rather than the binding's `E_*` spelling.
 *
 * The distinction decides the retry, so it is a predicate rather than a guess at the call site. An `E_*`
 * code this module does not list stays **terminal**, exactly as it always has — the binding's documented
 * unknowns are validation, sender, content and header faults, and retrying one cannot help. A *numeric*
 * code this module does not list is retryable, because it arrives from the account/REST layer where a
 * momentary fault is ordinary and nothing here has an opinion yet.
 */
function isProviderNumericCode(code: string): boolean {
  return /^[0-9]+$/.test(code);
}

/**
 * Read a thrown value's `.code`/`.message` without assuming its shape.
 *
 * **A numeric code counts.** The Email Service binding surfaces `E_*` strings, but the REST path and the
 * account layer behind it answer with Cloudflare's own numeric codes — an unauthorized send is
 * `{ code: 10000, message: "Authentication error" }`. Read as "no code" that would be `E_UNKNOWN`, which is
 * both silent *and* retryable, so a credential fault would consume every attempt without naming itself.
 *
 * **A value with neither field still leaves a trace.** `String(err)` rather than `""`: an opaque throw is
 * the case where the operator has least to go on. `E_UNKNOWN` remains the code — it means *nothing named
 * itself*, which is the fact that earns the bounded retry.
 */
function readError(err: unknown): { code: string; message: string } {
  if (err && typeof err === "object") {
    const raw = "code" in err ? err.code : undefined;
    const code = typeof raw === "string" && raw !== "" ? raw : typeof raw === "number" ? String(raw) : "E_UNKNOWN";
    // `String(err)` only where nothing named itself. A coded throw carrying no message would otherwise
    // record `E_INVALID_SENDER — [object Object]`, which is the code the operator already had plus noise —
    // and that string is what the job row and the admin detail route now read.
    const named = "message" in err && typeof err.message === "string" ? err.message : "";
    return { code, message: named !== "" ? named : code === "E_UNKNOWN" ? String(err) : "" };
  }
  return { code: "E_UNKNOWN", message: typeof err === "string" ? err : String(err) };
}

/**
 * Classify a send failure. `E_RECIPIENT_SUPPRESSED` is terminal and means the address must be
 * suppressed locally too; rate/quota and transient delivery codes are retryable; everything else
 * (validation, sender, content, headers) is terminal.
 *
 * **An unrecognized code is retryable**: a failure with no code at all keeps its bounded retry, and so does
 * a *numeric* provider code nobody here has listed — see {@link isProviderNumericCode} for why those two are
 * alike and an unlisted `E_*` is not. The **authentication** class is named and terminal: `10000
 * Authentication error` is a token that cannot send as this domain, and no retry changes that — see
 * {@link UNAUTHORIZED} for why that is a list rather than "numeric means permanent".
 *
 * `context.fromAddress` is the job's sender. When the code says its domain cannot send, the detail names the
 * domain, so the operator knows which one to onboard.
 */
export function classifySendError(err: unknown, context: { fromAddress?: string } = {}): ClassifiedSendError {
  const { code, message } = readError(err);
  const domain = SENDER_DOMAIN.has(code) && context.fromAddress ? domainOf(context.fromAddress) : null;
  const detail = `email send failed: ${code}${message ? ` — ${message}` : ""}${
    domain ? ` (${domain} is not set up for sending on Email Service)` : ""
  }`;

  if (code === "E_RECIPIENT_SUPPRESSED") {
    return {
      code,
      detail,
      retryable: false,
      suppressed: true,
      error: new EmailSuppressedError({ detail }, { cause: err }),
    };
  }

  if (RATE_LIMITED.has(code)) {
    return {
      code,
      detail,
      retryable: true,
      suppressed: false,
      error: new EmailRateLimitedError({ detail }, { cause: err }),
    };
  }

  // Three ways to earn a retry, and nothing else: a code documented as transient, no code at all, or a
  // numeric provider code that is not the authentication class. An unlisted `E_*` stays terminal.
  const retryable =
    RETRYABLE.has(code) || code === "E_UNKNOWN" || (isProviderNumericCode(code) && !UNAUTHORIZED.has(code));
  return { code, detail, retryable, suppressed: false, error: new EmailSendFailedError({ detail }, { cause: err }) };
}

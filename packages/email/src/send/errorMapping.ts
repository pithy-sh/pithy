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
   * The cause, as one operator-facing line: the code and whatever the provider said with it.
   *
   * **Exposed because the job row needs it and only the error object had it (pithy-sh/pithy#555).**
   * `runSend` persisted the bare `code` into `pithy_email_jobs.error`, so a magic link that failed five
   * times against a token for the wrong account recorded `E_UNKNOWN` five times and nothing about why —
   * while this exact string, naming `10000 Authentication error`, was being built two lines down and
   * thrown away with the error it decorated. Same family as #534: a failure that discards the cause it
   * was handed.
   *
   * Identical to `error.payload.detail`, deliberately — one composition, two readers, so the row and the
   * log cannot drift. `detail` is stripped at the client boundary, which is where a provider's own words
   * belong.
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
 * error" }` (#534 captured the body; `liveSend.integration.test.ts` documents the same rejection for a
 * general account token). That is the exact failure #555 spent five attempts on in silence.
 *
 * **Named rather than inferred from the code being numeric.** Treating every numeric code as terminal was
 * the first shape of this fix and it bought the auth case by making a *momentary* numeric failure
 * permanent too — one attempt, `status: "failed"`, where the retry budget used to apply. A code nobody
 * here recognizes is still unknown, whichever alphabet it is written in, and unknown has earned its
 * bounded retry since the module was written. So the auth class is listed, and the rule below is
 * unchanged for everything else.
 */
const UNAUTHORIZED = new Set(["10000", "E_UNAUTHORIZED", "E_FORBIDDEN"]);

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
 * **A numeric code counts, and that is not a detail.** The Email Service binding surfaces `E_*` strings,
 * but the REST path and the account layer behind it answer with Cloudflare's own numeric codes — an
 * unauthorized send is `{ code: 10000, message: "Authentication error" }` (#534 captured the body). Read
 * as "no code" that became `E_UNKNOWN`, which is both silent *and* retryable, so a credential fault
 * consumed every attempt without ever naming itself (#555).
 *
 * **And a value with neither field still leaves a trace.** `String(err)` rather than `""`: an opaque
 * throw is the case where the operator has least to go on, so an empty string is the one answer that
 * cannot help. `E_UNKNOWN` remains the code — it means *nothing named itself*, which is the fact that
 * earns the bounded retry.
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
 * **An unrecognized code is retryable, and that is deliberately unchanged.** A failure this module has
 * no code at all keeps its bounded retry, and so does a *numeric* provider code nobody here has listed —
 * see {@link isProviderNumericCode} for why those two are alike and an unlisted `E_*` is not.
 *
 * What changed for #555 is that the **authentication** class is now named and terminal: `10000
 * Authentication error` is a token that cannot send as this domain, and spending five attempts on it in
 * silence is what hid the whole incident. See {@link UNAUTHORIZED} for why that is a list rather than
 * "numeric means permanent" — the latter was this fix's first shape, and it made a momentary numeric
 * failure permanent as a side effect.
 */
export function classifySendError(err: unknown): ClassifiedSendError {
  const { code, message } = readError(err);
  const detail = `email send failed: ${code}${message ? ` — ${message}` : ""}`;

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

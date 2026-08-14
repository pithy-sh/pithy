// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import { classifyWorkflowFault } from "@pithy-sh/core/src/workflow/faults";
import { describe, expect, test } from "vitest";
import { EmailInvalidPayloadError, EmailTemplateNotFoundError } from "../error/errors";
import { classifySendError } from "./errorMapping";
import { emailWorkflowRetry } from "./retryPolicy";

/**
 * The two classifications email owns have to agree, or one of them is decoration.
 *
 * `classifySendError` decides whether a send is worth another try; `emailWorkflowRetry` decides whether
 * the step re-drives the body that threw. `runSend` throws the classified error exactly when the first
 * said retryable, so a code the provider table calls transient and the policy calls terminal would be a
 * send that stops on a fault that was about to clear — and the reverse would be a step backing off over
 * a rejected sender address.
 */

/** The codes `runSend` actually re-throws — the ones `classifySendError` judged worth another attempt. */
const THROWN = ["E_RATE_LIMIT_EXCEEDED", "E_DAILY_LIMIT_EXCEEDED", "E_DELIVERY_FAILED", "E_INTERNAL_SERVER_ERROR"];

describe("the email send classification", () => {
  test.each(THROWN)("%s is retryable in the provider table and retried by the step", (code) => {
    const classified = classifySendError({ code, message: "from the binding" });
    expect(classified.retryable).toBe(true);
    expect(classifyWorkflowFault(classified.error, emailWorkflowRetry).disposition).toBe("retry");
  });

  test("an unknown code gets its one bounded retry on both layers", () => {
    const classified = classifySendError(new Error("something else"));
    expect(classified.retryable).toBe(true);
    expect(classifyWorkflowFault(classified.error, emailWorkflowRetry).disposition).toBe("retry");
  });

  // A validation, sender or content code is terminal in `classifySendError` and takes `runSend`'s
  // failed branch, which records the outcome and returns rather than throwing — so no step ever sees
  // one. That is the half this file cannot assert, and `runSend.workers.test.ts` does: "a terminal send
  // code is never thrown". Both codes land on `email/send_failed`, so the policy alone cannot tell them
  // apart; the throw site is what keeps them apart, and it is tested there.
  test("a terminal send code is not thrown, and says so", () => {
    expect(classifySendError({ code: "E_INVALID_SENDER" }).retryable).toBe(false);
  });

  test("a job row that is gone is terminal", () => {
    expect(classifyWorkflowFault(new NotFoundError({ detail: "job" }), emailWorkflowRetry).disposition).toBe(
      "terminal",
    );
  });

  test("a render that cannot succeed is terminal", () => {
    expect(
      classifyWorkflowFault(new EmailTemplateNotFoundError({ detail: "welcome" }), emailWorkflowRetry).disposition,
    ).toBe("terminal");
    expect(
      classifyWorkflowFault(new EmailInvalidPayloadError({ detail: "payload" }), emailWorkflowRetry).disposition,
    ).toBe("terminal");
  });

  test("a transient D1 fault is retried without email naming it", () => {
    expect(classifyWorkflowFault(new Error("Network connection lost"), emailWorkflowRetry).disposition).toBe("retry");
  });
});

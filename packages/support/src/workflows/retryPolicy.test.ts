// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { UpstreamError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { classifiedSteps, classifyWorkflowFault } from "@pithy-sh/core/src/workflow/faults";
import { describe, expect, test } from "vitest";
import {
  SupportClassificationError,
  SupportInvalidCategoryError,
  SupportNotFoundError,
  SupportRejectedError,
} from "../error/errors";
import { supportWorkflowRetry } from "./retryPolicy";

/** A terminal-error class standing in for the platform's `NonRetryableError`. */
class Terminal extends Error {}

/** A runner with the platform's rule: re-drive a body unless it raised the terminal error. */
function retryingStep(maxAttempts: number): {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  attempts: number;
} {
  const runner = {
    attempts: 0,
    async do<T>(_name: string, fn: () => Promise<T>): Promise<T> {
      let last: unknown;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        runner.attempts += 1;
        try {
          return await fn();
        } catch (error) {
          if (error instanceof Terminal) throw error;
          last = error;
        }
      }
      throw last;
    },
  };
  return runner;
}

describe("the support classification's own classification", () => {
  test("a model that did not answer at all is retried — classification is idempotent", () => {
    const fault = classifyWorkflowFault(new UpstreamError({ detail: "Workers AI rejected" }), supportWorkflowRetry);
    expect(fault.disposition).toBe("retry");
    expect(fault.code).toBe("core/upstream_failed");
  });

  test("a transient D1 fault is retried without support naming it", () => {
    expect(classifyWorkflowFault(new Error("D1_ERROR: database is locked"), supportWorkflowRetry).disposition).toBe(
      "retry",
    );
  });

  test("an absent AI binding is terminal — a binding does not appear on the fourth attempt", () => {
    const fault = classifyWorkflowFault(new SupportClassificationError({ detail: "no AI" }), supportWorkflowRetry);
    expect(fault.disposition).toBe("terminal");
    expect(fault.code).toBe("support/classification_failed");
  });

  test("a thread that is gone, a taxonomy that will not validate, and a guard refusal are terminal", () => {
    for (const error of [
      new SupportNotFoundError({ detail: "t1" }),
      new SupportInvalidCategoryError({ detail: "Bad Key" }),
      new SupportRejectedError({ detail: "over volume" }),
      new ValidationError({ detail: "messageId" }),
    ]) {
      expect(classifyWorkflowFault(error, supportWorkflowRetry).disposition).toBe("terminal");
    }
  });

  test("an absent binding fails the step on its first attempt, not after five", async () => {
    const step = retryingStep(5);
    const steps = classifiedSteps(step, supportWorkflowRetry, Terminal);
    await expect(
      steps.do("classify-m1", async () => {
        throw new SupportClassificationError({ detail: "no AI" });
      }),
    ).rejects.toBeInstanceOf(Terminal);
    expect(step.attempts).toBe(1);
  });

  test("an unreachable model re-drives the classification", async () => {
    const step = retryingStep(3);
    const steps = classifiedSteps(step, supportWorkflowRetry, Terminal);
    await expect(
      steps.do("classify-m1", async () => {
        throw new UpstreamError({ detail: "Workers AI rejected" });
      }),
    ).rejects.toBeInstanceOf(UpstreamError);
    expect(step.attempts).toBe(3);
  });
});

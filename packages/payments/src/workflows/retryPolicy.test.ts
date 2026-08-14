// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { classifiedSteps, classifyWorkflowFault } from "@pithy-sh/core/src/workflow/faults";
import { describe, expect, test } from "vitest";
import {
  PaymentsEnvironmentMismatchError,
  PaymentsProductNotFoundError,
  PaymentsProviderUnavailableError,
} from "../error/errors";
import { paymentsWorkflowRetry } from "./retryPolicy";

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

describe("the payments reconcile classification", () => {
  test("a store that cannot be reached is retried — the page is idempotent", () => {
    const fault = classifyWorkflowFault(
      new PaymentsProviderUnavailableError({ detail: "apple 503" }),
      paymentsWorkflowRetry,
    );
    expect(fault.disposition).toBe("retry");
  });

  test("a transient D1 fault is retried without payments naming it", () => {
    expect(classifyWorkflowFault(new Error("D1_ERROR: storage timeout"), paymentsWorkflowRetry).disposition).toBe(
      "retry",
    );
  });

  test("a store's own refusal about a purchase is terminal", () => {
    expect(
      classifyWorkflowFault(new PaymentsProductNotFoundError({ detail: "sku" }), paymentsWorkflowRetry).disposition,
    ).toBe("terminal");
    expect(
      classifyWorkflowFault(new PaymentsEnvironmentMismatchError({ detail: "sandbox" }), paymentsWorkflowRetry)
        .disposition,
    ).toBe("terminal");
  });

  test("parameters that will not validate are terminal — the payload does not change on a retry", () => {
    expect(classifyWorkflowFault(new ValidationError({ detail: "pageSize" }), paymentsWorkflowRetry).disposition).toBe(
      "terminal",
    );
  });

  test("a terminal fault fails the page on its first attempt", async () => {
    const step = retryingStep(5);
    const steps = classifiedSteps(step, paymentsWorkflowRetry, Terminal);
    await expect(
      steps.do("page-000001", async () => {
        throw new PaymentsProductNotFoundError({ detail: "sku" });
      }),
    ).rejects.toBeInstanceOf(Terminal);
    expect(step.attempts).toBe(1);
  });

  test("an unreachable store re-drives the page", async () => {
    const step = retryingStep(3);
    const steps = classifiedSteps(step, paymentsWorkflowRetry, Terminal);
    await expect(
      steps.do("page-000001", async () => {
        throw new PaymentsProviderUnavailableError({ detail: "apple 503" });
      }),
    ).rejects.toBeInstanceOf(PaymentsProviderUnavailableError);
    expect(step.attempts).toBe(3);
  });
});

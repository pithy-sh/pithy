// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { classifiedSteps, classifyWorkflowFault } from "@pithy-sh/core/src/workflow/faults";
import { describe, expect, test } from "vitest";
import {
  TestersCohortClosedError,
  TestersCohortNotFoundError,
  TestersNotConfiguredError,
  TestersWithdrawnError,
} from "../error/errors";
import { testersWorkflowRetry } from "./retryPolicy";

/**
 * **The empty record is the assertion.** The pass retries none of its own codes, and that is only a
 * decision if something proves D1 still re-drives while a closed cohort does not (pithy-sh/pithy#348).
 */

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

describe("the daily pass classification", () => {
  test("a transient D1 fault is retried, and testers never names it — core owns that vocabulary", () => {
    expect(classifyWorkflowFault(new Error("D1_ERROR: database is busy"), testersWorkflowRetry).disposition).toBe(
      "retry",
    );
    expect(testersWorkflowRetry.retryable).toEqual({});
  });

  test("a closed cohort is terminal — the refusal is the capability working", () => {
    const fault = classifyWorkflowFault(new TestersCohortClosedError({ detail: "c1" }), testersWorkflowRetry);
    expect(fault.disposition).toBe("terminal");
    expect(fault.code).toBe("testers/cohort_closed");
  });

  test("a cohort deleted between the enumeration and its own step is terminal", () => {
    expect(
      classifyWorkflowFault(new TestersCohortNotFoundError({ detail: "c1" }), testersWorkflowRetry).disposition,
    ).toBe("terminal");
  });

  test("a tester's own withdrawal is terminal — a person's decision is not weather", () => {
    expect(classifyWorkflowFault(new TestersWithdrawnError({ detail: "t1" }), testersWorkflowRetry).disposition).toBe(
      "terminal",
    );
  });

  test("missing configuration is terminal, and parameters that will not validate are too", () => {
    expect(
      classifyWorkflowFault(new TestersNotConfiguredError({ detail: "baseUrl" }), testersWorkflowRetry).disposition,
    ).toBe("terminal");
    expect(classifyWorkflowFault(new ValidationError({ detail: "cohortId" }), testersWorkflowRetry).disposition).toBe(
      "terminal",
    );
  });

  test("a closed cohort loses its step on the first attempt, not after five", async () => {
    const step = retryingStep(5);
    const steps = classifiedSteps(step, testersWorkflowRetry, Terminal);
    await expect(
      steps.do("cohort-c1", async () => {
        throw new TestersCohortClosedError({ detail: "c1" });
      }),
    ).rejects.toBeInstanceOf(Terminal);
    expect(step.attempts).toBe(1);
  });

  test("a busy database still re-drives a cohort's step", async () => {
    const step = retryingStep(3);
    const steps = classifiedSteps(step, testersWorkflowRetry, Terminal);
    await expect(
      steps.do("cohort-c1", async () => {
        throw new Error("D1_ERROR: database is busy");
      }),
    ).rejects.toThrow("database is busy");
    expect(step.attempts).toBe(3);
  });
});

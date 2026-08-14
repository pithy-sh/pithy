// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { classifiedSteps, classifyWorkflowFault } from "@pithy-sh/core/src/workflow/faults";
import { describe, expect, test } from "vitest";
import { StorageMultipartFailedError, StorageNotFoundError, StorageQuotaExceededError } from "../error/errors";
import { storageWorkflowRetry } from "./retryPolicy";

/**
 * **The empty record is the assertion.** A sweep that retries none of its own codes is a decision only
 * if something proves D1 still re-drives and every `storage/*` refusal does not (pithy-sh/pithy#348).
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

describe("the storage sweep classification", () => {
  test("a transient D1 fault is retried, and storage never names it — core owns that vocabulary", () => {
    expect(classifyWorkflowFault(new Error("D1_ERROR: storage timeout"), storageWorkflowRetry).disposition).toBe(
      "retry",
    );
    expect(storageWorkflowRetry.retryable).toEqual({});
  });

  test("every storage refusal is terminal — each belongs to a request the sweep never makes", () => {
    for (const error of [
      new StorageNotFoundError({ detail: "obj/1" }),
      new StorageQuotaExceededError({ detail: "over" }),
      new StorageMultipartFailedError({ detail: "part 3" }),
    ]) {
      expect(classifyWorkflowFault(error, storageWorkflowRetry).disposition).toBe("terminal");
    }
  });

  test("sweep parameters an operator dispatched by hand are terminal", () => {
    expect(classifyWorkflowFault(new ValidationError({ detail: "maxPages" }), storageWorkflowRetry).disposition).toBe(
      "terminal",
    );
  });

  test("a terminal fault fails the sweep on its first attempt, so the next cron carries the whole job", async () => {
    const step = retryingStep(5);
    const steps = classifiedSteps(step, storageWorkflowRetry, Terminal);
    await expect(
      steps.do("sweep", async () => {
        throw new ValidationError({ detail: "maxPages" });
      }),
    ).rejects.toBeInstanceOf(Terminal);
    expect(step.attempts).toBe(1);
  });

  test("a busy database still re-drives the sweep", async () => {
    const step = retryingStep(3);
    const steps = classifiedSteps(step, storageWorkflowRetry, Terminal);
    await expect(
      steps.do("sweep", async () => {
        throw new Error("D1_ERROR: database is locked");
      }),
    ).rejects.toThrow("database is locked");
    expect(step.attempts).toBe(3);
  });
});

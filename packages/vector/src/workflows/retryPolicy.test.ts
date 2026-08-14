// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError, UpstreamError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { classifiedSteps, classifyWorkflowFault } from "@pithy-sh/core/src/workflow/faults";
import { describe, expect, test } from "vitest";
import {
  VectorDimensionMismatchError,
  VectorIndexNotFoundError,
  VectorMetadataIndexDriftError,
  VectorUnfilterableFieldError,
} from "../error/errors";
import { vectorWorkflowRetry } from "./retryPolicy";

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

describe("the reprocess classification", () => {
  test("an embedding model that did not answer is retried — a page is idempotent until its upsert lands", () => {
    const fault = classifyWorkflowFault(new UpstreamError({ detail: "Workers AI rejected" }), vectorWorkflowRetry);
    expect(fault.disposition).toBe("retry");
    expect(fault.code).toBe("core/upstream_failed");
  });

  test("a transient D1 fault is retried without vector naming it", () => {
    expect(classifyWorkflowFault(new Error("D1_ERROR: storage timeout"), vectorWorkflowRetry).disposition).toBe(
      "retry",
    );
  });

  test("a model pinned to the wrong dimensions is terminal — a config error caught on page one", () => {
    const fault = classifyWorkflowFault(
      new VectorDimensionMismatchError({ detail: "768 vs 1024" }),
      vectorWorkflowRetry,
    );
    expect(fault.disposition).toBe("terminal");
    expect(fault.code).toBe("vector/dimension_mismatch");
  });

  test("a missing index, a drifted metadata index, and an unfilterable field are all terminal", () => {
    for (const error of [
      new VectorIndexNotFoundError({ detail: "docs" }),
      new VectorMetadataIndexDriftError({ detail: "tenant" }),
      new VectorUnfilterableFieldError({ detail: "tenant" }),
    ]) {
      expect(classifyWorkflowFault(error, vectorWorkflowRetry).disposition).toBe("terminal");
    }
  });

  test("a shape nobody recognises is terminal — a shape is not a transient", () => {
    expect(classifyWorkflowFault(new InternalError({ detail: "unexpected" }), vectorWorkflowRetry).disposition).toBe(
      "terminal",
    );
    expect(classifyWorkflowFault(new ValidationError({ detail: "topK" }), vectorWorkflowRetry).disposition).toBe(
      "terminal",
    );
  });

  test("a wrong-dimension model fails page one on the first attempt, not the fifth", async () => {
    const step = retryingStep(5);
    const steps = classifiedSteps(step, vectorWorkflowRetry, Terminal);
    await expect(
      steps.do("page-1", async () => {
        throw new VectorDimensionMismatchError({ detail: "768 vs 1024" });
      }),
    ).rejects.toBeInstanceOf(Terminal);
    expect(step.attempts).toBe(1);
  });

  test("an unreachable model re-drives the page", async () => {
    const step = retryingStep(3);
    const steps = classifiedSteps(step, vectorWorkflowRetry, Terminal);
    await expect(
      steps.do("page-1", async () => {
        throw new UpstreamError({ detail: "Workers AI rejected" });
      }),
    ).rejects.toBeInstanceOf(UpstreamError);
    expect(step.attempts).toBe(3);
  });
});

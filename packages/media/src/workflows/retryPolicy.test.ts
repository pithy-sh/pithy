// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { CloudflareInvalidResponseError, CloudflareRequestError } from "@pithy-sh/cloudflare/src/client/errors";
import { UpstreamError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { classifiedSteps, classifyWorkflowFault } from "@pithy-sh/core/src/workflow/faults";
import { describe, expect, test } from "vitest";
import { MediaEnrichmentError, MediaNotFoundError, MediaStorageError, MediaUnsupportedError } from "../error/errors";
import { mediaWorkflowRetry } from "./retryPolicy";

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

describe("the enrichment classification", () => {
  test("a model that did not answer is retried — the enrichment is started once and never again", () => {
    const fault = classifyWorkflowFault(new UpstreamError({ detail: "Workers AI rejected" }), mediaWorkflowRetry);
    expect(fault.disposition).toBe("retry");
    expect(fault.code).toBe("core/upstream_failed");
  });

  test("an unreachable Stream API is retried — the read is idempotent", () => {
    expect(
      classifyWorkflowFault(new CloudflareRequestError({ detail: "stream 503" }), mediaWorkflowRetry).disposition,
    ).toBe("retry");
  });

  test("an enrichment fault is retried, because a video still encoding has no HLS audio yet", () => {
    const fault = classifyWorkflowFault(
      new MediaEnrichmentError({ detail: "video v1 has no HLS playback URL yet" }),
      mediaWorkflowRetry,
    );
    expect(fault.disposition).toBe("retry");
    expect(fault.reason).toContain("encoding");
  });

  test("a transient D1 fault is retried without media naming it", () => {
    expect(classifyWorkflowFault(new Error("D1_ERROR: storage timeout"), mediaWorkflowRetry).disposition).toBe("retry");
  });

  test("a record that is gone, or a type enrichment cannot read, is terminal", () => {
    expect(classifyWorkflowFault(new MediaNotFoundError({ detail: "m1" }), mediaWorkflowRetry).disposition).toBe(
      "terminal",
    );
    expect(classifyWorkflowFault(new MediaUnsupportedError({ detail: "tiff" }), mediaWorkflowRetry).disposition).toBe(
      "terminal",
    );
  });

  test("a Stream response that did not match its schema is terminal — a shape is not an outage", () => {
    expect(
      classifyWorkflowFault(new CloudflareInvalidResponseError({ detail: "no result" }), mediaWorkflowRetry)
        .disposition,
    ).toBe("terminal");
  });

  test("a storage-plane refusal and an invalid payload are terminal", () => {
    expect(classifyWorkflowFault(new MediaStorageError({ detail: "presign" }), mediaWorkflowRetry).disposition).toBe(
      "terminal",
    );
    expect(classifyWorkflowFault(new ValidationError({ detail: "config" }), mediaWorkflowRetry).disposition).toBe(
      "terminal",
    );
  });

  test("a record that is gone fails the step on its first attempt", async () => {
    const step = retryingStep(5);
    const steps = classifiedSteps(step, mediaWorkflowRetry, Terminal);
    await expect(
      steps.do("image-to-text-m1", async () => {
        throw new MediaNotFoundError({ detail: "m1" });
      }),
    ).rejects.toBeInstanceOf(Terminal);
    expect(step.attempts).toBe(1);
  });

  test("an unreachable model re-drives the enrichment", async () => {
    const step = retryingStep(3);
    const steps = classifiedSteps(step, mediaWorkflowRetry, Terminal);
    await expect(
      steps.do("image-to-text-m1", async () => {
        throw new UpstreamError({ detail: "Workers AI rejected" });
      }),
    ).rejects.toBeInstanceOf(UpstreamError);
    expect(step.attempts).toBe(3);
  });
});

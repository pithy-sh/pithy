// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { classifiedSteps, classifyWorkflowFault } from "@pithy-sh/core/src/workflow/faults";
import { describe, expect, test } from "vitest";
import { LeaderboardBoardNotFoundError, LeaderboardInvalidScheduleError } from "../error/errors";
import { leaderboardWorkflowRetry } from "./retryPolicy";

/**
 * **The empty record is the assertion.** A policy that retries nothing of its own is only a decision if
 * something proves that D1 still re-drives and that leaderboard's own codes do not — otherwise it reads
 * exactly like a file nobody finished (pithy-sh/pithy#348).
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

describe("the rank refresh classification", () => {
  test("a transient D1 fault is retried, and leaderboard never names it — core owns that vocabulary", () => {
    for (const message of [
      "D1_ERROR: database is locked",
      "D1_ERROR: storage timeout",
      "Network connection lost",
      "the object was reset because its code was updated",
    ]) {
      expect(classifyWorkflowFault(new Error(message), leaderboardWorkflowRetry).disposition).toBe("retry");
    }
    expect(leaderboardWorkflowRetry.retryable).toEqual({});
  });

  test("a board's window schedule that will not parse is terminal — it is config, not weather", () => {
    const fault = classifyWorkflowFault(
      new LeaderboardInvalidScheduleError({ detail: "weekly" }),
      leaderboardWorkflowRetry,
    );
    expect(fault.disposition).toBe("terminal");
    expect(fault.code).toBe("leaderboard/invalid_schedule");
  });

  test("a row the materializer refuses is terminal — deterministic in what it read", () => {
    expect(classifyWorkflowFault(new ValidationError({ detail: "cursor" }), leaderboardWorkflowRetry).disposition).toBe(
      "terminal",
    );
  });

  test("a submit-path refusal reaching a refresh is terminal — it is a bug, and a bug should surface", () => {
    expect(
      classifyWorkflowFault(new LeaderboardBoardNotFoundError({ detail: "weekly" }), leaderboardWorkflowRetry)
        .disposition,
    ).toBe("terminal");
  });

  test("a terminal fault fails the step on its first attempt, so the lock is released this interval", async () => {
    const step = retryingStep(5);
    const steps = classifiedSteps(step, leaderboardWorkflowRetry, Terminal);
    await expect(
      steps.do("prune", async () => {
        throw new LeaderboardInvalidScheduleError({ detail: "weekly" });
      }),
    ).rejects.toBeInstanceOf(Terminal);
    expect(step.attempts).toBe(1);
  });

  test("a busy database still re-drives the step", async () => {
    const step = retryingStep(3);
    const steps = classifiedSteps(step, leaderboardWorkflowRetry, Terminal);
    await expect(
      steps.do("refresh:weekly:0", async () => {
        throw new Error("D1_ERROR: database is locked");
      }),
    ).rejects.toThrow("database is locked");
    expect(step.attempts).toBe(3);
  });
});

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { ConflictError, RateLimitError, UpstreamError, UpstreamTimeoutError } from "../error/pithyError";
import { classifiedSteps, classifyWorkflowFault, type WorkflowRetryPolicy } from "./faults";

/** A policy with one retryable code, so both dispositions are exercised against a real statement. */
const policy: WorkflowRetryPolicy = {
  capability: "test",
  retryable: {
    "core/upstream_timeout": "The dependency ran out of time; the next attempt may reach it.",
  },
};

/** A terminal-error class standing in for the platform's `NonRetryableError`. */
class Terminal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}

/** A step runner that records every attempt, and re-drives a body that throws anything but `Terminal`. */
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
          // The platform's rule: a `NonRetryableError` fails the instance immediately.
          if (error instanceof Terminal) throw error;
          last = error;
        }
      }
      throw last;
    },
  };
  return runner;
}

describe("classifyWorkflowFault", () => {
  test("a code the policy states is retryable retries, carrying the stated reason", () => {
    const fault = classifyWorkflowFault(new UpstreamTimeoutError({ detail: "d" }), policy);
    expect(fault.disposition).toBe("retry");
    expect(fault.code).toBe("core/upstream_timeout");
    expect(fault.reason).toBe("The dependency ran out of time; the next attempt may reach it.");
  });

  test("a PithyError the policy does not state is terminal", () => {
    const fault = classifyWorkflowFault(new ConflictError({ detail: "d" }), policy);
    expect(fault.disposition).toBe("terminal");
    expect(fault.code).toBe("core/conflict");
  });

  test("a code stated by another capability's policy is still terminal here", () => {
    const fault = classifyWorkflowFault(new UpstreamError({ detail: "d" }), policy);
    expect(fault.disposition).toBe("terminal");
  });

  test("a transient D1 fault retries without the policy naming it — core owns that vocabulary", () => {
    const fault = classifyWorkflowFault(new Error("D1_ERROR: database is locked"), policy);
    expect(fault.disposition).toBe("retry");
    expect(fault.code).toBe("d1/database-busy");
  });

  test("a D1 fault withD1Retry classifies non-transient is terminal — the step does not re-retry it", () => {
    const fault = classifyWorkflowFault(new Error("D1_ERROR: NOT NULL constraint failed: users.email"), policy);
    expect(fault.disposition).toBe("terminal");
  });

  test("an unclassified throw is terminal — retry is opted into, never inherited", () => {
    const fault = classifyWorkflowFault(new TypeError("x is not a function"), policy);
    expect(fault.disposition).toBe("terminal");
    expect(fault.code).toBe("unclassified");
  });

  test("a thrown non-error is terminal", () => {
    expect(classifyWorkflowFault("nope", policy).disposition).toBe("terminal");
  });
});

describe("classifiedSteps", () => {
  test("a terminal fault fails on the first attempt", async () => {
    const step = retryingStep(5);
    const steps = classifiedSteps(step, policy, Terminal);

    await expect(
      steps.do("write", async () => {
        throw new ConflictError({ message: "Already there.", detail: "second write" });
      }),
    ).rejects.toBeInstanceOf(Terminal);
    expect(step.attempts).toBe(1);
  });

  test("the terminal error names the code and keeps the original as its cause", async () => {
    const step = retryingStep(5);
    const steps = classifiedSteps(step, policy, Terminal);
    const original = new ConflictError({ message: "Already there.", detail: "second write" });

    const thrown = await steps
      .do("write", async () => {
        throw original;
      })
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(Terminal);
    expect((thrown as Error).message).toBe("core/conflict: Already there.");
    expect((thrown as Error).cause).toBe(original);
  });

  test("a retryable fault is re-thrown untouched, so the platform re-drives it", async () => {
    const step = retryingStep(3);
    const steps = classifiedSteps(step, policy, Terminal);

    await expect(
      steps.do("call", async () => {
        throw new UpstreamTimeoutError({ detail: "upstream" });
      }),
    ).rejects.toBeInstanceOf(UpstreamTimeoutError);
    expect(step.attempts).toBe(3);
  });

  test("a rate limit is retryable only where the policy says so", async () => {
    const step = retryingStep(2);
    const steps = classifiedSteps(step, policy, Terminal);

    await expect(
      steps.do("send", async () => {
        throw new RateLimitError({ detail: "429" });
      }),
    ).rejects.toBeInstanceOf(Terminal);
    expect(step.attempts).toBe(1);
  });

  test("a step that succeeds returns its value and is not re-driven", async () => {
    const step = retryingStep(3);
    const steps = classifiedSteps(step, policy, Terminal);
    expect(await steps.do("read", async () => "value")).toBe("value");
    expect(step.attempts).toBe(1);
  });

  test("the classification runs inside the step, not around it", async () => {
    // Proof the wrapper cannot be moved outside `step.do`: the runner below never sees a body that
    // throws, because the wrapper converts the fault before the platform's retry loop reads it.
    const seen: string[] = [];
    const step = {
      async do<T>(name: string, fn: () => Promise<T>): Promise<T> {
        try {
          return await fn();
        } catch (error) {
          seen.push(`${name}:${(error as Error).name}`);
          throw error;
        }
      },
    };
    const steps = classifiedSteps(step, policy, Terminal);
    await expect(
      steps.do("write", async () => {
        throw new ConflictError({ detail: "d" });
      }),
    ).rejects.toBeInstanceOf(Terminal);
    expect(seen).toEqual(["write:NonRetryableError"]);
  });
});

/** The text a terminal step throws for one fault — the whole of what crosses the boundary. */
async function terminalText(thrown: unknown): Promise<string> {
  const steps = classifiedSteps(retryingStep(5), policy, Terminal);
  const error = await steps
    .do("write", async () => {
      throw thrown;
    })
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Terminal);
  return (error as Error).message;
}

describe("what a terminal step carries across the boundary", () => {
  test("the remedy rides with the sentence, on the separator core states", async () => {
    const text = await terminalText(
      new ConflictError({ message: "Already there.", action: "Use `update` instead.", detail: "second write" }),
    );
    expect(text).toBe("core/conflict: Already there.\nUse `update` instead.");
  });

  test("a fault stating no remedy leaves nothing after the sentence", async () => {
    const text = await terminalText(new ConflictError({ message: "Already there.", detail: "second write" }));
    expect(text).toBe("core/conflict: Already there.");
    expect(text).not.toContain("\n");
    expect(text).not.toContain("undefined");
  });

  test("a `PithyError` from a second copy of core still carries its remedy — the read is structural", async () => {
    // `instanceof` is per module instance. A bundler handing a host Worker two copies of core must not
    // silently drop the remedy, which is the bug this whole file exists downstream of.
    const foreign = Object.assign(new Error("Already there."), {
      payload: { code: "core/conflict", message: "Already there.", action: "Use `update` instead." },
    });
    expect(await terminalText(foreign)).toBe("core/conflict: Already there.\nUse `update` instead.");
  });

  test("`detail` does not cross, and there is no field for it to cross in", async () => {
    const secret = "DETAIL-MUST-NOT-CROSS-3f9a2";
    const text = await terminalText(
      new ConflictError({
        message: "Already there.",
        action: "Use `update` instead.",
        detail: `second write of ${secret}`,
      }),
    );
    expect(text).not.toContain(secret);
    expect(text).toBe("core/conflict: Already there.\nUse `update` instead.");
  });
});

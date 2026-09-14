// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test, vi } from "vitest";
import { withErrorReporting } from "./output";
import { commandProgress, formatStep, narrate, settleStep, startStep } from "./progress";

/** Everything one body wrote to stdout, with the spy put back either way. */
async function captured(work: () => Promise<void>): Promise<string> {
  const written: string[] = [];
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  }) as never);
  try {
    await work();
  } finally {
    stdout.mockRestore();
  }
  return written.join("");
}

describe("the shared progress seam", () => {
  test("a step is a plain line, never an escape code", () => {
    expect(formatStep("acme-staging-email")).toBe("▸ acme-staging-email...");
    expect(formatStep("acme-staging-email")).not.toContain("\u001b");
  });

  /**
   * **The gate is `--json` and only `--json` (#531, #578).** Not the TTY: a run in CI is the run whose
   * log most needs to say where it got to, and these are plain lines rather than an animation, so a
   * redirected stdout takes them unharmed.
   */
  test("--json has no sink at all, because a machine reads exactly one line", () => {
    expect(commandProgress({ json: true })).toBeUndefined();
  });

  test("a sink writes the step, then whatever the unit settled as", async () => {
    const progress = commandProgress({ json: false });
    expect(progress).toBeDefined();
    const out = await captured(async () => {
      progress?.({ phase: "start", what: "acme-staging-email" });
      progress?.({ phase: "settled", line: "acme-staging-email: deployed." });
    });

    expect(out).toBe("▸ acme-staging-email...\nacme-staging-email: deployed.\n");
  });
});

describe("narration reaches a producer that never heard of the command", () => {
  /**
   * The whole point of the ambient sink: `capabilities/hostDeploy.ts` narrates the wrangler spawn, and
   * `pithy email provision` reaches it through two kit packages that carry no progress parameter. A
   * thread-it-through seam would have stopped at the first package boundary, which is exactly how
   * `deploy` missed #531.
   */
  test("a step raised inside a narrated span reaches the span's sink", async () => {
    const events: string[] = [];
    await narrate(
      (event) => events.push(event.phase === "start" ? `start ${event.what}` : `settled ${event.line}`),
      async () => {
        startStep("acme-staging-email");
        settleStep("acme-staging-email: deployed.");
      },
    );

    expect(events).toEqual(["start acme-staging-email", "settled acme-staging-email: deployed."]);
  });

  test("a step raised outside any span is silent rather than fatal", async () => {
    const out = await captured(async () => {
      startStep("nobody-is-listening");
      settleStep("nobody-is-listening: deployed.");
    });

    expect(out).toBe("");
  });

  /** A span that was handed no sink silences its producers, whatever an enclosing span installed. */
  test("no sink means silence, even nested inside one that narrates", async () => {
    const events: string[] = [];
    await narrate(
      (event) => events.push(event.phase === "start" ? event.what : event.line),
      async () => {
        await narrate(undefined, async () => startStep("quiet"));
        startStep("loud");
      },
    );

    expect(events).toEqual(["loud"]);
  });
});

/**
 * **Where a command inherits narration: the one wrapper every command body already goes through.**
 *
 * #578's finding is that a seam nobody is obliged to reach for is a seam the second long command does
 * not inherit. `withErrorReporting` is the wrapper `commands/*.ts` all write, and it already takes the
 * one thing the gate consults — so a command written next year narrates without deciding to.
 */
describe("withErrorReporting installs the narration", () => {
  test("a command body narrates, without wiring anything", async () => {
    const out = await captured(() =>
      withErrorReporting(false, async () => {
        startStep("acme-staging-email");
        settleStep("acme-staging-email: deployed.");
      }),
    );

    expect(out).toBe("▸ acme-staging-email...\nacme-staging-email: deployed.\n");
  });

  test("--json narrates nothing, so the one machine-readable line stays the only line", async () => {
    const out = await captured(() =>
      withErrorReporting(true, async () => {
        startStep("acme-staging-email");
        settleStep("acme-staging-email: deployed.");
        process.stdout.write('{"command":"deploy"}\n');
      }),
    );

    expect(out).toBe('{"command":"deploy"}\n');
    expect(out.trimEnd().split("\n")).toHaveLength(1);
  });
});

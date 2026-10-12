// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test, vi } from "vitest";
import { formatJsonLine, latchJsonFormat, withErrorReporting } from "./output";
import { commandProgress, formatStep, narrate, progressRecord, settleStep, startStep } from "./progress";

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

/**
 * **`--json --events`: the one exception to one line (#697).** `deploy` and `provision` can run for minutes,
 * and a long run that says nothing is the run an agent kills. So under `--events` each step is a compact JSON
 * record on stdout, framed as `pithy dev`'s stream is, and the document a `--json` run would have written closes
 * the stream as its last line.
 */
/** A line as `red` paints it at a color terminal. The test run has color off, so it is spelled out. */
const PAINTED = "\u001b[31mapi: failed.\u001b[39m";

describe("progressRecord", () => {
  test("a start names what is starting, beside whatever the producer knows about it", () => {
    expect(progressRecord("provision", { phase: "start", what: "acme-staging-db", data: { binding: "DB" } })).toEqual({
      command: "provision",
      event: "start",
      what: "acme-staging-db",
      binding: "DB",
    });
  });

  test("a settle carries its line with the paint taken out, and the row behind it", () => {
    const row = { name: "api", ok: false, error: "boom" };
    const record = progressRecord("deploy", { phase: "settled", line: `${PAINTED} boom`, data: { worker: row } });
    expect(record).toEqual({ command: "deploy", event: "settled", line: "api: failed. boom", worker: row });
  });

  /**
   * **The framing is the record's, whatever the producer hands beside it (#697).** A reader dispatches on
   * `command` and `event`, so a producer's row carrying a key of the same name must never replace them: it
   * would turn a settle into a start, or put the stream under another command's name.
   */
  test("a producer's key named event, command, what or line never replaces the framing", () => {
    const data = { event: "start", command: "provision", what: "x", line: "y", binding: "DB" };
    expect(progressRecord("deploy", { phase: "settled", line: "api: deployed.", data })).toMatchObject({
      command: "deploy",
      event: "settled",
      line: "api: deployed.",
      binding: "DB",
    });
    expect(
      progressRecord("deploy", { phase: "start", what: "api", data: { ...data, event: "settled" } }),
    ).toMatchObject({ command: "deploy", event: "start", what: "api", binding: "DB" });
  });
});

describe("withErrorReporting with events", () => {
  const COMPACT = { stdout: { mode: "compact", color: false }, stderr: { mode: "compact", color: false } } as const;

  test("every step is one compact record, and the document closes the stream compact too", async () => {
    // Pretty and painted were asked for: the framing wins, as it does for `pithy dev`.
    latchJsonFormat({ stdout: { mode: "pretty", color: true }, stderr: { mode: "compact", color: false } });
    try {
      const out = await captured(() =>
        withErrorReporting(
          true,
          async () => {
            startStep("api");
            settleStep(PAINTED, { worker: { name: "api", ok: false } });
            process.stdout.write(`${formatJsonLine({ command: "deploy", workers: [] })}\n`);
          },
          { events: "deploy" },
        ),
      );
      const lines = out.trimEnd().split("\n");
      expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
        { command: "deploy", event: "start", what: "api" },
        { command: "deploy", event: "settled", line: "api: failed.", worker: { name: "api", ok: false } },
        { command: "deploy", workers: [] },
      ]);
      expect(out).not.toContain("\u001b");
      expect(out).not.toContain("▸");
    } finally {
      latchJsonFormat(COMPACT);
    }
  });

  test("outside an --events run the document keeps whatever shape was asked for", async () => {
    latchJsonFormat({ stdout: { mode: "pretty", color: false }, stderr: { mode: "compact", color: false } });
    try {
      const out = await captured(() =>
        withErrorReporting(true, async () => {
          process.stdout.write(`${formatJsonLine({ command: "deploy", workers: [] })}\n`);
        }),
      );
      expect(out).toContain("\n  ");
    } finally {
      latchJsonFormat(COMPACT);
    }
  });
});

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

/**
 * **What a masked prompt does with a paste — measured, on a real terminal, against the real
 * `@clack/prompts` `password()` this CLI calls.**
 *
 * Every other test of this path supplies a `SecretPrompter`. That is the right seam for *what the CLI
 * does with an answer* and it can say nothing at all about *what an answer is* — and the claim that
 * mattered was the second kind. `refuseSplitPaste` refused an answer matching `/[\r\n]/`, the `multiline`
 * marker's opt-out polarity was justified by that arm being the backstop for every unmarked field, and a
 * mocked prompter returns whatever a test hands it. So two rounds of review read a defense where there
 * was none: **`password()` submits at the newline, so an answer never carries one.**
 *
 * The three facts below are why the marker is now opt-**in** and swept repo-wide
 * (`ci/secretFieldLines.test.ts`), and why the prompt-side check is a PEM-delimiter trap rather than a
 * newline check:
 *
 * 1. **An answer never carries a newline**, so `/[\r\n]/` matches nothing a terminal can produce.
 * 2. **A multi-line paste is silently truncated to one line**, and which line survives is the
 *    terminal's choice: CR keeps the first, LF keeps the last. Every fragment satisfies `min(1)`.
 * 3. **A PEM's delimiter line is what survives** — the one reachable, discriminating signal, and the
 *    whole of what the trap can honestly claim.
 *
 * A pty is required and a fake will not do: `password()` renders only on a tty, and the truncation is the
 * *terminal's* behavior rather than the library's. `script(1)` allocates it, exactly as
 * `commands/secretsInteractive.test.ts` does — and, as there, the harness is written to a temp file
 * rather than shipped in `src/`, because every non-test `src/*.ts` is a published entry of
 * `@pithy-sh/cli`.
 */

/** `packages/cli/src/capabilities` → the repository's own sources, which the harness imports directly. */
const CLI_SRC = resolve(import.meta.dirname, "..");

/** Where `bun` is, or `null` — the harness is TypeScript importing `.ts` deep paths, which only Bun runs. */
function bunPath(): string | null {
  try {
    return execFileSync("sh", ["-c", "command -v bun"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

/** Whether `script(1)` is here to allocate a pty. util-linux, so: Linux CI and Linux dev boxes. */
function hasScript(): boolean {
  try {
    execFileSync("sh", ["-c", "command -v script"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const BUN = bunPath();
const PTY = BUN !== null && hasScript();

/**
 * The program the pty runs: the real {@link readSecretValue} with **no prompter at all**, so the real
 * `@clack/prompts` `password()` reads the real terminal. Two single-line fields of one `json` secret,
 * asked in schema order.
 *
 * The descriptions are `field 1` and `field 2` because the driver times each write off the question it
 * is answering, and a prompt asks with the schema's own `.describe()` (`promptPlan.ts`). Marking them
 * `multiline: false` is what makes the plan ask at all — an unmarked leaf falls back to one document,
 * which is the fix this file exists to justify.
 */
const HARNESS = `
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { readSecretValue } from ${JSON.stringify(join(CLI_SRC, "capabilities", "secretValue.ts"))};

const out = process.argv[2] as string;
const schema = z
  .strictObject({
    stripe: z
      .object({
        secretKey: z.string().min(1).meta({ multiline: false }).describe("field 1"),
        webhookSecret: z.string().min(1).meta({ multiline: false }).describe("field 2"),
      })
      .describe("Stripe's credentials.")
      .optional(),
  })
  .describe("Every enabled rail's credentials.");

try {
  const value = await readSecretValue({
    name: "payments-provider-credentials",
    mode: "create",
    entry: { backend: "d1", scope: "environment", rotatable: true, valueType: "json", schema },
    branches: ["stripe"],
    canPrompt: true,
    stdin: process.stdin,
  });
  writeFileSync(out, JSON.stringify({ outcome: "value", value }));
} catch (error) {
  const payload = (error as { payload?: { message?: string } }).payload;
  writeFileSync(out, JSON.stringify({ outcome: "refused", message: payload?.message ?? String(error) }));
}
process.exit(0);
`;

/** What one drive of the harness produced: the document the CLI would write, or the refusal. */
interface Run {
  outcome: "value" | "refused";
  value?: string | null;
  message?: string;
}

let workspace: string;
let harness: string;
let runs = 0;

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "pithy-prompt-pty-"));
  harness = join(workspace, "harness.ts");
  writeFileSync(harness, HARNESS);
});
afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/**
 * Run the harness on a pty, typing `paste[n]` into the nth question once that question has rendered.
 *
 * **`stty` first.** A pty whose stdout is a pipe starts 0×0, and a zero-column terminal wraps the prompt
 * after every character — the question is all there but no matcher can see it, so nothing is ever typed
 * and the run hangs. It cost an hour to find; it is one command to prevent.
 */
function underPty(paste: readonly string[], timeoutMs = 60_000): Promise<Run> {
  const out = join(workspace, `run-${++runs}.json`);
  const command = `stty rows 40 cols 200; ${BUN as string} ${harness} ${out}`;
  return new Promise<Run>((settle, fail) => {
    const child = spawn("script", ["-qec", command, "/dev/null"], { stdio: ["pipe", "pipe", "ignore"] });
    let seen = "";
    let answered = 0;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error(`the prompt never finished. Terminal so far:\n${seen}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      seen += chunk.toString("utf8");
      // One write per question, in order, once its own words have rendered.
      while (answered < paste.length && seen.includes(`field ${answered + 1}`)) {
        const bytes = paste[answered] as string;
        answered += 1;
        setTimeout(() => child.stdin.write(bytes), 300);
      }
    });
    child.on("exit", () => {
      clearTimeout(timer);
      try {
        settle(JSON.parse(readFileSync(out, "utf8")) as Run);
      } catch {
        fail(new Error(`the harness wrote no answer. Terminal:\n${seen}`));
      }
    });
  });
}

/** Enter, as a terminal sends it. */
const CR = "\r";

/** The `stripe` block of what a run wrote, parsed. */
function written(run: Run): { secretKey: string; webhookSecret: string } {
  expect(run.outcome).toBe("value");
  return (JSON.parse(run.value as string) as { stripe: { secretKey: string; webhookSecret: string } }).stripe;
}

describe.skipIf(!PTY)("the real masked prompt, on a real terminal", () => {
  test("collects two typed answers and assembles the document the parse gate gets", async () => {
    expect(written(await underPty([`sk_live_abc${CR}`, `whsec_def${CR}`]))).toEqual({
      secretKey: "sk_live_abc",
      webhookSecret: "whsec_def",
    });
  }, 90_000);

  /** Fact 1, and the reason `refuseSplitPaste`'s newline arm is deleted rather than left as reassurance. */
  test("never returns an answer containing a newline — the deleted arm could not have fired", async () => {
    const value = written(await underPty([`aaa\nbbb${CR}`, `whsec_def${CR}`]));
    expect(value.secretKey).not.toMatch(/[\r\n]/);
    // And the paste's other line is simply gone: `aaa` reached no field, here or after it.
    expect(value.secretKey).toBe("bbb");
    expect(value.webhookSecret).toBe("whsec_def");
  }, 90_000);

  /**
   * Fact 2 — the corruption itself, in both terminal dialects. Nothing at the prompt can catch this one:
   * `one` and `two` are shaped like credentials. **The declaration is the defense**, which is why an
   * undeclared leaf is now refused a per-field prompt entirely.
   */
  test("truncates a CR-delimited paste to its first line, and an LF-delimited one to its last", async () => {
    expect(written(await underPty([`one\rtwo${CR}`, `whsec_def${CR}`])).secretKey).toBe("one");
    expect(written(await underPty([`one\ntwo${CR}`, `whsec_def${CR}`])).secretKey).toBe("two");
  }, 120_000);

  /** Fact 3: the trap fires on the line that survives, whichever one that is. */
  test("refuses a PEM pasted into a single-line field, header line or footer line", async () => {
    const pem = (newline: string) =>
      `-----BEGIN PRIVATE KEY-----${newline}MIGabc${newline}-----END PRIVATE KEY-----${CR}`;
    // A second answer is offered but must never be reached: the refusal happens at the first field. It is
    // supplied so that a trap that *fails* to fire ends in a failed assertion rather than a timeout.
    // CR keeps the header — the half a `startsWith("-----BEGIN")` check would have caught.
    const carriage = await underPty([pem("\r"), `whsec_def${CR}`]);
    expect(carriage.outcome).toBe("refused");
    expect(carriage.message).toContain("stripe.secretKey");
    expect(carriage.message).toContain("one line of a PEM");
    // LF keeps the footer — the half it would have missed, written into the secret and validating.
    const feed = await underPty([pem("\n"), `whsec_def${CR}`]);
    expect(feed.outcome).toBe("refused");
    expect(feed.message).toContain("stripe.secretKey");
  }, 120_000);

  /**
   * **Fact 4: the indentation the paste keeps.** A PEM copied out of a YAML block or an indented heredoc
   * arrives with its leading whitespace intact, so the surviving line is `'  -----BEGIN PRIVATE KEY-----'`
   * — and `startsWith` said no. Measured here rather than argued, because *what the terminal hands back*
   * is the one thing about this trap that cannot be reasoned to: the deleted newline arm was reassuring
   * for two rounds on exactly that mistake.
   */
  test("refuses an indented PEM, which the whitespace used to carry past the trap", async () => {
    const indented = `  -----BEGIN PRIVATE KEY-----\r  MIGabc\r  -----END PRIVATE KEY-----${CR}`;
    const run = await underPty([indented, `whsec_def${CR}`]);
    expect(run.outcome).toBe("refused");
    expect(run.message).toContain("stripe.secretKey");
    expect(run.message).toContain("one line of a PEM");
  }, 120_000);
});

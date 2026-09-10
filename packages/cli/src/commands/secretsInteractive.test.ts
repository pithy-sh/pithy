// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { readSource } from "../ci/sourceFiles";
import { canPrompt } from "./secrets";

/**
 * **`pithy secrets` asks two questions about the terminal, and the first remedy for #516 asked one.**
 *
 * *Is a document being piped to me?* is stdin's answer and nobody else's. *May I render interactive UI?*
 * is stdout's and `--json`'s. The remedy computed a single `interactive = !json && stdin.isTTY &&
 * stdout.isTTY` and used it for both, so two ordinary invocations fell into the *a document is piped*
 * branch with no document in sight:
 *
 * - **stdout redirected to a file.** stdin is still the operator's terminal. The command read it —
 *   no prompt, no message, no masking — for a credential.
 * - **`--json` on a terminal.** Same branch. It waits on stdin where it used to prompt, and on EOF
 *   writes whatever arrived.
 *
 * The piped path is the one agents and CI drive, so it is the one that must not move: it stays reached
 * on `stdin.isTTY !== true` alone, which is true under `--json` and under a redirected stdout alike.
 *
 * **These cases are run under a real pty, not a mocked `isTTY`.** A fixture that sets the property is
 * asserting the thing under test — the whole defect was a *disagreement between the two streams*, and
 * the only honest source of that is a kernel that made one of them a terminal and the other a file.
 * `script(1)` allocates the pty; the shell redirection inside it makes the streams disagree.
 */

/** `packages/cli/src/commands` → the repository's own sources, which the harness imports directly. */
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

let workspace: string;
let harness: string;

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "pithy-secrets-pty-"));
  harness = join(workspace, "harness.ts");
  writeFileSync(harness, HARNESS);
});
afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/**
 * The program the pty runs: the real {@link canPrompt} and the real `readSecretValue`, over the real
 * `process.stdin`, with only the prompter faked — a masked `@clack/prompts` password cannot be answered
 * from a test, and it is not what is under test. What it records is which of the three paths was taken.
 *
 * It is written to a temp file rather than shipped in `src/`, because every `src/*.ts` that is not a test
 * is a published entry of `@pithy-sh/cli` (`tooling/build/src/tsdown.ts`), and a harness is not a module
 * an adopter deep-imports.
 */
const HARNESS = `
import { writeFileSync } from "node:fs";
import { readSecretValue } from ${JSON.stringify(join(CLI_SRC, "capabilities", "secretValue.ts"))};
import { canPrompt } from ${JSON.stringify(join(CLI_SRC, "commands", "secrets.ts"))};

const json = process.argv.includes("--json");
const out = process.argv[process.argv.indexOf("--out") + 1] as string;
const asked: string[] = [];
const record = (extra: Record<string, unknown>) =>
  writeFileSync(
    out,
    JSON.stringify({
      stdinIsTTY: process.stdin.isTTY ?? null,
      stdoutIsTTY: process.stdout.isTTY ?? null,
      asked,
      ...extra,
    }),
  );

try {
  const value = await readSecretValue({
    name: "GOOGLE_CLIENT_SECRET",
    mode: "create",
    entry: undefined,
    branches: undefined,
    canPrompt: canPrompt(json),
    stdin: process.stdin,
    prompter: {
      password: async (message: string) => {
        asked.push(message);
        return "typed-at-the-prompt";
      },
      choose: async () => null,
      note: () => {},
    },
  });
  record({ outcome: "value", value });
} catch (error) {
  const payload = (error as { payload?: { code?: string; message?: string; action?: string } }).payload;
  record({
    outcome: "refused",
    code: payload?.code ?? null,
    message: payload?.message ?? null,
    action: payload?.action ?? null,
  });
}
`;

/** What one run of the harness established. */
interface Run {
  stdinIsTTY: boolean | null;
  stdoutIsTTY: boolean | null;
  asked: string[];
  outcome: "value" | "refused";
  value?: string;
  code?: string | null;
  message?: string | null;
  action?: string | null;
}

let runs = 0;

/**
 * Run the harness inside a pty, with the shell fragment `shape` deciding what each stream is.
 *
 * `script -qec <command> /dev/null` gives the command a pty on all three streams; the redirections in
 * `shape` then take one of them away, which is the disagreement no mocked `isTTY` can stage honestly.
 */
function underPty(shape: (harnessCommand: string) => string): Run {
  const out = join(workspace, `run-${++runs}.json`);
  const command = shape(`${BUN as string} ${harness} --out ${out}`);
  execFileSync("script", ["-qec", command, "/dev/null"], { stdio: "ignore", timeout: 60_000 });
  return JSON.parse(readFileSync(out, "utf8")) as Run;
}

describe.skipIf(!PTY)("under a real pty", () => {
  test("a terminal on both ends is prompted, masked, exactly as it always was", () => {
    const run = underPty((cmd) => cmd);
    expect(run.stdinIsTTY).toBe(true);
    expect(run.stdoutIsTTY).toBe(true);
    expect(run.asked).toEqual(["Value for 'GOOGLE_CLIENT_SECRET'"]);
    expect(run.outcome).toBe("value");
    expect(run.value).toBe("typed-at-the-prompt");
  });

  /**
   * The first of the two regressions, measured: `stdin.isTTY=true stdout.isTTY=undefined` used to reach
   * the *a document is piped* branch and read the terminal for a credential, silently and unmasked.
   */
  test("stdout redirected to a file refuses — it never reads the terminal in silence", () => {
    const run = underPty((cmd) => `${cmd} > ${join(workspace, "stdout.txt")}`);
    expect(run.stdinIsTTY).toBe(true);
    expect(run.stdoutIsTTY).toBeNull();
    expect(run.asked).toEqual([]);
    expect(run.outcome).toBe("refused");
    expect(run.code).toBe("validation/invalid_input");
    expect(run.action).toContain("| pithy secrets create GOOGLE_CLIENT_SECRET");
  });

  /**
   * The second: `--json` on a terminal waited on stdin, where before #516 it prompted. Neither is right —
   * `--json` promises one parseable line, so a prompt is a hang and a silent read is a credential nobody
   * typed. It says so instead, on the one stream `--json` reserves for saying so.
   */
  test("--json on a terminal refuses rather than waiting on stdin", () => {
    const run = underPty((cmd) => `${cmd} --json`);
    expect(run.stdinIsTTY).toBe(true);
    expect(run.stdoutIsTTY).toBe(true);
    expect(run.asked).toEqual([]);
    expect(run.outcome).toBe("refused");
    expect(run.message).toContain("GOOGLE_CLIENT_SECRET");
  });

  /**
   * The three that must not move. This is what agents and CI drive, and byte-identical means every one of
   * them reaches the same branch and returns the same string — the pipe alone decides.
   */
  test("a piped document is read identically, with --json, with a redirected stdout, and with neither", () => {
    const plain = underPty((cmd) => `printf 'sk_live_1' | ${cmd}`);
    const json = underPty((cmd) => `printf 'sk_live_1' | ${cmd} --json`);
    const redirected = underPty((cmd) => `printf 'sk_live_1' | ${cmd} > ${join(workspace, "stdout2.txt")}`);
    for (const run of [plain, json, redirected]) {
      expect(run.stdinIsTTY).toBeNull();
      expect(run.asked).toEqual([]);
      expect(run.outcome).toBe("value");
      expect(run.value).toBe("sk_live_1");
    }
    // The one difference between them is which streams were terminals, which is the point.
    expect([plain.stdoutIsTTY, json.stdoutIsTTY, redirected.stdoutIsTTY]).toEqual([true, true, null]);
  });

  test("a piped document keeps its inner newlines and loses exactly one trailing one", () => {
    const run = underPty((cmd) => `printf '{\\n  "a": 1\\n}\\n' | ${cmd}`);
    expect(run.outcome).toBe("value");
    expect(run.value).toBe('{\n  "a": 1\n}');
  });
});

/**
 * The output half on its own. `canPrompt` is a pure function of `--json` and `process.stdout.isTTY`, and
 * the pty block above is what proves the composition; this states the function's own contract, including
 * the property that matters most — **stdin is not one of its inputs**.
 */
describe("canPrompt", () => {
  const STDOUT = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const STDIN = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

  afterEach(() => {
    if (STDOUT) Object.defineProperty(process.stdout, "isTTY", STDOUT);
    else Reflect.deleteProperty(process.stdout, "isTTY");
    if (STDIN) Object.defineProperty(process.stdin, "isTTY", STDIN);
    else Reflect.deleteProperty(process.stdin, "isTTY");
  });

  function attach(stdin: boolean, stdout: boolean): void {
    Object.defineProperty(process.stdin, "isTTY", { value: stdin, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: stdout, configurable: true });
  }

  test("a terminal on stdout and no --json is where a prompt can be drawn", () => {
    attach(true, true);
    expect(canPrompt(false)).toBe(true);
  });

  test("--json never draws one, whatever the terminal is", () => {
    attach(true, true);
    expect(canPrompt(true)).toBe(false);
  });

  test("a redirected stdout has nowhere to put the question", () => {
    attach(true, false);
    expect(canPrompt(false)).toBe(false);
  });

  test("stdin is not an input: a pipe on it changes nothing about where a prompt can be drawn", () => {
    // The property the whole fix rests on. A pipe on stdin means *there is a document*, which is
    // `readSecretValue`'s question, and folding it in here is what re-creates the regression.
    attach(false, true);
    expect(canPrompt(false)).toBe(true);
    attach(true, true);
    expect(canPrompt(false)).toBe(true);
  });
});

/**
 * **The guard against re-merging them, stated about the source.**
 *
 * `ci/interactiveGate.test.ts` scans every command for a `process.stdin.isTTY` expression and demands the
 * other two terms beside it. `secrets` no longer appears in that scan, because the pipe question moved to
 * the stream `readSecretValue` is handed — so this is the assertion that keeps the departure honest: the
 * command must not read stdin's TTY-ness at all. A future `!process.stdin.isTTY` here is either a fourth
 * variant of the gate or the merge that produced the regression, and both fail this.
 */
describe("commands/secrets.ts", () => {
  test("asks stdout and --json about prompting, and never asks stdin anything", () => {
    const source = readSource(join(CLI_SRC, "commands", "secrets.ts"));
    if (source === null) throw new Error("commands/secrets.ts did not read");
    const code = blankComments(source);
    expect(code).toContain("process.stdout.isTTY");
    expect(code).not.toContain("process.stdin.isTTY");
  });
});

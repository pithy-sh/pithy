// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { EXIT } from "./terminal/exitClass";

/**
 * **A run that may not prompt exits instead of waiting — measured on a real pty (#697).**
 *
 * The defect this closes is only visible under a terminal: an agent harness allocates a PTY, runs a
 * command without `--json`, and every hand-written `stdin.isTTY && stdout.isTTY` gate said "a person is
 * here" and opened a prompt nobody would answer. Under `execFile` both streams are pipes and every gate
 * already said no, so a piped test could never have seen it.
 *
 * `script(1)` allocates the pty, exactly as `jsonPretty.pty.test.ts` does. `-e` hands back the child's
 * exit code, `-f` flushes the transcript as it is written so a killed run still shows what it asked,
 * and a run that waited on a prompt is killed by the timeout and reported as such — so "it exited" is
 * an assertion here, not an assumption.
 */

/** The bin this drives. */
const BIN = resolve(import.meta.dirname, "bin.ts");

/** Where `bun` is, or `null` — the bin is TypeScript importing `.ts` deep paths, which only Bun runs. */
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
 * Every signal the runner exports that would change the answer, taken off the child. `CI` and `TEST`
 * make citty and the color seam behave differently; `PITHY_NONINTERACTIVE` is the variable under test,
 * so each case sets it itself rather than inheriting whatever the shell had.
 */
const SCRUBBED = "-u NO_COLOR -u FORCE_COLOR -u TEST -u CI -u PITHY_NONINTERACTIVE -u PITHY_JSON TERM=xterm-256color";

/** Long enough for a cold Bun start under a loaded suite; short enough that a wait is a failure, not a hang. */
const WAIT_MS = 30_000;

let workspace: string;
beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "pithy-noninteractive-pty-"));
});
afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

let runs = 0;

/** What one run under a pty did: its exit code (or `null` when killed), and what the terminal was shown. */
interface PtyRun {
  code: number | null;
  timedOut: boolean;
  shown: string;
  /**
   * {@link shown} with every line break taken out. A prompt draws itself a character at a time, and with
   * no person on `script`'s own stdin the transcript records each one on a line of its own — so
   * `Project name:` is only findable once the breaks are gone. Every prompt check reads this, so a
   * `not.toContain` cannot pass merely because the words were split.
   */
  flat: string;
}

/** Run the bin under a pty, in `cwd`, and report how it ended. */
function underPty(args: string, options: { env?: string; cwd?: string; timeout?: number } = {}): PtyRun {
  const transcript = join(workspace, `pty-${++runs}.txt`);
  const env = [SCRUBBED, "PITHY_NO_UPDATE_NOTIFIER=1", `HOME=${workspace}`, options.env ?? ""]
    .filter(Boolean)
    .join(" ");
  let code: number | null = 0;
  let timedOut = false;
  try {
    execFileSync("script", ["-qefc", `env ${env} ${BUN as string} ${BIN} ${args}`, transcript], {
      stdio: "ignore",
      cwd: options.cwd ?? workspace,
      timeout: options.timeout ?? WAIT_MS,
      killSignal: "SIGKILL",
    });
  } catch (error) {
    const failed = error as { status?: number | null; signal?: string | null };
    code = failed.status ?? null;
    timedOut = failed.signal === "SIGKILL";
  }
  const shown = existsSync(transcript) ? readFileSync(transcript, "utf8").replaceAll("\r\n", "\n") : "";
  return { code, timedOut, shown, flat: shown.replaceAll(/[\r\n]/g, "") };
}

describe.skipIf(!PTY)("PITHY_NONINTERACTIVE=1 at a real terminal, with no --json", () => {
  test("an optional prompt takes its default: init scaffolds and exits 0 without asking a thing", () => {
    const target = join(workspace, "scaffolded");
    const run = underPty(`init --dir ${target}`, { env: "PITHY_NONINTERACTIVE=1" });
    expect(run.timedOut).toBe(false);
    expect(run.code).toBe(0);
    expect(run.flat).not.toContain("Project name:");
    expect(existsSync(join(target, "pithy.config.ts"))).toBe(true);
  });

  test("--no-input does the same for one call", () => {
    const target = join(workspace, "flagged");
    const run = underPty(`init --dir ${target} --no-input`);
    expect(run.timedOut).toBe(false);
    expect(run.code).toBe(0);
    expect(run.flat).not.toContain("Project name:");
  });

  test("a required prompt fails input/required instead of opening: docs connect names --client", () => {
    const run = underPty("docs connect --scope user", { env: "PITHY_NONINTERACTIVE=1" });
    expect(run.timedOut).toBe(false);
    // 2: usage — an agent fixes the call by passing the flag it names (#697).
    expect(run.code).toBe(EXIT.usage);
    expect(run.shown).toContain("Name what to connect.");
    expect(run.shown).toContain("--client <id>");
  });

  test("remove, which belongs to a person, stops before it reads anything", () => {
    const run = underPty("remove auth", { env: "PITHY_NONINTERACTIVE=1" });
    expect(run.timedOut).toBe(false);
    // 5: needs a person — no flag answers it, so an agent stops and asks (#697).
    expect(run.code).toBe(EXIT.person);
    expect(run.shown).toContain("pithy remove is a manual command, and this run forbids prompts.");
  });

  test("a value other than 1 is refused, and the run asks nothing", () => {
    const run = underPty(`init --dir ${join(workspace, "refused")}`, { env: "PITHY_NONINTERACTIVE=yes" });
    expect(run.timedOut).toBe(false);
    expect(run.code).not.toBe(0);
    expect(run.shown).toContain('PITHY_NONINTERACTIVE is set to "yes", and it takes 1.');
    expect(existsSync(join(workspace, "refused"))).toBe(false);
  });

  test("the control: the same init without the switch opens the prompt and waits", () => {
    // Proves the harness stages a terminal a prompt would open on. Without this, every case above could
    // pass because the pty was never a pty.
    const run = underPty(`init --dir ${join(workspace, "waiting")}`, { timeout: 8_000 });
    expect(run.timedOut).toBe(true);
    expect(run.flat).toContain("Project name:");
  });
});

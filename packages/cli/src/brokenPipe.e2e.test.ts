// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { EXIT } from "./terminal/exitClass";

/**
 * **A reader that stops early ends the run quietly, exit 141 (#697).** `pithy schema --json | head` printed
 * an unhandled `EPIPE` stack trace under Node and under Bun, because the write that found the pipe closed
 * raised an `error` event nothing listened for. A reader that took what it wanted is not a failure to
 * report. It exits as `SIGPIPE` would, the way an interrupt exits 130 (`docs/CLI.md` §3.8).
 *
 * The child's stdout is closed before it writes a byte, so every write it makes finds the pipe shut — the
 * `| head -c 0` case, with no race on how much `head` happened to read first.
 */

const bin = join(import.meta.dirname, "bin.ts");

/** The bin's environment with the runner's own signals scrubbed, so nothing but the closed pipe differs. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PITHY_NO_UPDATE_NOTIFIER: "1" };
  for (const key of ["NO_COLOR", "FORCE_COLOR", "TEST", "CI", "PITHY_JSON", "PITHY_NONINTERACTIVE"]) delete env[key];
  return env;
}

/** Run the bin with its stdout closed from the start; hand back how it exited and what it said on stderr. */
function withStdoutClosed(args: string[]): Promise<{ code: number | null; signal: string | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [bin, ...args], { env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.destroy();
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stderr }));
  });
}

describe("stdout closed by its reader", () => {
  test.each([[["--help"]], [["doctor", "--json"]], [["schema", "worker", "rename", "--json"]]])(
    "pithy %j exits 141 with nothing on stderr",
    async (args) => {
      const { code, signal, stderr } = await withStdoutClosed(args);
      expect(stderr).toBe("");
      expect(signal).toBeNull();
      expect(code).toBe(EXIT.brokenPipe);
    },
  );
});

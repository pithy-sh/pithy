// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

/**
 * **What a person at a terminal gets from `--json` — measured on a real pty, not a mocked `isTTY`.**
 *
 * `terminal/jsonMode.test.ts` asks the rule and `jsonPretty.e2e.test.ts` asks the piped bin; neither can say
 * that `bin.ts` reads the *right* `isTTY`, because under `execFile` both streams are pipes and every row
 * of the matrix collapses to one. The claims here are the two only a kernel can stage honestly: that a
 * terminal is detected at all, and that **the two streams can disagree** — `pithy … --json > out.json`
 * writes a parseable line to the file and a readable one to the screen, which is the case a single
 * answer would have to disappoint one half of.
 *
 * `script(1)` allocates the pty, exactly as `commands/secretsInteractive.test.ts` does. Its transcript
 * file is how the terminal's own bytes are read back — a pipe to `tee` would have taken the terminal
 * away again, which is the whole thing under test. A shell redirection inside the command is what takes
 * one stream away *deliberately*.
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

/** Every ANSI sequence, so an assertion can say "and it parses" about what a terminal was shown. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the escape byte is the point.
const ANSI = /\u001b\[[0-9;]*m/g;

const ESC = "\u001b";

/**
 * Every color signal the runner exports, taken off the child — so the child decides color on its own
 * terms, from the pty it was just handed.
 *
 * `packages/cli/vitest.config.ts` sets `NO_COLOR=1` for the whole package, deliberately: every test that
 * pins exact output would otherwise pass or fail on the developer's shell. Inherited here it would make
 * "a terminal gets colored JSON" fail for a reason that has nothing to do with the code, and the
 * `NO_COLOR` case below would pass without ever setting it. `bin.test.ts` scrubs the same four.
 */
const SCRUBBED = "-u NO_COLOR -u FORCE_COLOR -u TEST -u CI TERM=xterm-256color";

let workspace: string;
beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "pithy-json-pty-"));
});
afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

let runs = 0;

/**
 * Run the bin under a pty and hand back what the terminal was shown.
 *
 * A pty turns every `\n` into `\r\n`, so the transcript is normalized back before anything reads it —
 * that is the terminal's line discipline, not the CLI's bytes.
 */
function underPty(args: string, options: { env?: string; redirect?: string } = {}): string {
  const transcript = join(workspace, `pty-${++runs}.txt`);
  const env = [SCRUBBED, "PITHY_NO_UPDATE_NOTIFIER=1", options.env ?? ""].filter(Boolean).join(" ");
  const redirect = options.redirect === undefined ? "" : ` > ${options.redirect}`;
  try {
    execFileSync("script", ["-qec", `env ${env} ${BUN as string} ${BIN} ${args}${redirect}`, transcript], {
      stdio: "ignore",
      timeout: 60_000,
    });
  } catch {
    // A non-zero exit is an outcome this file asserts on, not a reason to stop reading the transcript.
  }
  return withoutBookkeeping(readFileSync(transcript, "utf8").replaceAll("\r\n", "\n"));
}

/**
 * `script`'s own `Script started on …` / `Script done on …` framing, taken back off.
 *
 * `-q` is documented to suppress it and does not in every util-linux build (2.39 writes both when a
 * transcript file is named), so it is stripped here rather than depended on — a harness that silently
 * counted a header as a line of output would have made every one-line assertion below meaningless.
 */
function withoutBookkeeping(transcript: string): string {
  const lines = transcript.split("\n");
  if (lines[0]?.startsWith("Script started on ")) lines.shift();
  while (lines.length > 0) {
    const last = lines[lines.length - 1] as string;
    if (last !== "" && !last.startsWith("Script done on ")) break;
    lines.pop();
  }
  return lines.join("\n");
}

/** What the terminal was shown, with the color taken back off so it can be parsed. */
function parsed(shown: string): unknown {
  return JSON.parse(shown.replaceAll(ANSI, ""));
}

describe.skipIf(!PTY)("--json at a real terminal", () => {
  test("indents, colors, and still parses", () => {
    const shown = underPty("doctor --json");
    expect(shown.replaceAll(ANSI, "")).toContain('\n  "cli": {');
    expect(shown).toContain(ESC);
    expect(parsed(shown)).toMatchObject({ cli: expect.any(Object) });
  });

  test("--no-pretty keeps one compact line at a terminal", () => {
    const shown = underPty("doctor --json --no-pretty").replaceAll(ANSI, "");
    expect(shown.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(shown)).toMatchObject({ cli: expect.any(Object) });
  });

  /** The case the variable exists for: a harness that allocates a PTY and still wants one line. */
  test("PITHY_JSON=compact silences a PTY-allocating harness, even with --pretty passed", () => {
    const shown = underPty("doctor --json --pretty", { env: "PITHY_JSON=compact" }).replaceAll(ANSI, "");
    expect(shown.trimEnd().split("\n")).toHaveLength(1);
  });

  test("PITHY_JSON=pretty and --pretty agree with the terminal rather than fighting it", () => {
    const shown = underPty("doctor --json", { env: "PITHY_JSON=pretty" }).replaceAll(ANSI, "");
    expect(shown).toContain('\n  "cli": {');
  });

  /**
   * The `=value` spelling the undeclared-flag check already lets through. Read only as a bare token, it
   * was accepted, ignored and *indented* here — the operator asked for compact and got the opposite.
   */
  test("--pretty=false is honored at a terminal, not silently ignored", () => {
    const shown = underPty("doctor --json --pretty=false").replaceAll(ANSI, "");
    expect(shown.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(shown)).toMatchObject({ cli: expect.any(Object) });
  });

  test("NO_COLOR leaves indented JSON with zero ANSI bytes, and it parses", () => {
    const shown = underPty("doctor --json", { env: "NO_COLOR=1" });
    expect(shown).not.toContain(ESC);
    expect(JSON.parse(shown)).toMatchObject({ cli: expect.any(Object) });
  });
});

/**
 * The case that forced a mode per stream: `pithy … --json > out.json` at a terminal. The file wants the
 * parseable line and the screen wants the readable one, and one answer has to disappoint one of them.
 */
describe.skipIf(!PTY)("each stream answers for its own reader", () => {
  test("stdout redirected to a file gets the compact line, though the run is at a terminal", () => {
    const out = join(workspace, "redirected.json");
    underPty("doctor --json", { redirect: out });
    const written = readFileSync(out, "utf8");
    expect(written).not.toContain(ESC);
    expect(written.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(written)).toMatchObject({ cli: expect.any(Object) });
  });

  /**
   * **The mirror case, and the one that corrupted rather than annoyed (#666 review).**
   *
   * stdout is the terminal, so the color seam — which latches on stdout alone — says yes. stderr is a
   * file. With `--pretty` forcing both streams pretty, the `{ "error": … }` line went into that file
   * painted, and nothing could parse it. An indent in a captured document is survivable; an escape
   * sequence is not, so color is now decided per stream while the seam still has the final say.
   */
  test("a redirected stderr is never painted, so a captured --json error still parses", () => {
    const err = join(workspace, "stderr.json");
    underPty(`doctor --json --pretty --bogus 2> ${err}`);
    const written = readFileSync(err, "utf8");
    expect(written).not.toContain(ESC);
    expect(written).toContain('\n  "error": {');
    expect(JSON.parse(written)).toMatchObject({ error: { code: "validation/invalid_input" } });
  });

  /** And the terminal beside it keeps its color — the split is per stream, not color switched off. */
  test("while stdout, still a terminal, is painted", () => {
    const shown = underPty("doctor --json --pretty");
    expect(shown).toContain(ESC);
    expect(parsed(shown)).toMatchObject({ cli: expect.any(Object) });
  });

  /**
   * And the screen, on the same shape of run, gets the readable one. `--bogus` is the refusal every
   * command shares, so this asks the question without needing a command that fails for its own reasons.
   */
  test("the error on the screen is indented, because stderr is still the terminal", () => {
    const out = join(workspace, "redirected-error.json");
    const shown = underPty("doctor --json --bogus", { redirect: out });
    const plain = shown.replaceAll(ANSI, "");
    expect(plain).toContain('\n  "error": {');
    expect(parsed(shown)).toMatchObject({ error: { code: "validation/invalid_input" } });
  });
});

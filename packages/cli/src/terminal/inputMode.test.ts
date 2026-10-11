// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, describe, expect, test } from "vitest";
import {
  inputForbidden,
  latchInputMode,
  mayDraw,
  mayPrompt,
  mayReadKeys,
  NONINTERACTIVE_ENV,
  resolveInputForbidden,
  stdinTakesInput,
} from "./inputMode";

/**
 * The one switch that forbids prompts (#697): `PITHY_NONINTERACTIVE=1`, `--no-input`, or `--json`.
 *
 * The resolver is pure, so the whole env × flag × json matrix is asked here rather than from a process
 * with a terminal. The latch is module state, so every test that sets it puts it back.
 */

afterEach(() => latchInputMode(false));

const TERMINAL = { stdin: { isTTY: true }, stdout: { isTTY: true }, stderr: { isTTY: true } };

describe("resolveInputForbidden", () => {
  test("nothing said is not forbidden", () => {
    expect(resolveInputForbidden({})).toBe(false);
  });

  test("an empty variable is unset, the way PITHY_JSON treats one", () => {
    expect(resolveInputForbidden({ env: "" })).toBe(false);
  });

  test.each([
    [{ env: "1" }],
    [{ noInput: true }],
    [{ json: true }],
    [{ env: "1", noInput: false }],
    [{ noInput: false, json: true }],
  ])("%j forbids prompts", (options) => {
    expect(resolveInputForbidden(options)).toBe(true);
  });

  test("--no-input=false grants nothing the others did not forbid", () => {
    expect(resolveInputForbidden({ noInput: false })).toBe(false);
  });

  test.each(["0", "true", "yes", "TRUE", " 1", "2"])("%j is refused, naming the one value it takes", (env) => {
    let thrown: unknown;
    try {
      resolveInputForbidden({ env });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PithyError);
    const payload = (thrown as PithyError).payload;
    expect(payload.code).toBe("validation/invalid_input");
    expect(payload.message).toContain(NONINTERACTIVE_ENV);
    expect(payload.message).toContain(JSON.stringify(env));
    expect(payload.action).toBe(`Set ${NONINTERACTIVE_ENV}=1 to forbid prompts, or unset it.`);
  });
});

describe("the latch", () => {
  test("unlatched is not forbidden, so a test that never went through the bin is unaffected", () => {
    expect(inputForbidden()).toBe(false);
    expect(mayPrompt(false, TERMINAL)).toBe(true);
  });

  test("latched, nothing may be asked even with a terminal on every stream", () => {
    latchInputMode(true);
    expect(inputForbidden()).toBe(true);
    expect(mayPrompt(false, TERMINAL)).toBe(false);
    expect(mayDraw(false, TERMINAL.stdout)).toBe(false);
    expect(mayReadKeys(false, TERMINAL)).toBe(false);
  });
});

describe("mayPrompt", () => {
  test("needs a terminal on both stdin and stdout", () => {
    expect(mayPrompt(false, { stdin: { isTTY: false }, stdout: { isTTY: true } })).toBe(false);
    expect(mayPrompt(false, { stdin: { isTTY: true }, stdout: {} })).toBe(false);
  });

  test("--json at the call site is never a question", () => {
    expect(mayPrompt(true, TERMINAL)).toBe(false);
  });

  test("reads the terminal when asked, not when latched", () => {
    const streams = { stdin: { isTTY: false }, stdout: { isTTY: true } };
    latchInputMode(false);
    expect(mayPrompt(false, streams)).toBe(false);
    streams.stdin.isTTY = true;
    expect(mayPrompt(false, streams)).toBe(true);
  });
});

describe("mayDraw", () => {
  test("reads stdout alone, so a piped document on stdin does not stop a prompt being drawn", () => {
    expect(mayDraw(false, { isTTY: true })).toBe(true);
    expect(mayDraw(false, { isTTY: false })).toBe(false);
    expect(mayDraw(true, { isTTY: true })).toBe(false);
  });
});

describe("mayReadKeys", () => {
  test("needs stdin for the key and stderr for the offer", () => {
    expect(mayReadKeys(false, { stdin: { isTTY: true }, stderr: { isTTY: true } })).toBe(true);
    expect(mayReadKeys(false, { stdin: { isTTY: true }, stderr: { isTTY: false } })).toBe(false);
    expect(mayReadKeys(false, { stdin: { isTTY: false }, stderr: { isTTY: true } })).toBe(false);
    expect(mayReadKeys(true, { stdin: { isTTY: true }, stderr: { isTTY: true } })).toBe(false);
  });
});

describe("stdinTakesInput", () => {
  test("a terminal on stdin takes input until the run forbids it", () => {
    expect(stdinTakesInput({ isTTY: true })).toBe(true);
    expect(stdinTakesInput({ isTTY: false })).toBe(false);
    latchInputMode(true);
    expect(stdinTakesInput({ isTTY: true })).toBe(false);
  });
});

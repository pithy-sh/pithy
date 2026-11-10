// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EXIT } from "../terminal/exitClass";
import { latchInputMode } from "../terminal/inputMode";
import { rollbackPhrase } from "./migrate";
import { confirmPrompt } from "./provision";
import { productionPrompt, resetPrompt as seedResetPrompt } from "./seed";
import { resetPrompt as vectorResetPrompt } from "./vector";
import { triggerPrompt } from "./workflow";

/**
 * **Ctrl-C at a typed-phrase prompt is an interrupt, not a refusal.**
 *
 * Every command that asks a person for a confirmation phrase — `provision`, `seed` (reset and production),
 * `migrate --rollback`, `vector reset` and `workflow trigger` — exits 130 when the prompt is canceled, as
 * `docs/CLI.md` §3.8 says every prompt does. A cancel must never reach the phrase match as an empty answer,
 * which would end the run `core/person_required`, exit 5, "was not confirmed", when nobody refused anything.
 * Each factory is driven here with a scripted cancel.
 *
 * `@clack/prompts` is reached through a dynamic import at the point of use, so the module itself is what
 * this file replaces. `cancel` is the exact value `isCancel` is mocked to recognize.
 */
const prompt = vi.hoisted(() => ({
  /** The sentinel a scripted cancellation answers with. */
  cancel: Symbol("clack.cancel") as unknown,
  /** What the next `text` answers. */
  text: undefined as unknown,
}));

vi.mock("@clack/prompts", () => ({
  isCancel: (value: unknown) => value === prompt.cancel,
  text: () => Promise.resolve(prompt.text),
}));

/** Every phrase prompt, as the thunk its command hands the gate. */
const PROMPTS: readonly (readonly [string, () => Promise<string | undefined>])[] = [
  ["provision confirmPrompt", confirmPrompt("prod")],
  ["seed resetPrompt", seedResetPrompt("staging")],
  ["seed productionPrompt", productionPrompt()],
  ["vector resetPrompt", vectorResetPrompt("staging")],
  ["migrate promptRollback", () => rollbackPhrase({ env: "staging", json: false, rollback: true, group: "g1" })],
  ["workflow triggerPrompt", triggerPrompt("prod")],
];

describe("a typed-phrase prompt", () => {
  const tty = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };
  beforeEach(() => {
    // `rollbackPhrase` asks only a run that may prompt, so a terminal is attached on both ends.
    latchInputMode(false);
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
  });
  afterEach(() => {
    process.stdin.isTTY = tty.stdin;
    process.stdout.isTTY = tty.stdout;
    prompt.text = undefined;
    vi.restoreAllMocks();
  });

  test.each(PROMPTS)("%s ends the run with exit 130 when it is canceled", async (_name, ask) => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exited");
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    prompt.text = prompt.cancel;

    await expect(ask()).rejects.toThrow("exited");
    expect(exit).toHaveBeenCalledWith(EXIT.interrupted);
    expect(stderr).toHaveBeenCalledWith("Canceled.\n");
  });

  test.each(PROMPTS)("%s hands back what was typed", async (_name, ask) => {
    prompt.text = "yes, i really want to";
    await expect(ask()).resolves.toBe("yes, i really want to");
  });

  test("anti-vacuous: every phrase prompt the confirmation gates are handed is here", () => {
    expect(PROMPTS).toHaveLength(6);
  });
});

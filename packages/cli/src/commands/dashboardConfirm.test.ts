// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, test, vi } from "vitest";
import { EXIT } from "../terminal/exitClass";
import { confirmDisconnect, confirmRevokeKey } from "./dashboard";

/**
 * **A cancel and a "no" end a dashboard confirmation differently (#697).**
 *
 * `pithy dashboard revoke-key` and `disconnect` ask a yes-or-no before acting. Ctrl-C there arrives as a
 * cancel, because `@clack/prompts` reads in raw mode, and it is an interrupt: exit 130. A person who reads
 * the question and answers no has refused, which is not an interrupt and not one of the classified
 * failures: exit 1. Both print `Canceled.`, as they always have. `docs/CLI.md` §3.8 states the split.
 *
 * `@clack/prompts` is reached through a dynamic import at the point of use, so the module itself is what
 * this file replaces. `cancel` is the exact value `isCancel` is mocked to recognize.
 */
const prompt = vi.hoisted(() => ({
  /** The sentinel a scripted cancellation answers with. */
  cancel: Symbol("clack.cancel") as unknown,
  /** What the next `confirm` answers. */
  answer: undefined as unknown,
}));

vi.mock("@clack/prompts", () => ({
  isCancel: (value: unknown) => value === prompt.cancel,
  confirm: () => Promise.resolve(prompt.answer),
}));

/** Both confirmations, as the thunk each command hands its gate. */
const CONFIRMS: readonly (readonly [string, () => Promise<void>])[] = [
  ["revoke-key", () => confirmRevokeKey("key_1", "staging")],
  ["disconnect", () => confirmDisconnect("staging")],
];

/** Stub the exit so the run can be observed ending, and capture stderr. */
function observeExit() {
  const exit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("exited");
  });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return { exit, stderr };
}

describe("a dashboard confirmation", () => {
  afterEach(() => {
    prompt.answer = undefined;
    vi.restoreAllMocks();
  });

  test.each(CONFIRMS)("%s exits 130 when it is canceled", async (_name, ask) => {
    const { exit, stderr } = observeExit();
    prompt.answer = prompt.cancel;

    await expect(ask()).rejects.toThrow("exited");
    expect(exit).toHaveBeenCalledWith(EXIT.interrupted);
    expect(stderr).toHaveBeenCalledWith("Canceled.\n");
  });

  test.each(CONFIRMS)("%s exits 1 when the answer is no", async (_name, ask) => {
    const { exit, stderr } = observeExit();
    prompt.answer = false;

    await expect(ask()).rejects.toThrow("exited");
    expect(exit).toHaveBeenCalledWith(EXIT.failed);
    expect(stderr).toHaveBeenCalledWith("Canceled.\n");
  });

  test.each(CONFIRMS)("%s returns when the answer is yes", async (_name, ask) => {
    const { exit } = observeExit();
    prompt.answer = true;

    await expect(ask()).resolves.toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
  });
});

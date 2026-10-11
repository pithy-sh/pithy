// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { EXIT, EXIT_CLASSES, exitClassOf, exitCodeOf } from "../terminal/exitClass";
import { rotationFailure } from "./secrets";

/**
 * **A rotation that failed before anything rolled says to run it again, and its exit says the same (#697).**
 *
 * Nothing was rolled, so the previous value is still live and a second run can succeed. The refusal's action
 * says exactly that, so the class it exits with must too: `upstream`, exit 4, retryable. It was a
 * `ValidationError`, which exits 2 and tells a script that only a different spelling of the call can work.
 */
describe("rotationFailure", () => {
  test("with no recorded cause, it is an upstream failure a retry can clear", () => {
    const error = rotationFailure("REPLAY_SESSION_KEY", undefined);
    if (!(error instanceof PithyError)) throw new Error("the fallback is not a PithyError");
    expect(error.payload).toMatchObject({
      code: "core/upstream_failed",
      message: "Secret 'REPLAY_SESSION_KEY' was not rotated.",
      action: "Run it again. The previous value is still live.",
    });
    expect(exitCodeOf(error.payload)).toBe(EXIT.upstream);
    expect(EXIT_CLASSES[exitClassOf(error.payload)].retryable).toBe(true);
  });

  test("a recorded cause is reported as it is, exiting by its own kind", () => {
    const cause = new ValidationError({ message: "The value does not parse." });
    expect(rotationFailure("REPLAY_SESSION_KEY", cause)).toBe(cause);
  });
});

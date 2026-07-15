import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { rejectJson } from "./remove";

describe("rejectJson", () => {
  test("fast-fails on --json with a manual-command PithyError", () => {
    const failure = (() => {
      try {
        rejectJson(true);
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.message).toMatch(/manual command/i);
  });

  test("does nothing without --json", () => {
    expect(() => rejectJson(false)).not.toThrow();
  });
});

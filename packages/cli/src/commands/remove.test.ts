// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import remove, { rejectJson } from "./remove";

describe("remove command", () => {
  test("meta and args shape — --worker names the worker to unwire", () => {
    const args = remove.args as Record<string, { type: string; default?: unknown; required?: boolean }>;
    expect(remove.meta).toMatchObject({ name: "remove" });
    expect(Object.keys(args)).toEqual(["capability", "worker", "drop", "env", "json"]);
    expect(args.capability).toMatchObject({ type: "positional", required: true });
    expect(args.worker).toMatchObject({ type: "string" });
  });
});

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

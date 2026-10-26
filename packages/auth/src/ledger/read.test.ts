// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { DEFAULT_WINDOW_DAYS, resolveVerificationWindow } from "./read";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const DAY = 86_400_000;

describe("resolveVerificationWindow", () => {
  test("with neither bound, the last 30 days ending now", () => {
    expect(resolveVerificationWindow({}, NOW)).toEqual({
      since: new Date(NOW.getTime() - DEFAULT_WINDOW_DAYS * DAY),
      until: NOW,
    });
  });

  test("with only an end, the 30 days before that end", () => {
    const until = new Date("2026-09-01T00:00:00.000Z");
    expect(resolveVerificationWindow({ until }, NOW)).toEqual({ since: new Date(until.getTime() - 30 * DAY), until });
  });

  test("with only a start, from it to now", () => {
    const since = new Date("2026-10-25T00:00:00.000Z");
    expect(resolveVerificationWindow({ since }, NOW)).toEqual({ since, until: NOW });
  });

  test("a window that ends where it starts, or before, is refused rather than answered empty", () => {
    for (const since of [NOW, new Date(NOW.getTime() + 1)]) {
      let thrown: unknown;
      try {
        resolveVerificationWindow({ since, until: NOW }, NOW);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(PithyError);
      expect((thrown as PithyError).payload.status).toBe(400);
    }
  });
});

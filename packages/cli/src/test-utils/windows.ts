// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { beforeAll } from "vitest";

/**
 * Fail the file unless it is running on Windows.
 *
 * A `*.windows.test.ts` asserts what the real platform does (#702). Run anywhere else it is either red for
 * no reason or, worse, green for none — a `.cmd` that is not refused because nothing here knows what a
 * `.cmd` is. Calling this at the top of the file makes the wrong runner a failure, not a pass.
 */
export function requireWindows(): void {
  beforeAll(() => {
    if (process.platform !== "win32") {
      throw new Error(
        `A *.windows.test.ts ran on ${process.platform}. Run it with \`node --run test:windows\` on Windows.`,
      );
    }
  });
}

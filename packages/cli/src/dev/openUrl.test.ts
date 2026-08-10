// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { openCommand, openUrl } from "./openUrl";

const URL = "http://localhost:8787/__pithy/dev-login";

describe("openCommand", () => {
  test("uses each platform's own opener, and hands the URL over as one argument", () => {
    expect(openCommand(URL, "darwin")).toEqual({ command: "open", args: [URL] });
    expect(openCommand(URL, "win32")).toEqual({ command: "cmd", args: ["/c", "start", "", URL] });
    expect(openCommand(URL, "linux")).toEqual({ command: "xdg-open", args: [URL] });
    expect(openCommand(URL, "freebsd")).toEqual({ command: "xdg-open", args: [URL] });
  });
});

describe("openUrl", () => {
  test("spawns the platform opener detached, so the browser outlives pithy dev", async () => {
    const calls: { command: string; args: string[]; detached: boolean }[] = [];
    await openUrl(URL, {
      platform: "linux",
      spawn: (command, args, options) => {
        calls.push({ command, args, detached: options.detached });
        return {
          once: (event: "spawn" | "error", listener: (error: Error) => void) => {
            if (event === "spawn") queueMicrotask(() => listener(new Error("unused")));
          },
          unref: () => {},
        };
      },
    });
    expect(calls).toEqual([{ command: "xdg-open", args: [URL], detached: true }]);
  });

  test("a missing opener is an actionable refusal carrying the URL to open by hand", async () => {
    const failure = openUrl(URL, {
      platform: "linux",
      spawn: () => ({
        once: (event: "spawn" | "error", listener: (error: Error) => void) => {
          if (event === "error") queueMicrotask(() => listener(new Error("spawn xdg-open ENOENT")));
        },
        unref: () => {},
      }),
    });

    const error: unknown = await failure.then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    if (!(error instanceof PithyError)) throw new Error("expected a PithyError");
    expect(error.payload.message).toContain("Could not open a browser");
    expect(error.payload.action).toContain(URL);
  });
});

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { baseDirectory, resolveUnder } from "./home";

const HOME = join("/", "home", "you");

describe("baseDirectory", () => {
  test("`home` is the home directory itself, on every platform", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      expect(baseDirectory("home", { platform, env: {}, homedir: HOME })).toBe(HOME);
    }
  });

  test("`config` is $XDG_CONFIG_HOME when the shell exports one", () => {
    const env = { XDG_CONFIG_HOME: join("/", "xdg") };
    expect(baseDirectory("config", { platform: "linux", env, homedir: HOME })).toBe(join("/", "xdg"));
  });

  test("`config` falls back to ~/.config, and an empty XDG_CONFIG_HOME is no override", () => {
    const expected = join(HOME, ".config");
    expect(baseDirectory("config", { platform: "linux", env: {}, homedir: HOME })).toBe(expected);
    expect(baseDirectory("config", { platform: "linux", env: { XDG_CONFIG_HOME: "  " }, homedir: HOME })).toBe(
      expected,
    );
  });

  test("`config` on macOS is ~/.config too — the tools that use it are XDG-style, not Apple-style", () => {
    expect(baseDirectory("config", { platform: "darwin", env: {}, homedir: HOME })).toBe(join(HOME, ".config"));
  });

  test("`config` ignores XDG_CONFIG_HOME on macOS, because Zed and Goose do", () => {
    // A dotfile manager exporting it on a Mac would otherwise send the entry to a path the editor never
    // reads, and the command would report `added` over a connection that does not exist.
    const env = { XDG_CONFIG_HOME: join("/", "xdg") };
    expect(baseDirectory("config", { platform: "darwin", env, homedir: HOME })).toBe(join(HOME, ".config"));
  });

  test("`appSupport` is ~/Library/Application Support on macOS", () => {
    expect(baseDirectory("appSupport", { platform: "darwin", env: {}, homedir: HOME })).toBe(
      join(HOME, "Library", "Application Support"),
    );
  });

  test("`appData` is %APPDATA%, and falls back to the documented default when the shell exports none", () => {
    const env = { APPDATA: join("C:", "Users", "you", "AppData", "Roaming") };
    expect(baseDirectory("appData", { platform: "win32", env, homedir: HOME })).toBe(env.APPDATA);
    expect(baseDirectory("appData", { platform: "win32", env: {}, homedir: HOME })).toBe(
      join(HOME, "AppData", "Roaming"),
    );
  });
});

describe("resolveUnder", () => {
  test("joins the segments onto the base", () => {
    expect(
      resolveUnder({ base: "home", segments: [".cursor", "mcp.json"] }, { platform: "linux", env: {}, homedir: HOME }),
    ).toBe(join(HOME, ".cursor", "mcp.json"));
  });
});

describe("the refusal that keeps a test off the operator's own machine", () => {
  test("refuses under vitest when no home was injected, naming the seam to pass", () => {
    // No `homedir`, and no injected `env` — the answer would be this developer's real home, and the
    // files under it are the ones every other AI tool on the machine reads.
    let raised: unknown;
    try {
      baseDirectory("home", {});
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(PithyError);
    expect((raised as PithyError).payload.message).toContain("real home directory");
  });

  test("an injected home is answered without complaint", () => {
    expect(baseDirectory("home", { homedir: HOME, env: {} })).toBe(HOME);
  });
});

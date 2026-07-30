// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { detectShell } from "./shell";

const HOME = "/home/tester";

describe("detectShell", () => {
  test("zsh → ~/.zshrc with the single-quoted alias", async () => {
    const shell = await detectShell({ shell: "/bin/zsh", platform: "linux", homedir: HOME });
    expect(shell).toEqual({ kind: "zsh", rcPath: join(HOME, ".zshrc"), aliasSyntax: "alias p.='pithy'" });
  });

  test("bash on Linux → ~/.bashrc", async () => {
    const shell = await detectShell({ shell: "/bin/bash", platform: "linux", homedir: HOME });
    expect(shell).toEqual({ kind: "bash", rcPath: join(HOME, ".bashrc"), aliasSyntax: "alias p.='pithy'" });
  });

  test("macOS bash prefers ~/.bash_profile when it exists", async () => {
    const shell = await detectShell({
      shell: "/bin/bash",
      platform: "darwin",
      homedir: HOME,
      fileExists: (p) => p === join(HOME, ".bash_profile"),
    });
    expect(shell?.rcPath).toBe(join(HOME, ".bash_profile"));
  });

  test("macOS bash falls back to ~/.bashrc when .bash_profile is absent", async () => {
    const shell = await detectShell({
      shell: "/bin/bash",
      platform: "darwin",
      homedir: HOME,
      fileExists: () => false,
    });
    expect(shell?.rcPath).toBe(join(HOME, ".bashrc"));
  });

  test("fish → config.fish with no `=` in the alias", async () => {
    const shell = await detectShell({ shell: "/usr/bin/fish", platform: "linux", homedir: HOME });
    expect(shell).toEqual({
      kind: "fish",
      rcPath: join(HOME, ".config", "fish", "config.fish"),
      aliasSyntax: "alias p. pithy",
    });
  });

  test("nushell → config.nu with the spaced `=` form", async () => {
    const shell = await detectShell({ shell: "/usr/bin/nu", platform: "linux", homedir: HOME });
    expect(shell).toEqual({
      kind: "nushell",
      rcPath: join(HOME, ".config", "nushell", "config.nu"),
      aliasSyntax: "alias p. = pithy",
    });
  });

  test("Windows with no unix shell → PowerShell function, never Set-Alias", async () => {
    const shell = await detectShell({ shell: "", platform: "win32", homedir: HOME });
    expect(shell?.kind).toBe("powershell");
    expect(shell?.aliasSyntax).toBe("function p. { pithy @args }");
    expect(shell?.aliasSyntax).not.toContain("Set-Alias");
    expect(shell?.rcPath).toBe(join(HOME, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"));
  });

  test("Git Bash on Windows still resolves as bash, not PowerShell", async () => {
    const shell = await detectShell({ shell: "/usr/bin/bash", platform: "win32", homedir: HOME });
    expect(shell?.kind).toBe("bash");
  });

  test("an unknown shell returns null", async () => {
    expect(await detectShell({ shell: "/usr/bin/xonsh", platform: "linux", homedir: HOME })).toBeNull();
  });

  test("an unset shell on a non-Windows platform returns null", async () => {
    expect(await detectShell({ shell: "", platform: "linux", homedir: HOME })).toBeNull();
  });
});

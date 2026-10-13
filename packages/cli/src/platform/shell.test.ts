// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { type AskProfile, askProfileOf, detectShell, profileFromOutput } from "./shell";

/** No PowerShell to ask: every edition falls back to its platform default. */
const noPowerShell: AskProfile = async () => {
  throw new Error("not on PATH");
};

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
    const shell = await detectShell({ shell: "", platform: "win32", homedir: HOME, askProfile: noPowerShell });
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

/**
 * #708: the profile path comes from PowerShell itself — `$PROFILE`, asked of each edition — because the
 * folder it lives in is not the CLI's to guess. OneDrive redirects `Documents` on Windows, and `pwsh` on
 * macOS and Linux reads `~/.config/powershell`, not `~/Documents`.
 */
describe("the PowerShell profile set, asked of PowerShell", () => {
  const PROFILE = "Microsoft.PowerShell_profile.ps1";
  const ONEDRIVE_7 = `C:\\Users\\me\\OneDrive\\Documents\\PowerShell\\${PROFILE}`;
  const ONEDRIVE_51 = `C:\\Users\\me\\OneDrive\\Documents\\WindowsPowerShell\\${PROFILE}`;

  test("on Windows, each edition's answer is its path, OneDrive redirect and all", async () => {
    const asked: string[] = [];
    const shell = await detectShell({
      shell: "",
      platform: "win32",
      homedir: HOME,
      askProfile: async (edition) => {
        asked.push(edition);
        return edition === "pwsh" ? `${ONEDRIVE_7}\r\n` : `${ONEDRIVE_51}\r\n`;
      },
    });
    expect(asked.sort()).toEqual(["pwsh", "windows-powershell"]);
    expect(shell?.rcPath).toBe(ONEDRIVE_7);
    expect(shell?.extraRcPaths).toEqual([ONEDRIVE_51]);
  });

  test("an edition that cannot be asked falls back to its own default, and the other keeps its answer", async () => {
    const shell = await detectShell({
      shell: "",
      platform: "win32",
      homedir: HOME,
      askProfile: async (edition) => {
        if (edition === "pwsh") throw new Error("pwsh is not on PATH");
        return `${ONEDRIVE_51}\r\n`;
      },
    });
    expect(shell?.rcPath).toBe(join(HOME, "Documents", "PowerShell", PROFILE));
    expect(shell?.extraRcPaths).toEqual([ONEDRIVE_51]);
  });

  test("on Windows with nothing to ask, both editions take the Documents defaults", async () => {
    const shell = await detectShell({ shell: "", platform: "win32", homedir: HOME, askProfile: noPowerShell });
    expect(shell?.rcPath).toBe(join(HOME, "Documents", "PowerShell", PROFILE));
    expect(shell?.extraRcPaths).toEqual([join(HOME, "Documents", "WindowsPowerShell", PROFILE)]);
  });

  test("pwsh on macOS and Linux answers for itself, and only pwsh is asked", async () => {
    const asked: string[] = [];
    const xdg = `/home/tester/.local/config/powershell/${PROFILE}`;
    const shell = await detectShell({
      shell: "/usr/bin/pwsh",
      platform: "linux",
      homedir: HOME,
      askProfile: async (edition) => {
        asked.push(edition);
        return `${xdg}\n`;
      },
    });
    expect(asked).toEqual(["pwsh"]);
    expect(shell?.rcPath).toBe(xdg);
    expect(shell?.extraRcPaths).toEqual([]);
  });

  test("pwsh on macOS and Linux with nothing to ask falls back to ~/.config/powershell, the file it loads", async () => {
    for (const platform of ["linux", "darwin"] as const) {
      const shell = await detectShell({
        shell: "/usr/local/bin/pwsh",
        platform,
        homedir: HOME,
        askProfile: noPowerShell,
      });
      expect(shell?.rcPath).toBe(join(HOME, ".config", "powershell", PROFILE));
    }
  });

  test("two editions that report one file are one member of the set, not two", async () => {
    const shell = await detectShell({
      shell: "",
      platform: "win32",
      homedir: HOME,
      askProfile: async () => `${ONEDRIVE_7}\r\n`,
    });
    expect(shell?.rcPath).toBe(ONEDRIVE_7);
    expect(shell?.extraRcPaths).toEqual([]);
  });
});

describe("profileFromOutput", () => {
  const WIN = `C:\\Users\\me\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1`;

  test("the trimmed line PowerShell printed, CRLF or LF", () => {
    expect(profileFromOutput(`${WIN}\r\n`, "win32")).toBe(WIN);
    expect(profileFromOutput("/home/me/.config/powershell/Microsoft.PowerShell_profile.ps1\n", "linux")).toBe(
      "/home/me/.config/powershell/Microsoft.PowerShell_profile.ps1",
    );
  });

  test("a profile on a network share, where folder redirection puts Documents, is an answer", () => {
    const unc = "\\\\fileserver\\home$\\me\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1";
    expect(profileFromOutput(`${unc}\r\n`, "win32")).toBe(unc);
  });

  test("a root-relative Windows path names no drive, so it is no answer", () => {
    expect(profileFromOutput("\\Users\\me\\Microsoft.PowerShell_profile.ps1", "win32")).toBeNull();
  });

  test("nothing, several lines, a relative path, or a file that is not a script is no answer", () => {
    expect(profileFromOutput("", "win32")).toBeNull();
    expect(profileFromOutput("\r\n", "win32")).toBeNull();
    expect(profileFromOutput(`warning: something\r\n${WIN}\r\n`, "win32")).toBeNull();
    expect(profileFromOutput("Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1", "win32")).toBeNull();
    expect(profileFromOutput("C:\\Users\\me\\profile.txt", "win32")).toBeNull();
    expect(profileFromOutput(".config/powershell/Microsoft.PowerShell_profile.ps1", "linux")).toBeNull();
  });

  test("a path that did not decode is no answer, so a mangled name never becomes a folder", () => {
    expect(
      profileFromOutput("C:\\Users\\Jos\uFFFD\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1", "win32"),
    ).toBeNull();
  });

  test("a name outside ASCII that did decode is an answer", () => {
    const path = "C:\\Users\\José\\OneDrive - Société\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1";
    expect(profileFromOutput(`${path}\r\n`, "win32")).toBe(path);
  });

  test("a path is judged by the platform it came from, not the host the CLI runs on", () => {
    expect(profileFromOutput(WIN, "linux")).toBeNull();
    expect(profileFromOutput("/home/me/x.ps1", "win32")).toBeNull();
  });
});

describe("askProfileOf", () => {
  const saved = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  let dir = "";

  afterEach(async () => {
    process.env.PATH = saved.PATH;
    if (saved.SystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = saved.SystemRoot;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  test.skipIf(process.platform === "win32")(
    "runs pwsh from PATH with fixed argv, the profile's own name never among them",
    async () => {
      // A stand-in pwsh that prints the argv it was given, one per line, then a profile path.
      dir = await mkdtemp(join(tmpdir(), "pithy-pwsh-"));
      const fake = join(dir, "pwsh");
      await writeFile(
        fake,
        '#!/bin/sh\nfor a in "$@"; do echo "arg:$a"; done\necho /home/me/.config/powershell/Microsoft.PowerShell_profile.ps1\n',
      );
      await chmod(fake, 0o755);
      process.env.PATH = dir;
      const out = await askProfileOf("linux")("pwsh");
      expect(out.split("\n").filter((line) => line.startsWith("arg:"))).toEqual([
        "arg:-NoLogo",
        "arg:-NoProfile",
        "arg:-NonInteractive",
        "arg:-Command",
        "arg:[Console]::OutputEncoding = [Text.Encoding]::UTF8; $PROFILE",
      ]);
    },
  );

  test("on Windows, a pwsh that PATH does not resolve is not run", async () => {
    process.env.PATH = "";
    await expect(askProfileOf("win32")("pwsh")).rejects.toThrow("pwsh is not on PATH.");
  });

  test("on Windows, a pwsh that PATH resolves to a batch shim is not run through cmd.exe", async () => {
    process.env.PATH = "C:\\tools";
    const fileExists = (path: string) => path === "C:\\tools\\pwsh.cmd";
    await expect(askProfileOf("win32", { fileExists })("pwsh")).rejects.toThrow(/batch/);
  });

  test("on Windows, Windows PowerShell with no SystemRoot to find System32 is not run", async () => {
    delete process.env.SystemRoot;
    await expect(askProfileOf("win32")("windows-powershell")).rejects.toThrow(/SystemRoot/);
  });
});

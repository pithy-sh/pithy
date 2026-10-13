// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AskProfile } from "../platform/shell";
import { expectConforms, runCaptured } from "../test-utils/payloadContract";
import { aliasStatus, handleHiddenFlags, installAlias, removeAlias } from "./alias";

const OPEN = "# >>> pithy alias >>>";
const ZSH_ALIAS = "alias p.='pithy'";

let home: string;
let rcPath: string;
let savedHome: string | undefined;
let savedShell: string | undefined;
let savedUserProfile: string | undefined;

/** Capture everything written to stdout during a test. */
function captureStdout(): string[] {
  const written: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  return written;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pithy-alias-"));
  rcPath = join(home, ".zshrc");
  savedHome = process.env.HOME;
  savedShell = process.env.SHELL;
  savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  // The faked home has to be visible to `os.homedir()`, which reads HOME on POSIX and USERPROFILE
  // on Windows (#701). Pinning both is the one way this harness does not assume the host's OS.
  process.env.USERPROFILE = home;
  process.env.SHELL = "/bin/zsh";
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedUserProfile;
  if (savedShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = savedShell;
  await rm(home, { recursive: true, force: true });
});

describe("installAlias", () => {
  test("writes the zsh alias block and prints the Added/Reload lines", async () => {
    const out = captureStdout();
    await installAlias();
    const contents = await readFile(rcPath, "utf8");
    expect(contents).toContain(`${OPEN}\n${ZSH_ALIAS}\n# <<< pithy alias <<<`);
    expect(out.join("")).toBe(`Added \`${ZSH_ALIAS}\` to ${rcPath}\nOpen a new terminal, or run: source ${rcPath}\n`);
  });

  test("creates a missing rc file with mode 0644", async () => {
    await installAlias();
    expect(statSync(rcPath).mode & 0o777).toBe(0o644);
  });

  test("is idempotent — a second run adds no block and prints `Already pithy.`", async () => {
    await installAlias();
    const out = captureStdout();
    await installAlias();
    const contents = await readFile(rcPath, "utf8");
    expect(contents.split(OPEN).length - 1).toBe(1); // exactly one block
    expect(out.join("")).toBe("Already pithy.\n");
  });

  test("detects a hand-added `alias p.=` without markers and writes nothing", async () => {
    await writeFile(rcPath, "alias p.=pithy\n");
    const out = captureStdout();
    await installAlias();
    expect(await readFile(rcPath, "utf8")).toBe("alias p.=pithy\n");
    expect(out.join("")).toBe("Already pithy.\n");
  });

  test("silent install writes the block and prints the confirmation", async () => {
    const out = captureStdout();
    await installAlias({ silent: true });
    expect(await readFile(rcPath, "utf8")).toContain(OPEN);
    expect(out.join("")).toContain("Added");
  });

  test("silent install on an already-installed rc prints nothing", async () => {
    await installAlias();
    const out = captureStdout();
    await installAlias({ silent: true });
    expect(out.join("")).toBe("");
  });

  test("unknown shell prints manual instructions incl. the alias line and writes no file", async () => {
    process.env.SHELL = "/usr/bin/xonsh";
    const out = captureStdout();
    await installAlias();
    expect(existsSync(rcPath)).toBe(false);
    expect(out.join("")).toContain(ZSH_ALIAS);
  });

  test("--json emits the install envelope", async () => {
    const out = captureStdout();
    await installAlias({ json: true });
    expect(JSON.parse(out.join("").trim())).toEqual({
      command: "alias",
      action: "install",
      installed: true,
      alreadyInstalled: false,
      wrote: [rcPath],
      shell: "zsh",
      rcPath,
      alias: ZSH_ALIAS,
    });
  });
});

describe("removeAlias", () => {
  test("removes only the marker block, leaving other config intact", async () => {
    await writeFile(rcPath, "export FOO=1\n");
    await installAlias();
    await writeFile(rcPath, `${await readFile(rcPath, "utf8")}alias bar='baz'\n`);

    const out = captureStdout();
    await removeAlias();
    const after = await readFile(rcPath, "utf8");
    expect(after).toContain("export FOO=1");
    expect(after).toContain("alias bar='baz'");
    expect(after).not.toContain(OPEN);
    expect(out.join("")).toBe(
      `Removed \`${ZSH_ALIAS}\` from ${rcPath}\nOpen a new terminal, or run: source ${rcPath}\n`,
    );
  });

  test("prints `No Pithy alias installed.` and exits 0 when nothing is installed", async () => {
    await writeFile(rcPath, "export FOO=1\n");
    const out = captureStdout();
    await removeAlias();
    expect(await readFile(rcPath, "utf8")).toBe("export FOO=1\n");
    expect(out.join("")).toBe("No Pithy alias installed.\n");
  });
});

describe("aliasStatus", () => {
  test("reports the rc path when installed", async () => {
    await installAlias();
    const out = captureStdout();
    await aliasStatus();
    expect(out.join("")).toBe(`Installed in ${rcPath}\n`);
  });

  test("reports not-installed with the install hint when absent", async () => {
    const out = captureStdout();
    await aliasStatus();
    expect(out.join("")).toBe("Not installed. Run `pithy alias` to install.\n");
  });

  test("prints `Unable to detect shell.` for an unknown shell", async () => {
    process.env.SHELL = "/usr/bin/xonsh";
    const out = captureStdout();
    await aliasStatus();
    expect(out.join("")).toBe("Unable to detect shell.\n");
  });
});

/**
 * #701 item 6, proven on every CI host through the shell seam (`SHELL=pwsh` selects the PowerShell
 * branch on any platform, and the `platform` seam names the edition set). Windows ships PowerShell
 * 5.1, which auto-loads `Documents\WindowsPowerShell\…`; `pwsh` 7 loads `Documents\PowerShell\…`.
 * The alias must land in both, count as installed from either, come out of both — and name the
 * files it actually touched when it repairs, reports, or removes.
 */
describe("the PowerShell alias set", () => {
  const PW7 = "Microsoft.PowerShell_profile.ps1";
  /**
   * No PowerShell to ask (#708), so each edition takes its platform default: a CI host may have `pwsh`
   * on PATH, and these cases are about the set, not about what that host's PowerShell answers.
   */
  const noPowerShell: AskProfile = async () => {
    throw new Error("not on PATH");
  };
  /** The Windows platform seam: the two-profile set is a win32 fact, proven from any CI host. */
  const WIN = { platform: "win32" as const, askProfile: noPowerShell };
  let pw7Path: string;
  let pw51Path: string;

  beforeEach(async () => {
    process.env.SHELL = "pwsh";
    pw7Path = join(home, "Documents", "PowerShell", PW7);
    pw51Path = join(home, "Documents", "WindowsPowerShell", PW7);
  });

  /** Plant a profile file, creating its family's profile directory the way a real install did. */
  async function plant(path: string, contents: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }

  test("install writes the marked block to BOTH family profiles", async () => {
    await installAlias(WIN);
    const ALIAS = "function p. { pithy @args }";
    for (const path of [pw7Path, pw51Path]) {
      expect(await readFile(path, "utf8")).toContain(`${OPEN}\n${ALIAS}\n# <<< pithy alias <<<`);
    }
  });

  test("off Windows, pwsh gets one profile, in ~/.config/powershell where it loads it — no 5.1 file", async () => {
    // The platform seam, not the host: this proves the non-win32 shape from any CI box, and on a
    // Windows host `process.platform` would genuinely include the 5.1 profile. `pwsh` on macOS and
    // Linux loads `~/.config/powershell`, never `~/Documents/PowerShell` (#708).
    await installAlias({ platform: "linux", askProfile: noPowerShell });
    expect(await readFile(join(home, ".config", "powershell", PW7), "utf8")).toContain(OPEN);
    await expect(readFile(pw7Path, "utf8")).rejects.toThrow();
    await expect(readFile(pw51Path, "utf8")).rejects.toThrow();
  });

  test("the block goes where PowerShell says its profile is, and status and remove read the same file", async () => {
    // #708: a redirected Documents. `$PROFILE` names the real folder, so the guessed one stays untouched.
    const reported = join(home, "OneDrive", "Documents", "PowerShell", PW7);
    const asked = { platform: "linux" as const, askProfile: async () => `${reported}\n` };
    await installAlias(asked);
    expect(await readFile(reported, "utf8")).toContain(OPEN);
    await expect(readFile(pw7Path, "utf8")).rejects.toThrow();

    const status = captureStdout();
    await aliasStatus(asked);
    expect(status.join("")).toBe(`Installed in ${reported}\n`);

    await removeAlias(asked);
    expect(await readFile(reported, "utf8")).not.toContain(OPEN);
  });

  test("idempotence is set-wide: a block in one profile counts as installed and is not duplicated", async () => {
    // The state #701's host was in: a previous pithy wrote only the 7 profile. Re-running the fixed
    // CLI reads the set, sees a block, and reports installed — and writing nothing means no file
    // grew a second block. `Already pithy.` is the sentence for a run that wrote nothing, which a
    // fully-topped set is.
    await installAlias(WIN);
    const out = captureStdout();
    await installAlias(WIN);
    expect(out.join("")).toBe("Already pithy.\n");
    for (const path of [pw7Path, pw51Path]) {
      const text = await readFile(path, "utf8");
      expect(text.split(OPEN).length - 1).toBe(1);
    }
  });

  test("an old install in the 7 profile alone is repaired — and the repair names the file it wrote", async () => {
    // The #701 host's exact state: the previous CLI wrote only Documents\PowerShell. Re-running
    // alias must fill the 5.1 profile — the family that ships with Windows and never got the block
    // — and say so: a command that edits a file the shell runs at startup names the file it
    // changed. `Already pithy.` would hide a write.
    await plant(pw7Path, `${OPEN}\nfunction p. { pithy @args }\n# <<< pithy alias <<<\n`);
    const out = captureStdout();
    await installAlias(WIN);
    expect(out.join("")).toBe(
      `Added \`function p. { pithy @args }\` to ${pw51Path}\nOpen a new terminal, or run: source ${pw7Path}\n`,
    );
    expect(await readFile(pw51Path, "utf8")).toContain("function p. { pithy @args }");
  });

  test("the repair's --json payload separates the fact from the write: alreadyInstalled plus wrote", async () => {
    await plant(pw7Path, `${OPEN}\nfunction p. { pithy @args }\n# <<< pithy alias <<<\n`);
    const out = captureStdout();
    await installAlias({ ...WIN, json: true });
    const payload = JSON.parse(out.join(""));
    expect(payload.alreadyInstalled).toBe(true);
    expect(payload.wrote).toEqual([pw51Path]);
  });

  test("status reports installed from the 5.1 profile alone, and names only the file that carries it", async () => {
    await plant(pw51Path, `# pre-existing\n${OPEN}\nfunction p. { pithy @args }\n# <<< pithy alias <<<\n`);
    const out = captureStdout();
    await aliasStatus(WIN);
    // The block lives only in the 5.1 file, so the 5.1 file is the whole of the report. Naming the
    // set when only one member carries the block makes a claim about the other the reader can check
    // and find false.
    expect(out.join("")).toBe(`Installed in ${pw51Path}\n`);
  });

  test("remove names the files it actually removed from — not the whole set", async () => {
    // A set topped up on one member only: remove takes the block out of the 7 profile and says the
    // 7 profile, never the 5.1 path it did not touch.
    await plant(pw7Path, `${OPEN}\nfunction p. { pithy @args }\n# <<< pithy alias <<<\n`);
    const out = captureStdout();
    await removeAlias(WIN);
    expect(out.join("")).toBe(
      `Removed \`function p. { pithy @args }\` from ${pw7Path}\nOpen a new terminal, or run: source ${pw7Path}\n`,
    );
  });

  test("remove takes the block out of both profiles and leaves the rest of each byte-intact", async () => {
    await plant(pw7Path, "Set-StrictMode -Version Latest\n");
    await plant(pw51Path, "# 5.1 baseline\n");
    await installAlias(WIN);
    await removeAlias(WIN);
    expect(await readFile(pw7Path, "utf8")).toBe("Set-StrictMode -Version Latest\n");
    expect(await readFile(pw51Path, "utf8")).toBe("# 5.1 baseline\n");
  });

  test("the --json install payload carries the full rcPaths set, POSIX payloads carry none", async () => {
    const out = captureStdout();
    await installAlias({ ...WIN, json: true });
    const payload = JSON.parse(out.join(""));
    expect(payload.rcPath).toBe(pw7Path);
    expect(payload.rcPaths).toEqual([pw7Path, pw51Path]);
    expect(payload.wrote).toEqual([pw7Path, pw51Path]);

    const posix = captureStdout();
    process.env.SHELL = "/bin/zsh";
    await installAlias({ json: true });
    expect(JSON.parse(posix.join("")).rcPaths).toBeUndefined();
  });
});

describe("handleHiddenFlags", () => {
  test("--pithiest prints `Pithy enough.` and writes nothing", async () => {
    await writeFile(rcPath, "export FOO=1\n");
    const out = captureStdout();
    const handled = await handleHiddenFlags(["--pithiest"]);
    expect(handled).toBe(true);
    expect(out.join("")).toBe("Pithy enough.\n");
    expect(await readFile(rcPath, "utf8")).toBe("export FOO=1\n");
  });

  test("--pithier is functionally identical to `pithy alias`", async () => {
    const out1 = captureStdout();
    await installAlias();
    const installOutput = out1.join("");
    const installFile = await readFile(rcPath, "utf8");
    vi.restoreAllMocks();
    await rm(rcPath, { force: true });

    const out2 = captureStdout();
    const handled = await handleHiddenFlags(["--pithier"]);
    expect(handled).toBe(true);
    expect(out2.join("")).toBe(installOutput);
    expect(await readFile(rcPath, "utf8")).toBe(installFile);
  });

  test("returns false when no hidden flag is present", async () => {
    expect(await handleHiddenFlags(["alias", "--status"])).toBe(false);
  });
});

/**
 * **Every payload names the command, and every payload names its action.**
 *
 * `logManualInstructions` emitted `{ shell, manual, alias }` for both install and remove, so an agent
 * keying on `action` — as every other alias payload lets it — read `undefined` on the one path where
 * nothing was written to any file. That is the case it most needs to detect, and the one the payload
 * would not say. `command` was missing from all five, alone in this CLI. #231.
 */
describe("the alias --json payloads", () => {
  /** Every alias payload, by the path that produces it. */
  async function payloads(): Promise<Record<string, Record<string, unknown>>> {
    const emitted: Record<string, Record<string, unknown>> = {};
    const read = (out: string[]): Record<string, unknown> => JSON.parse(out.join("").trim()) as Record<string, unknown>;

    let out = captureStdout();
    await installAlias({ json: true });
    emitted.install = read(out);

    out = captureStdout();
    await installAlias({ json: true }); // the same command again: already installed
    emitted.installAgain = read(out);

    out = captureStdout();
    await aliasStatus({ json: true });
    emitted.status = read(out);

    out = captureStdout();
    await removeAlias({ json: true });
    emitted.remove = read(out);

    // The unknown shell: nothing is written, and there is no rc file to name.
    process.env.SHELL = "/usr/bin/xonsh";
    out = captureStdout();
    await installAlias({ json: true });
    emitted.manualInstall = read(out);

    out = captureStdout();
    await removeAlias({ json: true });
    emitted.manualRemove = read(out);

    out = captureStdout();
    await aliasStatus({ json: true });
    emitted.manualStatus = read(out);
    return emitted;
  }

  test("carry `command` and `action`, on every path including the one that writes nothing", async () => {
    const emitted = await payloads();
    expect(Object.keys(emitted)).toHaveLength(7);
    for (const [path, payload] of Object.entries(emitted)) {
      expect({ path, command: payload.command }).toEqual({ path, command: "alias" });
      expect({ path, action: payload.action }).toEqual({
        path,
        action: path.toLowerCase().includes("remove")
          ? "remove"
          : path.toLowerCase().includes("status")
            ? "status"
            : "install",
      });
    }
  });

  test("the unknown-shell payload says which action was refused, and that nothing was written", async () => {
    const emitted = await payloads();
    expect(emitted.manualInstall).toEqual({
      command: "alias",
      action: "install",
      shell: null,
      manual: true,
      alias: ZSH_ALIAS,
    });
    expect(emitted.manualRemove).toMatchObject({ action: "remove", manual: true });
  });
});

/** Every path, run through the real command and held to the schema `pithy schema alias` publishes (#697). */
describe("pithy alias --json conforms to its published payload", () => {
  test.each([
    ["install", ["--json"]],
    ["install again", ["--json"]],
    ["status", ["--status", "--json"]],
    ["remove", ["--remove", "--json"]],
  ])("%s", async (_, rawArgs) => {
    if (_ === "install again") await installAlias();
    await expectConforms("alias", await runCaptured("alias", rawArgs));
  });

  test.each([["--json"], ["--remove", "--json"], ["--status", "--json"]])("unknown shell: %s", async (...rawArgs) => {
    process.env.SHELL = "/usr/bin/xonsh";
    await expectConforms("alias", await runCaptured("alias", rawArgs));
  });
});

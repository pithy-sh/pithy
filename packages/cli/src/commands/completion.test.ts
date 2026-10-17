// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { completionScript, loadingLine } from "../completion/scripts";
import type { AskProfile } from "../platform/shell";
import { captureStdout, expectConforms, runCaptured } from "../test-utils/payloadContract";
import { installAlias } from "./alias";
import { completionStatus, installCompletion, printScript, removeCompletion } from "./completion";

const OPEN = "# >>> pithy completion >>>";
const CLOSE = "# <<< pithy completion <<<";
const ZSH_LINE = loadingLine("zsh");

let home: string;
let rcPath: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pithy-completion-"));
  rcPath = join(home, ".zshrc");
  for (const key of ["HOME", "USERPROFILE", "SHELL"]) saved[key] = process.env[key];
  // `os.homedir()` reads HOME on POSIX and USERPROFILE on Windows; pin both, as alias.test.ts does.
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.SHELL = "/bin/zsh";
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(home, { recursive: true, force: true });
});

/** Run `work` with stdout swallowed, for the setup a case is not about. */
async function quietly(work: () => Promise<void>): Promise<void> {
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await work();
  } finally {
    spy.mockRestore();
  }
}

describe("printScript", () => {
  test.each(["bash", "zsh", "fish", "powershell"])("%s prints that shell's script, exactly", (shell) => {
    const out = captureStdout();
    printScript(shell);
    expect(out.join("")).toBe(completionScript(shell as "bash"));
  });

  test("an unknown shell is refused, naming the four", () => {
    const thrown = (() => {
      try {
        printScript("tcsh");
      } catch (error) {
        return error;
      }
      return undefined;
    })() as PithyError;
    expect(thrown).toBeInstanceOf(PithyError);
    expect(thrown.payload.code).toBe("validation/invalid_input");
    expect(thrown.payload.message).toBe("No completion for tcsh.");
    expect(thrown.payload.action).toBe("Pass bash, zsh, fish or powershell.");
  });

  test("nushell, which pithy alias covers, is refused the same way", () => {
    expect(() => printScript("nushell")).toThrow("No completion for nushell.");
  });
});

describe("installCompletion", () => {
  test("writes the loading line into the rc file pithy alias uses, in a marked block", async () => {
    const out = captureStdout();
    await installCompletion();
    expect(await readFile(rcPath, "utf8")).toBe(`\n${OPEN}\n${ZSH_LINE}\n${CLOSE}\n`);
    expect(out.join("")).toBe(`Added completion to ${rcPath}\nOpen a new terminal, or run: source ${rcPath}\n`);
  });

  test("lands beside the alias, in the same file", async () => {
    await quietly(() => installAlias());
    await quietly(() => installCompletion());
    const contents = await readFile(rcPath, "utf8");
    expect(contents).toContain("# >>> pithy alias >>>");
    expect(contents).toContain(OPEN);
  });

  test("a second run changes nothing, and says so", async () => {
    await quietly(() => installCompletion());
    const before = await readFile(rcPath, "utf8");
    const out = captureStdout();
    await installCompletion();
    expect(await readFile(rcPath, "utf8")).toBe(before);
    expect(out.join("")).toBe("Already pithy.\n");
  });

  test("silent says nothing on a second run", async () => {
    await quietly(() => installCompletion());
    const out = captureStdout();
    await installCompletion({ silent: true });
    expect(out.join("")).toBe("");
  });

  test("a loader somebody wrote by hand counts as installed, and nothing is added", async () => {
    await writeFile(rcPath, "source <(pithy completion zsh)\n");
    const out = captureStdout();
    await installCompletion();
    expect(await readFile(rcPath, "utf8")).toBe("source <(pithy completion zsh)\n");
    expect(out.join("")).toBe("Already pithy.\n");
  });

  test("PowerShell on Windows writes both profiles, as the alias does", async () => {
    const seven = join(home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1");
    const five = join(home, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1");
    const askProfile: AskProfile = async (edition) => (edition === "pwsh" ? seven : five);
    process.env.SHELL = "";
    const out = captureStdout();
    await installCompletion({ platform: "win32", askProfile, json: true });
    const payload = JSON.parse(out.join(""));
    expect(payload).toMatchObject({
      action: "install",
      shell: "powershell",
      wrote: [seven, five],
      rcPaths: [seven, five],
    });
    for (const path of [seven, five]) expect(await readFile(path, "utf8")).toContain(loadingLine("powershell"));
  });

  test("nushell is detected and not covered: nothing is written, and it says what to do", async () => {
    process.env.SHELL = "/usr/bin/nu";
    const out = captureStdout();
    await installCompletion();
    expect(out.join("")).toBe(
      "Completion covers bash, zsh, fish and PowerShell. Not nushell.\nRun `pithy completion <shell>` and load what it prints from your shell's startup file.\n",
    );
    await expect(readFile(join(home, ".config", "nushell", "config.nu"), "utf8")).rejects.toThrow();
  });

  test("a shell nobody detected writes nothing", async () => {
    process.env.SHELL = "/usr/bin/xonsh";
    const out = captureStdout();
    await installCompletion();
    expect(out.join("")).toBe(
      "Couldn't detect your shell.\nRun `pithy completion <shell>` and load what it prints from your shell's startup file.\n",
    );
  });
});

describe("removeCompletion", () => {
  test("removes exactly its block, and leaves the alias and everything else byte for byte", async () => {
    await writeFile(rcPath, "export KEEP=1\n");
    await quietly(() => installAlias());
    const withAlias = await readFile(rcPath, "utf8");
    await quietly(() => installCompletion());
    const out = captureStdout();
    await removeCompletion();
    expect(await readFile(rcPath, "utf8")).toBe(withAlias);
    expect(out.join("")).toBe(`Removed completion from ${rcPath}\nOpen a new terminal, or run: source ${rcPath}\n`);
  });

  test("nothing to remove is not an error", async () => {
    const out = captureStdout();
    await removeCompletion();
    expect(out.join("")).toBe("No Pithy completion installed.\n");
  });

  test("a loader somebody wrote by hand is theirs, and stays", async () => {
    await writeFile(rcPath, "source <(pithy completion zsh)\n");
    captureStdout();
    await removeCompletion();
    expect(await readFile(rcPath, "utf8")).toBe("source <(pithy completion zsh)\n");
  });
});

describe("completionStatus", () => {
  test("names the file that carries the block", async () => {
    await quietly(() => installCompletion());
    const out = captureStdout();
    await completionStatus();
    expect(out.join("")).toBe(`Installed in ${rcPath}\n`);
  });

  test("says how to install when it is not", async () => {
    const out = captureStdout();
    await completionStatus();
    expect(out.join("")).toBe("Not installed. Run `pithy completion` to install.\n");
  });

  test("reads only", async () => {
    captureStdout();
    await completionStatus();
    await expect(readFile(rcPath, "utf8")).rejects.toThrow();
  });
});

/** Every path, run through the real command and held to the schema `pithy schema completion` publishes. */
describe("pithy completion --json conforms to its published payload", () => {
  test.each([
    ["script", ["bash", "--json"]],
    ["install", ["--json"]],
    ["install again", ["--json"]],
    ["status", ["--status", "--json"]],
    ["remove", ["--remove", "--json"]],
  ])("%s", async (name, rawArgs) => {
    if (name === "install again") await quietly(() => installCompletion());
    await expectConforms("completion", await runCaptured("completion", rawArgs));
  });

  test.each([["--json"], ["--remove", "--json"], ["--status", "--json"]])("nushell: %s", async (...rawArgs) => {
    process.env.SHELL = "/usr/bin/nu";
    await expectConforms("completion", await runCaptured("completion", rawArgs));
  });

  test.each([["--json"], ["--status", "--json"]])("unknown shell: %s", async (...rawArgs) => {
    process.env.SHELL = "/usr/bin/xonsh";
    await expectConforms("completion", await runCaptured("completion", rawArgs));
  });

  test("the install payload names the shell, the file and the line", async () => {
    const [line] = await runCaptured("completion", ["--json"]);
    expect(JSON.parse(line ?? "")).toEqual({
      command: "completion",
      schemaVersion: 1,
      action: "install",
      installed: true,
      alreadyInstalled: false,
      wrote: [rcPath],
      shell: "zsh",
      rcPath,
      line: ZSH_LINE,
    });
  });
});

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile, execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { POWERSHELL_ALIAS } from "../platform/shell";
import { COMPLETE_COMMAND } from "./complete";
import { COMPLETION_SHELLS, completionScript, isCompletionShell, loadingLine } from "./scripts";

const run = promisify(execFile);

/** Print what bash's completion function left in COMPREPLY, one candidate a line. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: a bash expansion is the probe, not a template.
const PRINT_REPLY = 'printf "%s\\n" "${COMPREPLY[@]}"';

/**
 * bash's own path, so a case can hand it a PATH that holds no `pithy` and still start it.
 *
 * Every bash here runs `--norc`. Node hands a child its stdin over a socket pair, and bash reads a socket on
 * stdin as a remote shell daemon and sources `~/.bashrc` — under turbo, where the shell level is 1, it did,
 * and the developer's `PATH` put their own installed `pithy` ahead of the stand-in.
 */
const BASH = execFileSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).trim();

/** Whether `shell` can be run here. A shell that is not installed is a shell these cases cannot ask. */
function installed(shell: string): boolean {
  try {
    execFileSync(shell, ["-c", "exit 0"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-completion-scripts-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * A stand-in `pithy` on a PATH of its own: it records the one argument it was handed and answers with a
 * fixed list, so the case below asks bash's own machinery and nothing of the real binary.
 */
async function fakePithy(answer: string): Promise<string> {
  const bin = join(dir, "bin");
  await run("mkdir", ["-p", bin]);
  const script = join(bin, "pithy");
  await writeFile(
    script,
    `#!/bin/sh\nprintf '%s' "$2" > "${join(dir, "asked")}"\nprintf '%b' '${answer.replace(/\n/g, "\\n").replace(/\t/g, "\\t")}'\n`,
  );
  await chmod(script, 0o755);
  return bin;
}

describe("the scripts", () => {
  test("cover exactly bash, zsh, fish and PowerShell", () => {
    expect(COMPLETION_SHELLS).toEqual(["bash", "zsh", "fish", "powershell"]);
    expect(isCompletionShell("nushell")).toBe(false);
    expect(isCompletionShell("zsh")).toBe(true);
  });

  test.each(COMPLETION_SHELLS)("%s asks the binary, and holds no command of its own", (shell) => {
    const script = completionScript(shell);
    expect(script).toContain(`pithy ${COMPLETE_COMMAND}`);
    for (const command of ["secrets", "deploy", "migrate", "--env"]) expect(script).not.toContain(command);
  });

  test.each(["bash", "zsh", "powershell"] as const)("%s registers p. by name", (shell) => {
    expect(completionScript(shell)).toMatch(/['\s]p\.['\s,]/);
  });

  test("fish leaves p. to its alias, which wraps pithy, so a Tab asks the binary once", () => {
    expect(completionScript("fish")).not.toContain("-c p.");
  });

  test("bash accepts the script", async () => {
    await run("bash", ["--norc", "-n", "-c", completionScript("bash")]);
  });

  test.skipIf(!installed("zsh"))("zsh accepts the script", async () => {
    await run("zsh", ["-n", "-c", completionScript("zsh")]);
  });

  test.skipIf(!installed("fish"))("fish accepts the script", async () => {
    await run("fish", ["--no-execute", "-c", completionScript("fish")]);
  });

  test.skipIf(!installed("pwsh"))("PowerShell accepts the script", async () => {
    const path = join(dir, "completion.ps1");
    await writeFile(path, completionScript("powershell"));
    const check = `$errors = $null; [System.Management.Automation.Language.Parser]::ParseFile('${path}', [ref]$null, [ref]$errors) | Out-Null; if ($errors.Count) { $errors | ForEach-Object { $_.Message }; exit 1 }`;
    await run("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", check]);
  });

  test.skipIf(!installed("pwsh"))(
    "PowerShell completes pithy, and p. as pithy alias defines it, by asking the binary",
    async () => {
      const bin = await fakePithy("secrets\tSecrets\nsetup\n");
      const path = join(dir, "completion.ps1");
      await writeFile(path, completionScript("powershell"));
      const probe = [
        `. '${path}'`,
        POWERSHELL_ALIAS,
        "foreach ($line in 'pithy se', 'p. se') {",
        "  $result = TabExpansion2 $line $line.Length",
        "  ($result.CompletionMatches | ForEach-Object { $_.CompletionText }) -join ','",
        "  Get-Content -Raw (Join-Path $env:PITHY_PROBE_DIR 'asked')",
        "}",
      ].join("\n");
      const { stdout } = await run("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", probe], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PITHY_PROBE_DIR: dir },
      });
      expect(stdout.split(/\r?\n/).filter((line) => line !== "")).toEqual([
        "secrets,setup",
        "pithy se",
        "secrets,setup",
        "p. se",
      ]);
    },
    60_000,
  );

  test("bash hands the binary the line up to the cursor, and offers what comes back", async () => {
    const bin = await fakePithy("secrets\tSecrets\nsetup\n");
    const probe = [
      completionScript("bash"),
      'COMP_LINE="pithy se"; COMP_POINT=8; COMP_WORDS=(pithy se); COMP_CWORD=1',
      "_pithy_complete",
      PRINT_REPLY,
    ].join("\n");
    const { stdout } = await run("bash", ["--norc", "-c", probe], {
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
    });
    expect(stdout).toBe("secrets\nsetup\n");
    expect(await run("cat", [join(dir, "asked")]).then((out) => out.stdout)).toBe("pithy se");
  });

  test("bash offers a joined --flag=value in the part of the word it counts as current", async () => {
    const bin = await fakePithy("--env=staging\n");
    const probe = [
      completionScript("bash"),
      'COMP_LINE="pithy migrate --env=st"; COMP_POINT=22; COMP_WORDS=(pithy migrate --env = st); COMP_CWORD=4',
      "_pithy_complete",
      PRINT_REPLY,
    ].join("\n");
    const { stdout } = await run("bash", ["--norc", "-c", probe], {
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
    });
    expect(stdout).toBe("staging\n");
  });

  test("bash registers p. as well as pithy", async () => {
    const { stdout } = await run("bash", ["--norc", "-c", `${completionScript("bash")}\ncomplete -p p.`]);
    expect(stdout.trim()).toBe("complete -F _pithy_complete p.");
  });
});

describe("the loading lines", () => {
  test.each(COMPLETION_SHELLS)(
    "%s loads the script from the binary on the PATH, and only when there is one",
    (shell) => {
      const line = loadingLine(shell);
      expect(line).toContain(`pithy completion ${shell}`);
      expect(line).toMatch(/command -v pithy|type -q pithy|Get-Command pithy/);
    },
  );

  test("bash runs its line cleanly where no pithy is installed", async () => {
    const { stdout, stderr } = await run(BASH, ["--norc", "-c", loadingLine("bash")], { env: { PATH: dir } });
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });
});

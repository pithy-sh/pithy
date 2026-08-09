// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { aliasStatus, handleHiddenFlags, installAlias, removeAlias } from "./alias";

const OPEN = "# >>> pithy alias >>>";
const ZSH_ALIAS = "alias p.='pithy'";

let home: string;
let rcPath: string;
let savedHome: string | undefined;
let savedShell: string | undefined;

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
  process.env.HOME = home;
  process.env.SHELL = "/bin/zsh";
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
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
    expect(out.join("")).toBe(`Added \`${ZSH_ALIAS}\` to ${rcPath}\nReload your shell or run: source ${rcPath}\n`);
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
    expect(out.join("")).toBe(`Removed \`${ZSH_ALIAS}\` from ${rcPath}\nReload your shell or run: source ${rcPath}\n`);
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

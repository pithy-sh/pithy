// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { sourceFiles, sourcePaths } from "../ci/sourceFiles";
import { type EditorProcess, openInEditor, requireEditor, resolveEditor, runEditor } from "./editor";

/** A POSIX host with every candidate installed and a human at the terminal — the ordinary case. */
const posix = { platform: "linux" as const, interactive: true, hasCommand: () => true };

/** The error a call is expected to refuse with, as a `PithyError`. Anything else fails loudly. */
function refusal(work: () => unknown): PithyError {
  try {
    work();
  } catch (error) {
    if (error instanceof PithyError) return error;
    throw error;
  }
  throw new Error("expected a refusal, got a resolved editor");
}

describe("resolveEditor — $VISUAL, then $EDITOR, then the platform default", () => {
  test("$VISUAL wins over $EDITOR", () => {
    const editor = resolveEditor({ ...posix, env: { VISUAL: "vi", EDITOR: "nano" } });
    expect(editor).toEqual({ command: "vi", args: [], source: "VISUAL" });
  });

  test("$EDITOR when $VISUAL is unset", () => {
    const editor = resolveEditor({ ...posix, env: { EDITOR: "nano" } });
    expect(editor).toEqual({ command: "nano", args: [], source: "EDITOR" });
  });

  test("a variable set to whitespace is not an editor — it falls through", () => {
    // `export EDITOR=` in a shell profile is a set variable holding nothing. Treating it as an
    // editor spawns the empty string, which is an ENOENT with nothing useful in it.
    expect(resolveEditor({ ...posix, env: { VISUAL: "   ", EDITOR: "nano" } }).command).toBe("nano");
    expect(resolveEditor({ ...posix, env: { VISUAL: "", EDITOR: "" } }).source).toBe("default");
  });

  test("the Windows default is notepad", () => {
    expect(resolveEditor({ platform: "win32", interactive: true, env: {}, hasCommand: () => false })).toEqual({
      command: "notepad",
      args: [],
      source: "default",
    });
  });

  test("the POSIX default is nano when nano is installed", () => {
    const seen: string[] = [];
    const editor = resolveEditor({
      platform: "linux",
      interactive: true,
      env: {},
      hasCommand: (command) => {
        seen.push(command);
        return command === "nano";
      },
    });
    expect(editor).toEqual({ command: "nano", args: [], source: "default" });
    expect(seen).toContain("nano");
  });

  test("and vi when it is not — the one editor a POSIX box is required to have", () => {
    expect(resolveEditor({ platform: "darwin", interactive: true, env: {}, hasCommand: () => false })).toEqual({
      command: "vi",
      args: [],
      source: "default",
    });
  });

  test("Windows never probes for nano — the default there is not a POSIX editor", () => {
    const seen: string[] = [];
    resolveEditor({
      platform: "win32",
      interactive: true,
      env: {},
      hasCommand: (command) => {
        seen.push(command);
        return true;
      },
    });
    expect(seen).toEqual([]);
  });

  test("the variable carries arguments, and they are kept in order", () => {
    expect(resolveEditor({ ...posix, env: { EDITOR: "code --wait --new-window" } })).toEqual({
      command: "code",
      args: ["--wait", "--new-window"],
      source: "EDITOR",
    });
  });

  test("a quoted path with a space in it is one argument, not two", () => {
    const editor = resolveEditor({
      ...posix,
      env: { EDITOR: '"/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl" --wait' },
    });
    expect(editor.command).toBe("/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl");
    expect(editor.args).toEqual(["--wait"]);
  });
});

describe("resolveEditor — an editor that returns before the edit is finished", () => {
  test("`code` is refused, and the flag to add is named", () => {
    const error = refusal(() => resolveEditor({ ...posix, env: { EDITOR: "code" } }));
    expect(error.payload.message).toContain("code");
    expect(error.payload.message).toContain("EDITOR");
    expect(`${error.payload.message} ${error.payload.action}`).toContain("--wait");
  });

  test("`code --wait` is exactly what it asked for, so it passes", () => {
    expect(resolveEditor({ ...posix, env: { EDITOR: "code --wait" } }).args).toEqual(["--wait"]);
  });

  test("the short spelling of the same flag passes too", () => {
    expect(resolveEditor({ ...posix, env: { EDITOR: "code -w" } }).args).toEqual(["-w"]);
  });

  test("a full path to the same editor is the same editor", () => {
    const error = refusal(() => resolveEditor({ ...posix, env: { EDITOR: "/usr/local/bin/code" } }));
    expect(error.payload.action).toContain("--wait");
  });

  test("the Windows spelling is the same editor — case and `.exe` are not a disguise", () => {
    const error = refusal(() =>
      resolveEditor({ platform: "win32", interactive: true, hasCommand: () => false, env: { EDITOR: "Code.EXE" } }),
    );
    expect(error.payload.action).toContain("--wait");
  });

  test("gvim is named with its own flag, which is not --wait", () => {
    const error = refusal(() => resolveEditor({ ...posix, env: { EDITOR: "gvim" } }));
    expect(error.payload.action).toContain("-f");
    expect(error.payload.action).not.toContain("--wait");
    expect(resolveEditor({ ...posix, env: { EDITOR: "gvim -f" } }).args).toEqual(["-f"]);
  });

  test("sublime is named with --wait", () => {
    expect(refusal(() => resolveEditor({ ...posix, env: { EDITOR: "subl" } })).payload.action).toContain("--wait");
  });

  test("the refusal names the variable it read, so the adopter edits the right line", () => {
    const error = refusal(() => resolveEditor({ ...posix, env: { VISUAL: "code", EDITOR: "vi" } }));
    expect(error.payload.message).toContain("VISUAL");
    expect(error.payload.action).toContain("VISUAL");
  });

  test("a terminal editor is never refused — the gate is about waiting, not about being a GUI", () => {
    for (const command of ["vi", "vim", "nvim", "nano", "emacs", "helix", "hx", "micro", "notepad"]) {
      expect(resolveEditor({ ...posix, env: { EDITOR: command } }).command).toBe(command);
    }
  });
});

describe("requireEditor — nothing to open it with", () => {
  test("a non-interactive run refuses, and the refusal names the file", () => {
    const error = refusal(() =>
      requireEditor("/home/dev/.config/pithy/replay/secrets.jsonc", { ...posix, interactive: false }),
    );
    expect(error.payload.message).toContain("/home/dev/.config/pithy/replay/secrets.jsonc");
  });

  test("the path is in `message`, which is the field a --json consumer still receives", () => {
    // `detail` is stripped by the HTTP codec and never rendered to a terminal. A path only an
    // operator can act on has to survive both, so it goes in `message`.
    const error = refusal(() => requireEditor("/tmp/replay/secrets.jsonc", { ...posix, interactive: false }));
    expect(error.payload.message).toContain("/tmp/replay/secrets.jsonc");
  });

  test("no TTY is answered before the editor is even looked at", () => {
    // CI with `EDITOR=code` set must hear that there is no terminal, not that its editor lacks a
    // flag — the flag is not the thing standing in the way, and hanging on a spawned window is.
    const error = refusal(() =>
      requireEditor("/tmp/replay/secrets.jsonc", { ...posix, interactive: false, env: { EDITOR: "code" } }),
    );
    expect(error.payload.message).toContain("/tmp/replay/secrets.jsonc");
    expect(error.payload.action ?? "").not.toContain("--wait");
  });

  test("a terminal with an editor resolves", () => {
    expect(requireEditor("/tmp/x", { ...posix, env: { EDITOR: "nano" } })).toEqual({
      command: "nano",
      args: [],
      source: "EDITOR",
    });
  });
});

/** A stand-in child process that closes with `code` on the next tick. */
function child(code: number | null, error?: Error): EditorProcess {
  const listeners = new Map<string, (value: never) => void>();
  queueMicrotask(() => {
    if (error) listeners.get("error")?.(error as never);
    else listeners.get("close")?.(code as never);
  });
  return {
    on(event: string, listener: (value: never) => void) {
      listeners.set(event, listener);
    },
  } as EditorProcess;
}

describe("runEditor", () => {
  const editor = { command: "nano", args: ["-w"], source: "EDITOR" } as const;

  test("the file is the last argument, after the editor's own", async () => {
    const calls: { command: string; args: readonly string[]; shell: boolean }[] = [];
    await runEditor(editor, "/tmp/replay/secrets.edit.jsonc", {
      platform: "linux",
      spawn: (command, args, options) => {
        calls.push({ command, args, shell: options.shell });
        return child(0);
      },
    });
    expect(calls).toEqual([{ command: "nano", args: ["-w", "/tmp/replay/secrets.edit.jsonc"], shell: false }]);
  });

  test("it resolves with the editor's exit status", async () => {
    expect(await runEditor(editor, "/tmp/x", { platform: "linux", spawn: () => child(0) })).toBe(0);
    expect(await runEditor(editor, "/tmp/x", { platform: "linux", spawn: () => child(1) })).toBe(1);
  });

  test("a signal is not a clean exit", async () => {
    // `code` is null when the editor was killed. Reading that as 0 would take a `kill -9` for a
    // finished edit and write whatever the half-saved file happened to hold.
    expect(await runEditor(editor, "/tmp/x", { platform: "linux", spawn: () => child(null) })).not.toBe(0);
  });

  test("an editor that is not installed is a PithyError naming it, not a raw ENOENT", async () => {
    const enoent = Object.assign(new Error("spawn nano ENOENT"), { code: "ENOENT" });
    const error = await runEditor(editor, "/tmp/x", {
      platform: "linux",
      spawn: () => child(0, enoent),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.message).toContain("nano");
  });

  test("Windows runs through a shell, because a `.cmd` shim cannot be spawned without one", async () => {
    // Every GUI editor on Windows is a `.cmd` shim (`code.cmd`, `subl.cmd`), and Node refuses to
    // spawn one directly. The whole command line is one string cmd.exe re-splits, so the file — which
    // lives under `%APPDATA%\pithy\<project>\` and routinely contains a space — is quoted here.
    const calls: { command: string; args: readonly string[]; shell: boolean }[] = [];
    await runEditor({ command: "code", args: ["--wait"], source: "EDITOR" }, "C:\\Users\\Jim Scott\\s.jsonc", {
      platform: "win32",
      spawn: (command, args, options) => {
        calls.push({ command, args, shell: options.shell });
        return child(0);
      },
    });
    expect(calls).toEqual([{ command: "code", args: ["--wait", '"C:\\Users\\Jim Scott\\s.jsonc"'], shell: true }]);
  });

  test("a Windows editor path with a space is quoted too", async () => {
    const calls: string[] = [];
    await runEditor({ command: "C:\\Program Files\\Vim\\gvim.exe", args: ["-f"], source: "EDITOR" }, "C:\\s.jsonc", {
      platform: "win32",
      spawn: (command) => {
        calls.push(command);
        return child(0);
      },
    });
    expect(calls).toEqual(['"C:\\Program Files\\Vim\\gvim.exe"']);
  });

  test("POSIX never uses a shell — the file is an argument, not a word to re-split", async () => {
    const calls: { args: readonly string[]; shell: boolean }[] = [];
    await runEditor(editor, "/tmp/a b/secrets.jsonc", {
      platform: "linux",
      spawn: (_command, args, options) => {
        calls.push({ args, shell: options.shell });
        return child(0);
      },
    });
    expect(calls).toEqual([{ args: ["-w", "/tmp/a b/secrets.jsonc"], shell: false }]);
  });
});

describe("openInEditor", () => {
  test("refuses without a terminal before anything is spawned", async () => {
    let spawned = 0;
    const error = await openInEditor("/tmp/replay/secrets.jsonc", {
      ...posix,
      interactive: false,
      spawn: () => {
        spawned += 1;
        return child(0);
      },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.message).toContain("/tmp/replay/secrets.jsonc");
    expect(spawned).toBe(0);
  });

  test("resolves and runs in one call, for a caller with nothing else to decide", async () => {
    const calls: string[][] = [];
    const status = await openInEditor("/tmp/x", {
      ...posix,
      env: { EDITOR: "nano" },
      spawn: (command, args) => {
        calls.push([command, ...args]);
        return child(0);
      },
    });
    expect(status).toBe(0);
    expect(calls).toEqual([["nano", "/tmp/x"]]);
  });
});

/**
 * The gate on the gate, in the shape `project/atomic.test.ts` uses for a rename.
 *
 * Resolving an editor is three rules that do not look like rules at a call site: the order of the two
 * variables, the platform default, and the refusal for an editor that returns before the adopter has
 * finished typing. A second command that spawns an editor — `pithy config edit`, a `--edit` flag on
 * something else — reproduces all three or, far more likely, reproduces two and silently validates an
 * unedited file for everyone on VS Code.
 *
 * So the question asked here is the decidable one: **which modules read `$VISUAL` or `$EDITOR` at
 * all.** That is a fact about a module rather than a guess at its intent, and the answer across the
 * repository is one file. A second one is not banned; it has to be written down here, which is the
 * review this has never had.
 *
 * It is a scan over source text, with the same limit `atomic.test.ts` records: it reads the shapes an
 * environment variable is read through, so a name assembled at runtime would pass. There is no AST to
 * walk (TypeScript 7 ships no parser API), and the rule belongs in Biome's `noRestrictedGlobals` no
 * more than the rename one does.
 *
 * The walk itself is `ci/sourceFiles.ts`. This traversal was hardened when it was written and
 * `atomic.test.ts`'s was not, which is the whole argument for there being one of them (#185).
 */
describe("the gate on the gate", () => {
  /** `packages/cli/src/platform` → the repository. Asserted below, so a moved file fails loudly. */
  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

  /** Every module in the repository that may resolve an editor, and why. Adding a line is the review. */
  const ALLOWED = new Map<string, string>([
    ["packages/cli/src/platform/editor.ts", "This module. It is the one that is allowed to."],
  ]);

  /**
   * Which editor variable `source` names in code, or null.
   *
   * **Names, not access shapes.** The first version of this looked for `env.EDITOR` and `env["EDITOR"]`
   * and found nothing at all — including in the module below, which reads them through
   * `for (const source of ["VISUAL", "EDITOR"])`. A gate that cannot see its own allowed reader cannot
   * see an evader writing the same loop, and it had been green for exactly that reason. So the question
   * is the coarser one that is actually decidable by text: does this module mention either variable.
   *
   * Comments are stripped first, because this file's own reasoning names both variables a dozen times
   * and a rule that fires on prose is a rule people delete. `//` is only taken as a comment after
   * whitespace or a line start, so the `//` inside a URL is not one.
   */
  function editorReach(text: string): string | null {
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
    const found = new Set<string>();
    for (const [name] of code.matchAll(/\b(?:VISUAL|EDITOR)\b/g)) found.add(name);
    return found.size === 0 ? null : [...found].sort().join(", ");
  }

  test("scans the repository, not one directory of it", async () => {
    expect(await stat(join(REPO_ROOT, "packages"))).toBeDefined();
    expect(sourcePaths(REPO_ROOT).length).toBeGreaterThan(500);
    // The CI scripts are in scope: a `.github` script that resolved an editor would hang a job forever.
    expect(sourcePaths(REPO_ROOT).some((path) => path.includes(`${sep}.github${sep}`))).toBe(true);
  });

  test("only the modules written down here can resolve an editor", () => {
    const reached = new Map<string, string>();
    for (const source of sourceFiles(REPO_ROOT)) {
      const why = editorReach(source.text);
      if (why !== null) reached.set(relative(REPO_ROOT, source.path).split(sep).join("/"), why);
    }

    expect([...reached.keys()].sort(), "write down why, or resolve the editor through resolveEditor").toEqual(
      [...ALLOWED.keys()].sort(),
    );
  });
});

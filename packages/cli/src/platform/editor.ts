// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { NotFoundError, ValidationError } from "@pithy-sh/core/src/error/pithyError";

/**
 * The one place Pithy decides what "open this in your editor" means (#157).
 *
 * Three rules live here, and none of them looks like a rule at a call site — which is exactly why they
 * belong at the thing being called rather than beside each caller:
 *
 * **The order is `$VISUAL`, then `$EDITOR`, then a platform default.** Both variables, in that order,
 * because that is the convention every other tool an adopter uses already follows: `$EDITOR` is the
 * line-editor fallback and `$VISUAL` is the full-screen one, so a developer whose `$EDITOR` is `ed` and
 * whose `$VISUAL` is `nvim` means the second. The platform default is `notepad` on Windows and `nano`
 * (else `vi`) elsewhere. Windows is half the reason this module exists: #131 was the same area, and the
 * branch nobody has a host for is the branch nobody writes.
 *
 * **An editor that returns before the adopter has finished typing is refused, by name, with the flag to
 * add.** `EDITOR=code` exits the moment the window opens. A caller that spawns it and waits gets
 * control back in about forty milliseconds, validates a file nobody has touched yet, reports success,
 * and — for a command that writes what came back — writes the unedited file over the edited one while
 * the adopter is still typing into the window. There is no way to detect this after the fact: a
 * fast-exiting editor and a fast adopter are indistinguishable. So it is caught before the spawn.
 *
 * The list below is an enumeration, and enumerations are the weaker kind of gate — but it is an
 * enumeration of *fixes*, not of prohibitions. Each entry exists to name the flag, which is the only
 * thing the adopter actually needs; an editor absent from it is not asserted to be safe, it is simply
 * one Pithy has nothing helpful to say about. The invariant the gate states is in its name:
 * {@link requireEditor} returns an editor that **blocks**.
 *
 * **A refusal, never a hang.** With no terminal there is no adopter to close the window, so a spawned
 * editor in CI waits forever and takes the job's timeout with it. The refusal names the file's absolute
 * path, in `message`: `detail` is stripped by the HTTP codec and never rendered to a terminal, and the
 * path is the whole of what the operator can act on.
 *
 * A second command that opens an editor routes through here. `platform/editor.test.ts` has the gate
 * that keeps that true — `$VISUAL` and `$EDITOR` are read in this file and nowhere else in the tree.
 */

/** Which environment variable named the editor, or that neither did. Named in every refusal. */
export type EditorSource = "VISUAL" | "EDITOR" | "default";

/** A resolved editor: what to spawn, what to pass it, and where it came from. */
export interface ResolvedEditor {
  /** The executable, with no arguments and no quotes — as spawned. */
  readonly command: string;
  /** The arguments that came with it, in order. The file is appended after these. */
  readonly args: readonly string[];
  /** Which of the two variables named it, or `default` when neither did. */
  readonly source: EditorSource;
}

/** Injectable seams, so every branch is testable from any host. */
export interface EditorEnvironment {
  /** Environment map, defaulting to `process.env` — read for `VISUAL` and `EDITOR`. */
  env?: NodeJS.ProcessEnv;
  /** The platform, defaulting to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Whether a command is on `PATH`, defaulting to a `PATH` walk. Only the POSIX default consults it. */
  hasCommand?: (command: string) => boolean;
  /** Whether a human is at the terminal, defaulting to stdin **and** stdout both being TTYs. */
  interactive?: boolean;
}

/**
 * Editors that open a window and return immediately, mapped to the flags that make them wait.
 *
 * The **first** flag is the one the refusal recommends; the rest are accepted spellings of the same
 * thing. Keys are matched against the command's base name, lowercased and with a Windows extension
 * removed, so `/usr/local/bin/code`, `Code.EXE` and `code` are one editor.
 */
const WAIT_FLAGS: Record<string, readonly string[]> = {
  atom: ["--wait", "-w"],
  code: ["--wait", "-w"],
  "code-insiders": ["--wait", "-w"],
  codium: ["--wait", "-w"],
  cursor: ["--wait", "-w"],
  fleet: ["--wait", "-w"],
  goland: ["--wait", "-w"],
  gvim: ["-f", "--nofork"],
  idea: ["--wait", "-w"],
  mate: ["-w", "--wait"],
  mvim: ["-f", "--nofork"],
  notepad__: ["-multiInst", "-nosession"],
  open: ["-W", "--wait-apps"],
  phpstorm: ["--wait", "-w"],
  pycharm: ["--wait", "-w"],
  rider: ["--wait", "-w"],
  rubymine: ["--wait", "-w"],
  subl: ["--wait", "-w"],
  sublime_text: ["--wait", "-w"],
  vscodium: ["--wait", "-w"],
  webstorm: ["--wait", "-w"],
  windsurf: ["--wait", "-w"],
  zed: ["--wait", "-w"],
};

/**
 * Notepad++'s executable is `notepad++`, and `+` is not a key anyone will read correctly beside the
 * rest. It is normalized to the key above rather than spelled inline twice.
 */
const NOTEPAD_PLUS_PLUS = "notepad++";

/** Windows extensions a command may carry. Stripped before the lookup: `code.cmd` is `code`. */
const WINDOWS_EXTENSIONS = [".exe", ".cmd", ".bat", ".com"];

/**
 * Resolve the editor, refusing one that does not wait.
 *
 * The refusal is here rather than in the caller for the reason the whole module exists: an editor that
 * returns immediately is not a resolution failure the caller can recover from, and a caller that gets a
 * `ResolvedEditor` back must be able to trust that waiting on it means something.
 */
export function resolveEditor(options: EditorEnvironment = {}): ResolvedEditor {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  for (const source of ["VISUAL", "EDITOR"] as const) {
    // A variable set to nothing is a variable that names no editor. `export EDITOR=` is an ordinary
    // line in a shell profile, and spawning the empty string is an ENOENT with nothing in it to read.
    const value = env[source]?.trim() ?? "";
    if (value.length === 0) continue;
    const [command = "", ...args] = splitCommand(value);
    return requireWaiting({ command, args, source });
  }
  return { command: defaultEditor(platform, options.hasCommand ?? onPath), args: [], source: "default" };
}

/**
 * Resolve the editor for `file`, refusing first when there is no terminal to open it in.
 *
 * **Order matters, and it is the non-obvious way round.** A CI job with `EDITOR=code` set has two
 * things wrong with it, and only one of them is the thing in its way: told to add `--wait`, it adds
 * `--wait`, and the next run hangs on a window nothing will ever close. The missing terminal is
 * answered first for the same reason every diagnostic names the cause and not the symptom.
 *
 * `file` is named in that refusal, absolute, so the answer to "then how do I edit it" is in the error
 * rather than in a second command.
 */
export function requireEditor(file: string, options: EditorEnvironment = {}): ResolvedEditor {
  const interactive = options.interactive ?? (Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY));
  if (!interactive) {
    throw new ValidationError({
      message: `No terminal here, so there is no editor to open ${file} in.`,
      action: "Run this at a terminal, or edit that file directly.",
      detail: `editor requested for '${file}' with no TTY on stdin and stdout`,
    });
  }
  return resolveEditor(options);
}

/** A child process, as far as this module is concerned: it closes, or it fails to start. */
export interface EditorProcess {
  on(event: "close", listener: (code: number | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
}

/** How the editor is spawned. A seam, so the Windows branch is testable from a POSIX host. */
export type SpawnEditor = (
  command: string,
  args: readonly string[],
  options: { stdio: "inherit"; shell: boolean },
) => EditorProcess;

/** What {@link runEditor} needs beyond the editor itself. */
export interface RunEditorOptions {
  /** The platform, defaulting to `process.platform`. Decides whether a shell is involved. */
  platform?: NodeJS.Platform;
  /** How to spawn, defaulting to `node:child_process`'s `spawn`. */
  spawn?: SpawnEditor;
}

/**
 * Run a resolved editor on `file` and wait for it to close. Resolves with the exit status.
 *
 * `stdio: "inherit"`, always: a terminal editor **is** the terminal for as long as it runs, and a piped
 * stdin is a `vi` that cannot be typed into. There is nothing to capture — the output is the adopter's
 * screen — and capturing it would be capturing a file full of secrets as it is drawn.
 *
 * **A signal is not a clean exit.** `close` carries a null code when the editor was killed, and reading
 * that as zero would take a `kill -9` mid-edit for a finished one and write whatever the half-saved
 * file happened to hold.
 *
 * **Windows goes through a shell, and that is not laziness.** Every GUI editor there is a `.cmd` shim —
 * `code.cmd`, `subl.cmd` — and Node refuses to spawn one directly (it has since the argument-injection
 * fix). With `shell: true` the whole command line becomes one string that `cmd.exe /d /s /c` re-splits,
 * so anything with a space in it has to carry its own quotes: the file lives under
 * `%APPDATA%\pithy\<project>\`, and a Windows home directory with a space in it is the common case, not
 * the exotic one. `/s` strips exactly the outermost pair, so the inner quotes survive to cmd's own
 * splitting. A `"` cannot appear in a Windows path at all, so there is nothing left to escape.
 */
export async function runEditor(editor: ResolvedEditor, file: string, options: RunEditorOptions = {}): Promise<number> {
  const platform = options.platform ?? process.platform;
  const spawnEditor = options.spawn ?? defaultSpawn;
  const windows = platform === "win32";
  const command = windows ? quoteForCmd(editor.command) : editor.command;
  const args = windows ? [...editor.args, quoteForCmd(file)] : [...editor.args, file];

  return new Promise<number>((resolve, reject) => {
    const child = spawnEditor(command, args, { stdio: "inherit", shell: windows });
    child.on("error", (cause: Error) => {
      reject(
        new NotFoundError(
          {
            message: `Could not run your editor, ${editor.command}.`,
            action:
              editor.source === "default"
                ? "Set EDITOR to an editor that is installed."
                : `Check that ${editor.source} names something on your PATH.`,
            detail: `spawning editor '${editor.command}' from ${editor.source} failed`,
          },
          { cause },
        ),
      );
    });
    // A signal leaves `code` null. Anything but a clean zero is the caller's to treat as an abandon.
    child.on("close", (code: number | null) => resolve(code ?? 1));
  });
}

/**
 * Resolve an editor and run it on `file` — the whole thing, for a caller with nothing else to decide.
 *
 * A caller that has to run the editor **more than once** on the same file (an edit that has to be
 * re-opened) resolves once with {@link requireEditor} and then calls {@link runEditor}, so a changed
 * `$EDITOR` mid-session cannot swap editors between rounds.
 */
export async function openInEditor(file: string, options: EditorEnvironment & RunEditorOptions = {}): Promise<number> {
  // `async`, so a refusal is a rejection rather than a synchronous throw. A caller awaiting this has
  // one failure channel; giving it two is how a refusal escapes an `await …catch` and kills the process.
  return runEditor(requireEditor(file, options), file, options);
}

/** The platform default: `notepad` on Windows, `nano` where it is installed, `vi` everywhere else. */
function defaultEditor(platform: NodeJS.Platform, hasCommand: (command: string) => boolean): string {
  // Windows never probes for a POSIX editor: a Git-for-Windows shell can well have `nano` on its PATH,
  // and answering with it for a `cmd.exe` user is an editor they have no way to leave.
  if (platform === "win32") return "notepad";
  // `nano` first because it says how to quit on screen; `vi` because POSIX requires it to be there.
  return hasCommand("nano") ? "nano" : "vi";
}

/** Whether `command` is an executable on `PATH`. The default {@link EditorEnvironment.hasCommand}. */
function onPath(command: string): boolean {
  const path = process.env.PATH ?? "";
  return path
    .split(delimiter)
    .filter(Boolean)
    .some((directory) => existsSync(join(directory, command)));
}

/**
 * Split an editor variable into a command and its arguments, honouring quotes.
 *
 * `EDITOR` is a command line, not a filename: `code --wait` is the value the refusal below asks people
 * to set, and `"/Applications/Sublime Text.app/…/subl" --wait` is what a macOS adopter has. Splitting on
 * whitespace alone would make the second one a command called `"/Applications/Sublime` — an ENOENT that
 * says nothing about what is wrong.
 *
 * Deliberately not a shell parser. No expansion, no substitution, no operators: the value is split into
 * words, and quotes group a word. Anything more would be running the adopter's variable as a script.
 */
function splitCommand(value: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: '"' | "'" | null = null;
  let started = false;

  for (const character of value) {
    if (quote !== null) {
      if (character === quote) quote = null;
      else word += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) words.push(word);
      word = "";
      started = false;
      continue;
    }
    word += character;
    started = true;
  }
  if (started) words.push(word);
  return words;
}

/** The lookup key for a command: its base name, lowercased, without a Windows extension. */
function editorKey(command: string): string {
  const base = command.split(/[/\\]/).pop() ?? command;
  const lowered = base.toLowerCase();
  const stripped = WINDOWS_EXTENSIONS.reduce(
    (name, extension) => (name.endsWith(extension) ? name.slice(0, -extension.length) : name),
    lowered,
  );
  return stripped === NOTEPAD_PLUS_PLUS ? "notepad__" : stripped;
}

/** Refuse an editor known to return before the edit is finished, naming the flag that fixes it. */
function requireWaiting(editor: ResolvedEditor): ResolvedEditor {
  const flags = WAIT_FLAGS[editorKey(editor.command)];
  if (flags === undefined || editor.args.some((argument) => flags.includes(argument))) return editor;
  const flag = flags[0] as string;
  return raiseNoWait(editor, flag);
}

/** The refusal itself, kept apart so the wording is in one place and reads as one sentence. */
function raiseNoWait(editor: ResolvedEditor, flag: string): never {
  const base = editor.command.split(/[/\\]/).pop() ?? editor.command;
  throw new ValidationError({
    message: `${editor.source} is '${editor.command}', which opens a window and returns before you are done.`,
    action: `Set ${editor.source}="${base} ${flag}" and run this again.`,
    detail: `editor '${editor.command}' from ${editor.source} carries no wait flag (${flag})`,
  });
}

/** Wrap a command-line word for `cmd.exe` when it needs it. Windows paths cannot contain a quote. */
function quoteForCmd(word: string): string {
  return /\s/.test(word) ? `"${word}"` : word;
}

/** The real spawn, kept behind the seam so a test never starts a process. */
const defaultSpawn: SpawnEditor = (command, args, options) =>
  spawn(command, [...args], { stdio: options.stdio, shell: options.shell });

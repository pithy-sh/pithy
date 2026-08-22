// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { join } from "node:path";
import { ConflictError, InternalError, NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import { parse } from "comment-json";
import { writeJsonc } from "./jsonc";
import { readOptionalFile } from "./readOptionalFile";

/** The slice of `wrangler.jsonc` the per-environment var helpers read and write. */
export interface WranglerEnvVars {
  env?: Record<string, { vars?: Record<string, string> } | undefined>;
}

/**
 * The parsed `wrangler.jsonc`, comments preserved (comment-json), or `null` when there is **no file**.
 *
 * Nineteen modules read a Worker's config through this wrapper, and until #204 it read the bytes with a
 * bare `readFile`. That put every one of those reads outside the ENOENT gate: the gate recognises the leaf
 * calls that hand back a file's contents, so a read behind a wrapper is one it cannot see, and
 * `envInventory.ts` was left spelling out the errno branch for itself — correct, and invisible. The
 * decision lives in {@link readOptionalFile} now, which is what puts this wrapper inside the rule.
 *
 * Absent is `ENOENT` and nothing else. A `wrangler.jsonc` that is there and will not open is a refusal
 * naming it, never a Worker quietly reported as having no configuration.
 */
export async function readOptionalWranglerConfig(projectDir: string): Promise<unknown> {
  const path = join(projectDir, "wrangler.jsonc");
  const raw = await readOptionalFile(path, {
    unreadable: ({ code, cause }) =>
      new ConflictError(
        {
          message: `Can't read ${path}.`,
          action: "Fix the file's permissions, or move it aside, and run the command again.",
          detail: `${code ?? "unknown error"} while reading ${path}`,
        },
        { cause },
      ),
  });
  return raw === null ? null : parse(raw);
}

/**
 * The same read, for the callers that have already established the Worker has a config — most of them.
 * A directory with no `wrangler.jsonc` is a `PithyError` naming the file rather than node's own `ENOENT`
 * escaping into a command's output. Caller casts the shape.
 */
export async function readWranglerConfig(projectDir: string): Promise<unknown> {
  const config = await readOptionalWranglerConfig(projectDir);
  if (config === null) {
    throw new NotFoundError({
      message: `No wrangler.jsonc at ${join(projectDir, "wrangler.jsonc")}.`,
      action: "Every worker lives in apps/<name> with its own wrangler.jsonc. Run pithy worker list to see them.",
    });
  }
  return config;
}

/**
 * The module a Worker's `main` names, absolute — the entry every `class_name` in that config resolves
 * against, and the file `pithy add` writes a Durable Object's export into (#428). `null` when the config
 * names none.
 *
 * Read from the config rather than assumed to be `src/index.ts`: `main` is wrangler's own answer to
 * "which module is this Worker", the adopter may move it, and a Worker carrying a front end has one
 * written by the Vite plugin. Guessing would mean writing an export into a file nothing bundles.
 *
 * A missing `main` is answered as a value rather than a throw, because the two callers mean different
 * things by it: `add` is about to wire a class into a Worker that cannot say which module it is, and
 * refuses by name; `remove` is unwiring one and has nothing to take out, so it moves on rather than
 * stranding a capability half-removed.
 */
export async function workerEntryPath(workerDir: string): Promise<string | null> {
  const config = (await readWranglerConfig(workerDir)) as { main?: unknown };
  if (typeof config.main !== "string" || config.main === "") return null;
  return join(workerDir, config.main);
}

/**
 * Write `wrangler.jsonc` back comment-preserving, printed the way the Biome `pithy init` scaffolds would
 * print it and shaped like the bytes already there — see {@link writeJsonc}. This wrote `stringify`'s
 * fully expanded output until #249, so every command that edits a Worker's config left a file the
 * adopter's own commit hook rejected, and buried a two-line change in a whole-file reformat.
 */
export async function writeWranglerConfig(projectDir: string, config: unknown): Promise<void> {
  await writeJsonc(join(projectDir, "wrangler.jsonc"), config);
}

export interface WranglerOptions {
  /**
   * Stream wrangler's output straight to the terminal. Off by default: the output is captured and
   * surfaced **only on failure** — quiet on success, the error when there is one. That's pithy.
   */
  passthrough?: boolean;
  /** Working directory for the command. */
  cwd?: string;
  /**
   * Override the executable to spawn (with `args` passed straight through). Tests set this to a
   * stand-in. When omitted, wrangler runs via `bun x wrangler` so the workspace devDependency
   * resolves — `pithy` does not assume a globally-installed wrangler.
   */
  bin?: string;
  /**
   * Extra env vars merged onto the child process. Provisioning passes `CLOUDFLARE_API_TOKEN`
   * (from the `.dev.vars` token) so wrangler authenticates without a separate `wrangler login` —
   * `.dev.vars` stays the single source of credentials.
   */
  env?: Record<string, string>;
}

/**
 * Run a wrangler command. We don't reimplement wrangler — `pithy` shells out to it (deploy, D1, …)
 * and owns only the output discipline: by default it stays quiet, capturing stdout/stderr and
 * raising them as the error `detail` if wrangler fails; with `passthrough`, wrangler's output streams
 * through directly. A non-zero exit (or a missing binary) becomes a `PithyError`.
 *
 * On success it resolves with the captured `stdout`/`stderr` — empty strings in `passthrough` mode,
 * where nothing is captured — so callers that need wrangler's output (e.g. `deploy` scraping the
 * version id and url) can read it without giving up the quiet-on-success default.
 *
 * Wrangler is a workspace devDependency, not a global, so it runs through `bun x wrangler` — bun
 * resolves the local install from the `cwd`. Tests override `bin` to spawn a stand-in directly.
 */
export async function runWrangler(
  args: string[],
  options: WranglerOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const command = options.bin ?? "bun";
  const commandArgs = options.bin ? args : ["x", "wrangler", ...args];
  const label = options.bin ?? "wrangler";
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      stdio: options.passthrough ? "inherit" : ["ignore", "pipe", "pipe"],
      env: options.env ? { ...process.env, ...options.env } : process.env,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (cause) => {
      reject(
        new InternalError({
          message: `Could not run ${label}.`,
          action: `Is ${label} installed and on PATH?`,
          detail: cause.message,
        }),
      );
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      // Surface the captured output (the errors) even in quiet mode; in passthrough it already streamed.
      const captured = options.passthrough ? "" : `\n${(stderr || stdout).trim()}`;
      reject(new InternalError({ message: `${label} ${args[0] ?? ""} failed.`, detail: `exit ${code}${captured}` }));
    });
  });
}

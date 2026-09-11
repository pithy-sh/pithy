// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { join } from "node:path";
import { ConflictError, InternalError, NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import { parse } from "comment-json";
import { cloudflareChildEnv, credentialedChildEnv } from "../cloudflare/childEnv";
import type { CloudflareAccountSelection, CloudflareCredentials } from "../cloudflare/config";
import { writeJsonc } from "./jsonc";
import { detectPackageManager, execArgs } from "./packageManager";
import { readOptionalFile } from "./readOptionalFile";

/** The slice of `wrangler.jsonc` the per-environment var helpers read and write. */
export interface WranglerEnvVars {
  env?: Record<string, { vars?: Record<string, string> } | undefined>;
}

/**
 * The parsed `wrangler.jsonc`, comments preserved (comment-json), or `null` when there is **no file**.
 *
 * Nineteen modules read a Worker's config through this wrapper, and until #204 it read the bytes with a
 * bare `readFile`. That put every one of those reads outside the ENOENT gate: the gate recognizes the leaf
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

/**
 * Who a wrangler spawn authenticates as: the project's selection, the pair it resolved to, or nobody.
 *
 * The pair is discriminated by `apiToken`, which a {@link CloudflareAccountSelection} never carries.
 */
export type WranglerAccount = CloudflareAccountSelection | CloudflareCredentials | null;

export interface WranglerOptions {
  /**
   * Which Cloudflare account this wrangler authenticates as — the project's selection, or the pair that
   * selection already resolved to, or `null` for a project that names none.
   *
   * **Required, and there is no default.** wrangler authenticates from its own process environment, so a
   * spawn that says nothing about the account authenticates as whatever the operator's shell last
   * exported — which does not fail, it reaches another company's tenant and exits 0. That is the sentence
   * `defaultRunDeploy` has carried since #206, and the defect `pithy dev` shipped as #555. Omitting it is
   * a type error, which is the only form of "you must think about this" that survives the next person in
   * a hurry; `null` is the deliberate answer, and it is visible in a diff.
   *
   * Either way the child's environment is built by `cloudflare/childEnv`, never here — see
   * {@link CloudflareChildEnvOptions} for why there are two inputs and not one.
   */
  account: WranglerAccount;
  /**
   * Stream wrangler's output straight to the terminal. Off by default: the output is captured and
   * surfaced **only on failure** — quiet on success, the error when there is one. That's pithy.
   */
  passthrough?: boolean;
  /** Working directory for the command. */
  cwd?: string;
  /**
   * Override the executable to spawn (with `args` passed straight through). Tests set this to a
   * stand-in. When omitted, wrangler runs through the **project's own** package manager, so the
   * workspace devDependency resolves — `pithy` does not assume a globally-installed wrangler.
   */
  bin?: string;
  /**
   * Extra env vars merged **on top of** the credentialed environment {@link cloudflareChildEnv} builds.
   *
   * For everything that is not a Cloudflare credential. The pair is `account`'s job now, and it was
   * this option's for three call sites, two of which hand-rolled the same four lines and one of which
   * (`pithy dev`, which does not spawn through here at all) forgot them entirely — #555. A caller that
   * writes `CLOUDFLARE_API_TOKEN` here is opting out of the seam and out of #206's mismatch refusal
   * with it; `ci/cloudflareChildEnv.test.ts` fails the build for it.
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
 * Wrangler is a workspace devDependency, not a global, so it runs through the project's own package
 * manager, which resolves the local install from the `cwd`: `bun x`, `pnpm exec`, `yarn`, or `npx`.
 * Tests override `bin` to spawn a stand-in directly.
 *
 * **It was `bun x wrangler`, unconditionally — #474.** That made every command which touches
 * Cloudflare require Bun on an adopter's PATH, in a CLI whose whole premise is that adoption is not
 * gated behind a Bun install, and it failed with `Could not run wrangler. Is wrangler installed and on
 * PATH?` — an action naming the wrong missing program. `detectPackageManager` reads the lockfile beside
 * the project and `execArgs` knows each manager's spelling for "run a workspace-local binary"; both
 * already existed here for `pithy add`, and this was the one spawn that went around them.
 *
 * Detection keys on `cwd` rather than on the CLI's own location, because the question is which manager
 * installed *the adopter's* wrangler. `cwd` defaults to the process's, which is the project a command
 * is being run against.
 */
/** The child's environment, from whichever of the two things the caller holds. See {@link WranglerAccount}. */
function wranglerChildEnv(account: WranglerAccount): Record<string, string> {
  if (account !== null && "apiToken" in account) return credentialedChildEnv(account);
  return cloudflareChildEnv({ account });
}

export async function runWrangler(
  args: string[],
  options: WranglerOptions,
): Promise<{ stdout: string; stderr: string }> {
  const runner = options.bin
    ? { command: options.bin, args }
    : execArgs(await detectPackageManager(options.cwd ?? process.cwd()), "wrangler", args);
  const command = runner.command;
  const commandArgs = runner.args;
  const label = options.bin ?? "wrangler";
  // Built before the spawn, and deliberately outside the promise: a pin the credentials contradict
  // rejects the call rather than the child, so nothing is running when the refusal is raised.
  const childEnv = { ...wranglerChildEnv(options.account), ...(options.env ?? {}) };
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      stdio: options.passthrough ? "inherit" : ["ignore", "pipe", "pipe"],
      env: childEnv,
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
      // **The action names the program that is actually missing, which is not always wrangler.** A
      // spawn error here is `ENOENT` on `command` — the package manager's runner — and wrangler may be
      // installed perfectly well. It said "Is wrangler installed and on PATH?" while `bun` was what was
      // absent (#474), which sends an adopter to reinstall the one thing they already had.
      reject(
        new InternalError({
          message: `Could not run ${label}.`,
          action:
            command === label
              ? `Is ${label} installed and on PATH?`
              : `\`${command}\` is not on PATH. It is how your project runs a local binary — install it, or pass a wrangler on PATH.`,
          detail: `${cause.message} (spawning ${command})`,
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

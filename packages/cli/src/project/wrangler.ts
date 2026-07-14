import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { parse, stringify } from "comment-json";
import { writeFileAtomic } from "./atomic";

/** The slice of `wrangler.jsonc` the per-environment var helpers read and write. */
export interface WranglerEnvVars {
  env?: Record<string, { vars?: Record<string, string> } | undefined>;
}

/** Read and parse the project's `wrangler.jsonc`, comments preserved (comment-json). Caller casts the shape. */
export async function readWranglerConfig(projectDir: string): Promise<unknown> {
  return parse(await readFile(join(projectDir, "wrangler.jsonc"), "utf8"));
}

/** Write `wrangler.jsonc` back comment-preserving, with the repo's 2-space + trailing-newline formatting. */
export async function writeWranglerConfig(projectDir: string, config: unknown): Promise<void> {
  await writeFileAtomic(join(projectDir, "wrangler.jsonc"), `${stringify(config, null, 2)}\n`);
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

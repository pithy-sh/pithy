// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fromZodError, InternalError } from "@pithy-sh/core/src/error/pithyError";
import { parse } from "comment-json";
import { z } from "zod";

/**
 * `pithy.worker.jsonc` — the per-worker manifest that sits beside `wrangler.jsonc` in every `apps/<name>/`.
 * It is **ours**; `wrangler.jsonc` stays wrangler's. Discovery keys on this file, not `wrangler.jsonc`, so a
 * non-Worker process (a Vite frontend with no `wrangler.jsonc` at all) can still join the dev set — it just
 * carries a `dev.command` instead. The file is JSONC (comment-documented), matching the JSONC-everywhere rule.
 */

/** wrangler's own "ready" banner — the fallback `readySignal` when a worker declares none. */
export const DEFAULT_READY_SIGNAL = "Ready on https?://";

/**
 * The placeholder `pithy dev` replaces with the worker's pinned port in every element of a `dev.command`.
 * A dev server needs the port on its argv, and `pithy dev` spawns with **no shell** — `$WEB_PORT` in an
 * argv array is a literal, never an expansion. So the manifest writes the token and dev substitutes it.
 */
export const DEV_PORT_TOKEN = "{port}";

/** How `pithy dev` runs one worker locally: whether it autostarts, what marks it ready, its port, its command. */
export const WorkerDev = z
  .object({
    /**
     * **Removed (#548), and refused rather than ignored.**
     *
     * Whether a worker starts locally is not a fact about the project. The manifest is committed and the
     * same for everyone; which workers one developer is exercising this week is theirs, and putting it
     * here made it a diff somebody had to review. So every worker autostarts, and the only override is
     * per branch and per machine in `dev-ports.json` — `pithy dev --app <name> --disable-autostart`.
     *
     * **Kept in the schema purely to refuse it.** A `z.object` strips unknown keys, so deleting the field
     * outright would silently swallow a key somebody wrote — and for `false` that means starting a worker
     * its owner had turned off, which is the loudest version of the bug #536 fixed, where the *presence*
     * of a file decided the answer. A key that no longer means anything has to say so, once, in the one
     * place it is read: `parseWorkerManifest` renders this through `fromZodError` with the command that
     * replaces it. Nothing reads the value — {@link WorkerDev}'s output has no `autostart` at all.
     */
    autostart: z
      .never({
        error:
          "dev.autostart was removed — every worker autostarts. Delete the key; to keep one out of your local dev set run `pithy dev --app <name> --disable-autostart`, which is per branch and per machine and is not committed.",
      })
      .optional(),
    readySignal: z
      .string()
      .default(DEFAULT_READY_SIGNAL)
      .describe("Regex source matched against this process's output to mark it ready. Defaults to wrangler's banner."),
    preferredPort: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Preferred local port — a hint only. The feature's reserved block in .dev.config.json is authoritative.",
      ),
    command: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe(
        `Command that starts this process instead of \`wrangler dev\`. Set it for a non-Worker process, e.g. a Vite frontend with no wrangler.jsonc. The token ${DEV_PORT_TOKEN} in any element is replaced with this worker's pinned port.`,
      ),
  })
  .describe("Local dev-orchestration settings for one worker (the `dev` block of pithy.worker.jsonc).");
export type WorkerDev = z.output<typeof WorkerDev>;

/**
 * How a worker's front end is built. Present only when `pithy ui add` scaffolded one: the SPA is served
 * by the Worker it lives in, so its assets must exist before `wrangler deploy` uploads them — `pithy deploy`
 * runs `build` through the project's package manager, in the worker's own directory, first.
 */
export const WorkerUi = z
  .object({
    stub: z
      .string()
      .min(1)
      .describe("The framework stub this worker's front end was scaffolded from, e.g. react. Upgrades read it."),
    build: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        'Argv that builds the front end, run through the project\'s package manager from this worker\'s directory before wrangler deploy, e.g. ["vite", "build"].',
      ),
  })
  .describe("The front end this worker serves (the `ui` block of pithy.worker.jsonc): its stub and its build.");
export type WorkerUi = z.output<typeof WorkerUi>;

/** The `pithy.worker.jsonc` document: the dev-set descriptor beside a worker's `wrangler.jsonc`. */
export const WorkerManifest = z
  .object({
    // A parse, not a literal, and not a bare `{}`: an outer `.default({})` returns the literal and bypasses
    // WorkerDev's own field defaults, so a manifest omitting `dev` would get an empty block. A literal spelled
    // out here would work, but it would be a second place the same booleans are decided — which is exactly how
    // an absent `dev` block and a `dev` block omitting `autostart` came to mean opposite things. The function
    // runs per parse, so the field defaults above are the one answer.
    dev: WorkerDev.default(() => WorkerDev.parse({})).describe("Local dev-orchestration block for this worker."),
    ui: WorkerUi.optional().describe(
      "The front end this worker serves. Absent for an API-only worker; written by pithy ui add.",
    ),
  })
  .describe("Pithy's per-worker manifest (pithy.worker.jsonc): how a worker joins the local dev set.");
export type WorkerManifest = z.output<typeof WorkerManifest>;

/** The manifest filename discovery and scaffolding both key on. */
export const WORKER_MANIFEST_FILE = "pithy.worker.jsonc";

/**
 * Read and validate `<dir>/pithy.worker.jsonc`, or `null` when the file is absent. A present-but-malformed
 * manifest throws (never silently defaulted) — a typo in `readySignal` or `autostart` must surface, not be
 * swallowed into a worker that quietly never starts.
 */
export async function parseWorkerManifest(dir: string): Promise<WorkerManifest | null> {
  let raw: string;
  try {
    raw = await readFile(join(dir, WORKER_MANIFEST_FILE), "utf8");
  } catch {
    return null;
  }

  let value: unknown;
  try {
    value = parse(raw);
  } catch (cause) {
    throw new InternalError({
      message: `${WORKER_MANIFEST_FILE} in ${dir} is not valid JSONC.`,
      action: "Fix the syntax, or delete it to accept the defaults.",
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }

  const result = WorkerManifest.safeParse(value);
  if (!result.success) {
    throw fromZodError(result.error, {
      message: `${WORKER_MANIFEST_FILE} in ${dir} is invalid.`,
      action: "Correct the dev block, or delete the file to accept the defaults.",
    });
  }
  return result.data;
}

/** The dev block for a worker with no manifest: the schema's own defaults, decided in one place. */
export function defaultWorkerDev(): WorkerDev {
  return WorkerDev.parse({});
}

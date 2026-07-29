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

/** How `pithy dev` runs one worker locally: whether it autostarts, what marks it ready, its port, its command. */
export const WorkerDev = z
  .object({
    autostart: z
      .boolean()
      .default(false)
      .describe(
        "Must this worker run for the local dev environment to function? pithy dev starts exactly the autostart workers.",
      ),
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
        "Command that starts this process instead of `wrangler dev`. Set it for a non-Worker process, e.g. a Vite frontend with no wrangler.jsonc.",
      ),
  })
  .describe("Local dev-orchestration settings for one worker (the `dev` block of pithy.worker.jsonc).");
export type WorkerDev = z.output<typeof WorkerDev>;

/** The `pithy.worker.jsonc` document: the dev-set descriptor beside a worker's `wrangler.jsonc`. */
export const WorkerManifest = z
  .object({
    // A resolved default (not `{}`): an outer `.default({})` returns the literal, bypassing WorkerDev's own
    // field defaults, so a manifest omitting `dev` would get an empty block instead of the wrangler defaults.
    dev: WorkerDev.default({ autostart: false, readySignal: DEFAULT_READY_SIGNAL }).describe(
      "Local dev-orchestration block for this worker.",
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

/** The dev block for a worker with no manifest — its one/legacy worker, so it autostarts. */
export function defaultWorkerDev(): WorkerDev {
  return WorkerDev.parse({ autostart: true });
}

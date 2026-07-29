import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { parse, stringify } from "comment-json";
import { writeFileAtomic } from "../project/atomic";
import { WORKER_MANIFEST_FILE, type WorkerUi } from "../project/workerManifest";

/**
 * The `ui` block of `pithy.worker.jsonc` — the framework-stub contract as persisted.
 *
 * ```jsonc
 * "ui": { "stub": "react", "build": ["vite", "build"] }
 * ```
 *
 * `pithy deploy` reads `build` and runs it through the adopter's package manager before
 * `wrangler deploy`; `pithy ui sync` reads `stub` to know which worker already has a front end. The
 * block's presence **is** the "this worker has a UI" signal, which is why `pithy ui add` refuses on
 * a worker that already carries one rather than half-overwriting a scaffold.
 *
 * Read here from the raw JSONC rather than through `parseWorkerManifest`: the Zod manifest strips
 * what it does not declare, and this reader has to see the block whether or not the schema has caught
 * up with it. Writes go back comment-preserving (comment-json), mutating in place — replacing an
 * object or array would drop the adopter's notes, which live on it as symbol-keyed properties.
 */

/** A parsed `pithy.worker.jsonc`, loose — this module writes two known blocks and preserves the rest. */
type ManifestDocument = Record<string, unknown> & {
  dev?: Record<string, unknown>;
  ui?: Record<string, unknown>;
};

/** Parse `<dir>/pithy.worker.jsonc` comment-preserving, or an empty document when the file is absent. */
export async function readManifestDocument(workerDir: string): Promise<ManifestDocument> {
  let raw: string;
  try {
    raw = await readFile(join(workerDir, WORKER_MANIFEST_FILE), "utf8");
  } catch {
    return {};
  }
  let value: unknown;
  try {
    value = parse(raw);
  } catch (cause) {
    throw new InternalError({
      message: `${WORKER_MANIFEST_FILE} in ${workerDir} is not valid JSONC.`,
      action: "Fix the syntax, then run pithy ui add again.",
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }
  return typeof value === "object" && value !== null ? (value as ManifestDocument) : {};
}

/** Write the document back, 2-space with a trailing newline — the repo's JSONC formatting. */
export async function writeManifestDocument(workerDir: string, document: ManifestDocument): Promise<void> {
  await writeFileAtomic(join(workerDir, WORKER_MANIFEST_FILE), `${stringify(document, null, 2)}\n`);
}

/** The `ui` block on a parsed document, or `null` when the worker has no front end. */
export function uiBlock(document: ManifestDocument): WorkerUi | null {
  const block = document.ui;
  if (typeof block !== "object" || block === null) return null;
  const stub = (block as { stub?: unknown }).stub;
  const build = (block as { build?: unknown }).build;
  if (typeof stub !== "string") return null;
  return {
    stub,
    build: Array.isArray(build) ? build.filter((entry): entry is string => typeof entry === "string") : [],
  };
}

/** The `ui` block for a worker directory, or `null`. The "does this worker already have a UI?" check. */
export async function readWorkerUi(workerDir: string): Promise<WorkerUi | null> {
  return uiBlock(await readManifestDocument(workerDir));
}

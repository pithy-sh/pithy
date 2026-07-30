// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../project/atomic";

/**
 * `.dev-state.json` — the running `pithy dev` session's live state, git-ignored, at the worktree root.
 *
 * Distinct from `.dev.config.json` (the feature's fixed dev config: reserved ports, per-worker origins,
 * written once at feature creation). This file is ephemeral: the supervising pid, when it started, its
 * child pids, and each worker's port + pid. A re-run reads it to stop the previous session before it
 * spawns; shutdown removes it. It is rewritten fresh every session, so a corrupt file is discarded, not
 * an error — there is nothing to recover.
 */

/** One worker's live entry in the running session — the port it holds and the pid serving it. */
export const DevWorkerState = z
  .object({
    port: z.number().int().positive().describe("The local port this worker is bound to for the session."),
    pid: z.number().int().describe("The spawned child process id serving this worker (its process-group leader)."),
  })
  .describe("A single worker's live process state within a running pithy dev session.");
export type DevWorkerState = z.output<typeof DevWorkerState>;

/** The `.dev-state.json` document: the supervising session and every worker it started. */
export const DevState = z
  .object({
    pid: z.number().int().describe("The pid of the supervising pithy dev process that owns this session."),
    startedAt: z.string().describe("When the session started, ISO-8601 — for operator diagnostics."),
    childPids: z.array(z.number().int()).describe("Every spawned child pid, so a crashed session can be reaped."),
    workers: z
      .record(z.string(), DevWorkerState)
      .describe("Each started worker's live port and pid, keyed by worker name."),
  })
  .describe("The live state of a running pithy dev session (git-ignored .dev-state.json).");
export type DevState = z.output<typeof DevState>;

/** The dev-state path for a project/worktree root: `<projectDir>/.dev-state.json`. */
export function devStatePath(projectDir: string): string {
  return join(projectDir, ".dev-state.json");
}

/**
 * Read the previous session's state, or `null` when the file is absent, corrupt, or invalid. Unlike the
 * feature dev config, a bad `.dev-state.json` never throws: it is a disposable session artifact this run
 * overwrites, so an unreadable one is simply treated as "no previous session".
 */
export async function readDevState(path: string): Promise<DevState | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const parsed = DevState.safeParse(safeJson(raw));
  return parsed.success ? parsed.data : null;
}

/** Zod-validate then write the session state atomically (pretty JSON, trailing newline). */
export async function writeDevState(path: string, state: DevState): Promise<void> {
  const validated = DevState.parse(state);
  await writeFileAtomic(path, `${JSON.stringify(validated, null, 2)}\n`);
}

/**
 * Remove the state file **only when it still points at us** — race-safe teardown. A newer orchestrator
 * (a re-run that already replaced the file) owns it now, so an older shutting-down process must not delete
 * the newer session's state. Synchronous so it runs reliably inside a shutdown/exit path.
 */
export function removeDevState(path: string, ownPid: number): void {
  try {
    const current = DevState.safeParse(safeJson(readFileSync(path, "utf8")));
    if (current.success && current.data.pid === ownPid) unlinkSync(path);
  } catch {
    // Already gone, or never ours — nothing to remove.
  }
}

/** Parse JSON, returning `undefined` on failure so the caller's Zod parse decides validity. */
function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

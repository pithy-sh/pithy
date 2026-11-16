// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { messageOf, PithyError } from "@pithy-sh/core/src/error/pithyError";

/**
 * **A first deploy can outrun Cloudflare.** wrangler uploads a new Worker, then reads it back through
 * `GET /workers/workers/<name>` for its `workers.dev` state, and that endpoint can answer 10007 for a Worker
 * created moments before. wrangler retries only a 5xx or a 429 there, so the whole `wrangler deploy` fails
 * after the upload succeeded. Running the same deploy again uploads identical code and gets through.
 */

/** How long to wait before the one retry. */
export const UNSEEN_WORKER_WAIT_MS = 5_000;

/** Wait out the propagation. The seam tests replace so nothing here sleeps. */
export type RetryWait = (ms: number) => Promise<void>;

const realWait: RetryWait = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Everything a failure says: a `PithyError`'s message and detail, where wrangler's captured stderr lands. */
function failureText(error: unknown): string {
  if (error instanceof PithyError) return `${error.payload.message}\n${error.payload.detail ?? ""}`;
  return messageOf(error);
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `error` is Cloudflare answering 10007 for `scriptName` on `/workers/workers/<name>`, and nothing else. */
export function unseenWorker(error: unknown, scriptName: string): boolean {
  const text = failureText(error);
  return /\[code: 10007\]/.test(text) && new RegExp(`/workers/workers/${escaped(scriptName)}(?![\\w-])`).test(text);
}

/**
 * Run one deploy, and once more after {@link UNSEEN_WORKER_WAIT_MS} when the first attempt met an unseen Worker.
 * A second failure of any kind, and any other first failure, is thrown as it is.
 */
export async function withUnseenWorkerRetry<T>(
  scriptName: string,
  attempt: () => Promise<T>,
  wait: RetryWait = realWait,
): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (!unseenWorker(error, scriptName)) throw error;
    await wait(UNSEEN_WORKER_WAIT_MS);
    return attempt();
  }
}

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { AsyncLocalStorage } from "node:async_hooks";
import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * **"Is this path a link?", asked the way the project would answer it (#697).**
 *
 * A dry run works in a copy of the project (`plan/shadow.ts`), and a link there that leads out of the project
 * to a directory cannot stay a link: a write through it would land in the adopter's real files. So the copy
 * holds a snapshot of the directory instead, and a snapshot is a directory. Every guard that refuses a path
 * *because it is a link* — the scaffold gate's walk, the atomic writer's owner check — would then answer the
 * copy's question rather than the project's, and the dry run would plan a success the real run refuses.
 *
 * So those guards ask here instead of calling `lstat` themselves. Outside a dry run nothing is registered
 * and this is `lstat`, unchanged. Inside one, the copy registers each snapshot's path with the `lstat` of the
 * link it stands for — the real link's own answer, its owner included — and that is what the guard reads.
 *
 * `AsyncLocalStorage` rather than a parameter, because the guards sit a dozen calls below the command that
 * opened the copy, and a parameter would be threaded through every one of them for the dry run's sake. The
 * registration is scoped to the dry run's own async work: nothing else running in the process sees it.
 */

/** The links a dry run's copy stands in for, by absolute path in the copy. */
const standIns = new AsyncLocalStorage<ReadonlyMap<string, Stats>>();

/** Run `work` with `links` answering for their paths: each a path in the copy, and the `lstat` of the link it stands for. */
export function withLinkStandIns<T>(links: ReadonlyMap<string, Stats>, work: () => Promise<T>): Promise<T> {
  return standIns.run(links, work);
}

/** The `lstat` of the link `path` stands in for, when a dry run's copy registered one there. */
export function linkStandingAt(path: string): Stats | undefined {
  return standIns.getStore()?.get(resolve(path));
}

/** `lstat`, except where a dry run's copy holds a snapshot in place of a link: there, the link's own `lstat`. */
export async function lstatAsProject(path: string): Promise<Stats> {
  return linkStandingAt(path) ?? lstat(path);
}

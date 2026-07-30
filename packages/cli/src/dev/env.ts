// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { DevConfig } from "../feature/devConfig";
import { DEV_PORT_TOKEN } from "../project/workerManifest";
import type { WorkerTarget } from "../project/workers";

/**
 * The env-var stem for a worker: uppercased, every non-alphanumeric run collapsed to `_`. `media-cli` →
 * `MEDIA_CLI`, so its siblings read `MEDIA_CLI_PORT` / `MEDIA_CLI_ORIGIN`. Deterministic across the run
 * so the name a worker publishes matches the name every sibling looks up.
 */
export function envStem(workerName: string): string {
  return workerName
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Build the environment every child inherits: the parent env plus, for **every** worker in the feature's
 * dev config, `<STEM>_PORT` and `<STEM>_ORIGIN`. That is how workers reach each other — each sibling's
 * localhost address is known ahead of time and injected, so a worker calls its peers directly instead of
 * relying on wrangler's flaky cross-`wrangler dev` service registry.
 */
export function buildWorkerEnv(config: DevConfig, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value;
  }
  for (const [name, worker] of Object.entries(config.workers)) {
    const stem = envStem(name);
    env[`${stem}_PORT`] = String(worker.port);
    env[`${stem}_ORIGIN`] = worker.origin;
  }
  return env;
}

/** Turn `["dev", "--port", "8787"]` into a spawnable `{ command, args }` via the project's package manager. */
export type WranglerLauncher = (args: string[]) => { command: string; args: string[] };

/** A resolved start command for one worker. */
export interface StartCommand {
  command: string;
  args: string[];
}

/**
 * The command that starts one worker at its pinned `port`.
 *
 * A worker with an explicit `dev.command` (e.g. a Vite frontend with no `wrangler.jsonc`) runs that verbatim
 * — the port is **not** appended; it reaches the process through `<STEM>_PORT` in the env, or through the
 * `{port}` token wherever the manifest placed it on the argv. That token is the one substitution, and it
 * exists because the orchestrator spawns with no shell: `$WEB_PORT` in an argv array is a literal, never an
 * expansion, and a dev server that takes its port as a flag (`vite dev --port {port}`) has nowhere else to
 * read it. A command with no token runs byte-identically. A plain Worker runs `wrangler dev --port <port>
 * --inspector-port 0` (inspector `0` auto-assigns, so multiple workers never collide on the inspector port),
 * resolved through the project's package manager rather than a hardcoded global wrangler.
 *
 * **`--persist-to` is what makes local sharing real.** Every Worker lives in its own `apps/<name>/` and
 * wrangler defaults its local state to the *cwd* it runs in, so each Worker would get its own `.wrangler/`
 * store — and two Workers that deliberately declare the same binding (the way Workers share a database)
 * would silently read and write two different local D1s, with the divergence showing up only as
 * inexplicably missing rows. Pointing every Worker at one project-level store makes local behave the way
 * the deployed environment does.
 */
export function startCommand(
  worker: WorkerTarget,
  port: number,
  launchWrangler: WranglerLauncher,
  persistTo: string,
): StartCommand {
  const custom = worker.dev?.command;
  if (custom && custom.length > 0) {
    // A custom command is run verbatim: it is not necessarily wrangler, so no flag is appended. The only
    // edit is `{port}` → the pinned port, in every element that carries it.
    const resolved = custom.map((part) => part.replaceAll(DEV_PORT_TOKEN, String(port)));
    return { command: resolved[0] as string, args: resolved.slice(1) };
  }
  return launchWrangler(["dev", "--port", String(port), "--inspector-port", "0", "--persist-to", persistTo]);
}

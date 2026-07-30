// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createBackend } from "@pithy-sh/core/src/createBackend";
import type { WorkerConfig } from "../project/config";

/**
 * `assets.run_worker_first` — the explicit allowlist of paths that reach the Worker instead of the
 * static assets.
 *
 * It has to be an allowlist, and it has to be derived, because the ordering is not what it looks
 * like: with `not_found_handling: "single-page-application"`, the asset router answers a request with
 * `index.html` **before** the Worker runs. A `run_worker_first` that names the wrong prefix does not
 * degrade — `GET /health` comes back as 200 text/html and `POST /auth/sign-in/magic-link` as 405,
 * with the Worker never invoked. Pithy's routes sit at capability base paths (`/auth`,
 * `/leaderboard`, `/ledger`, `/payments`, …) plus `/health`; none of them is under `/api`. So the only
 * correct list is the one the Worker's own composed route table produces.
 *
 * Two verified details shape the emitted patterns:
 * - `"/auth/*"` does **not** match bare `"/auth"`, so each segment emits both.
 * - a bare-prefix glob like `"/media*"` over-matches `/mediafoo`, so it is never emitted.
 *
 * The array form also disables the automatic `Sec-Fetch-Mode: navigate` detection, which is what we
 * want: `not_found_handling` then applies only to requests no worker-first pattern matched.
 */

/**
 * The first path segment of a Hono route pattern, or `null` when it cannot be expressed as an
 * allowlist entry. Wildcards and the root are `null` (core's own `app.use("*")` middleware lands
 * here). A `:param` in the first position is `null` too — a Worker mounted at a bare parameter root
 * claims every path, which no allowlist can say and no Pithy capability does.
 *
 * A wildcard in a LATER segment still yields its prefix: `/auth/*` is `auth`, which is how the auth
 * capability's Better Auth catch-all gets covered.
 *
 * **A route the adopter mounts at `/` is deliberately not allowlisted.** In a Worker that serves a
 * SPA, `/` is the app shell — that is what `not_found_handling` is for. An adopter wanting an API
 * response at the root of a UI-bearing Worker has a real conflict with the front end, and this
 * resolves it in the front end's favour rather than shadowing the app's own entry point. It is
 * silent, so `docs/UI.md` says so as well.
 */
export function firstSegment(path: string): string | null {
  const segment = path.replace(/^\/+/, "").split("/")[0] ?? "";
  if (segment === "" || segment.includes("*") || segment.startsWith(":")) return null;
  return segment;
}

/**
 * The `run_worker_first` patterns for a route table: `"/<segment>"` and `"/<segment>/*"` for each
 * distinct first segment, sorted so the written config is stable run to run. `/health` is always
 * present — `createBackend` serves it for every Worker, and it is the one route an adopter is most
 * likely to check first.
 */
export function workerFirstPatterns(paths: readonly string[]): string[] {
  const segments = new Set<string>(["health"]);
  for (const path of paths) {
    const segment = firstSegment(path);
    if (segment) segments.add(segment);
  }
  return [...segments].sort().flatMap((segment) => [`/${segment}`, `/${segment}/*`]);
}

/**
 * Derive the allowlist from a Worker's real composed route table. The config is code, so the only
 * honest source is the assembled app: `createBackend` mounts every capability's routes onto one Hono
 * instance, and `app.routes` carries one entry per registered handler with the pattern intact.
 */
export function deriveWorkerFirst(config: WorkerConfig): string[] {
  const app = createBackend({ capabilities: config.capabilities, ...(config.app ? { app: config.app } : {}) });
  return workerFirstPatterns(app.routes.map((route) => route.path));
}

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
 * **Why a list at all, when dropping it makes `fetch` calls work by themselves.** The asset worker's
 * `canFetch` is one line, and it decides everything here:
 *
 * ```js
 * if (!(has_static_routing || (navigateFlag && request.headers.get("Sec-Fetch-Mode") === "navigate")))
 *   configuration = { ...configuration, not_found_handling: "none" };
 * ```
 *
 * An array `run_worker_first` sets `has_static_routing`. With it, a path the list misses is answered
 * by the SPA shell whatever the method — a 200 with the wrong body, the worst failure available, and
 * the bug this file's derivation exists to prevent. *Without* it, every non-navigation falls through
 * to the Worker, which is why removing the key looks like a clean fix from a browser's `fetch` and
 * from curl.
 *
 * It is not one, because the navigation half stays: with no list, a request carrying
 * `Sec-Fetch-Mode: navigate` keeps `not_found_handling` and gets the shell. A magic-link click lands
 * on `/auth/magic-link/verify` and an OAuth provider redirects to `/auth/callback/<provider>`, both as
 * top-level navigations — so dropping the list trades every API route for the two flows that carry
 * Pithy's sign-in, and trades them just as silently. The list stays; {@link uncoveredRoutes} is how
 * its drift is made loud instead.
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
 * A Worker's real composed route table, one entry per registered handler. The config is code, so the
 * only honest source is the assembled app: `createBackend` mounts every capability's routes onto one
 * Hono instance, and `app.routes` carries the pattern intact.
 */
export function composedPaths(config: WorkerConfig): string[] {
  const app = createBackend({ capabilities: config.capabilities, ...(config.app ? { app: config.app } : {}) });
  return app.routes.map((route) => route.path);
}

/** Derive the allowlist from a Worker's real composed route table. */
export function deriveWorkerFirst(config: WorkerConfig): string[] {
  return workerFirstPatterns(composedPaths(config));
}

/**
 * The routes `patterns` does not cover — the drift `pithy ui sync --check` gates on.
 *
 * The list is derived once, at `pithy ui add`, and every route mounted afterwards is a route the SPA
 * shell answers with a 200. That includes routes the adopter writes into their **own** app capability,
 * which no `pithy add` and no `pithy remove` is present for, so nothing but a comparison can catch
 * them. It compares by first segment, because that is the unit the patterns are emitted in: a segment
 * whose pair is in the list covers every route beneath it.
 *
 * A route {@link firstSegment} cannot express is never reported. `core`'s own `app.use("*")` and a
 * route at `/` are not drift — they are paths this derivation deliberately leaves to the shell, and a
 * check that flagged them would mark every project drifted forever, which is how a check gets ignored.
 */
export function uncoveredRoutes(config: WorkerConfig, patterns: readonly string[]): string[] {
  const covered = new Set(patterns);
  const uncovered = new Set<string>();
  for (const path of composedPaths(config)) {
    const segment = firstSegment(path);
    if (!segment) continue;
    if (covered.has(`/${segment}`) && covered.has(`/${segment}/*`)) continue;
    uncovered.add(path);
  }
  return [...uncovered].sort();
}

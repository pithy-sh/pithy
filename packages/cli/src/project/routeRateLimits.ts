// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename } from "node:path";
import type { TestBinding } from "@pithy-sh/core/src/capability/testBinding";
import { createBackend } from "@pithy-sh/core/src/createBackend";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { type RouteRateLimitBinding, routeRateLimitBindings } from "@pithy-sh/core/src/http/rateLimitDeclarations";
import { isRouteRateLimitBinding } from "@pithy-sh/core/src/http/routeRateLimit";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { routeGroupsOf } from "@pithy-sh/core/src/openapi/routeGroups";
import { bindingSlot, envStanzas, rateLimitNamespaceId, type WranglerStanza } from "./bindingEntries";
import { composeFor } from "./composeFor";
import type { WorkerConfig } from "./config";
import { writeTestBindings } from "./workersTestConfig";
import { readOptionalWranglerConfig, writeWranglerConfig } from "./wrangler";

/**
 * **The rate limiters a Worker's routes declare, written into its `wrangler.jsonc` by `pithy worker sync`.**
 *
 * A route declares `describeRoute({ rateLimit })`; the binding that enforces it is read off the app the Worker
 * composes, one per policy, and written into every stanza with the policy as its `simple` block and a `namespace_id`
 * derived from its name by {@link rateLimitNamespaceId}. Two bindings whose derived ids collide still never share a
 * counter: the gate's key names the method and the route, which no other limiter's key does. A
 * `ROUTE_RATE_LIMIT_<limit>_PER_<period>S` entry no route declares any more is taken out; every other limiter is
 * the adopter's or a capability's, and is left as it is.
 */

/** Every rate-limit binding the routes of this Worker declare, composed for `environment`. */
export function composedRouteRateLimits(environment: string, config: WorkerConfig): Promise<RouteRateLimitBinding[]> {
  return composeFor(environment, async () => {
    const app = createBackend({ capabilities: config.capabilities, ...(config.app ? { app: config.app } : {}) });
    const groups = await routeGroupsOf(app);
    if (groups === undefined) {
      throw new InternalError({ detail: "createBackend assembled an app without recording its route groups." });
    }
    return routeRateLimitBindings(groups);
  });
}

/** What one stanza's limiters became. */
export interface RouteRateLimitRun {
  /** The environment: `dev` for the top-level stanza. */
  env: string;
  /** The route limiters written into it. */
  written: string[];
  /** The route limiters taken out of it, because no route declares them. */
  removed: string[];
}

/** Options for {@link reconcileRouteRateLimits}. */
export interface ReconcileRouteRateLimitsOptions {
  /** The Worker's directory. */
  workerDir: string;
  /** The limiters its routes declare. */
  limits: readonly RouteRateLimitBinding[];
  /** Just this environment. Omitted, every stanza the config declares. */
  env?: string;
}

interface RatelimitEntry {
  name?: unknown;
}

/**
 * Bring each stanza's route limiters to exactly `limits`. The file is written only when one changed, and a Worker
 * with no `wrangler.jsonc` has no stanza to reconcile.
 */
export async function reconcileRouteRateLimits(options: ReconcileRouteRateLimitsOptions): Promise<RouteRateLimitRun[]> {
  const config = (await readOptionalWranglerConfig(options.workerDir)) as WranglerStanza | null;
  if (config === null) return [];
  const declared = new Set(options.limits.map((limit) => limit.name));
  const runs: RouteRateLimitRun[] = [];
  for (const { env, stanza } of envStanzas(config)) {
    if (options.env !== undefined && env !== options.env) continue;
    const run: RouteRateLimitRun = { env, written: [], removed: [] };
    const existing = (stanza as { ratelimits?: RatelimitEntry[] }).ratelimits;
    if (Array.isArray(existing)) {
      for (let index = existing.length - 1; index >= 0; index -= 1) {
        const name = existing[index]?.name;
        if (typeof name === "string" && isRouteRateLimitBinding(name) && !declared.has(name)) {
          existing.splice(index, 1);
          run.removed.unshift(name);
        }
      }
    }
    for (const limit of options.limits) {
      if (Array.isArray(existing) && existing.some((entry) => entry?.name === limit.name)) continue;
      bindingSlot(stanza, "ratelimits", []).push({
        name: limit.name,
        namespace_id: rateLimitNamespaceId(limit.name),
        simple: { limit: limit.limit, period: limit.period },
      });
      run.written.push(limit.name);
    }
    runs.push(run);
  }
  if (runs.some((run) => run.written.length > 0 || run.removed.length > 0)) {
    await writeWranglerConfig(options.workerDir, config);
  }
  return runs;
}

/**
 * Give the project's Workers test config each declared limiter it lacks, through the writer `pithy add` uses. The
 * config is the whole project's, so a limiter another Worker still declares may be in it: nothing is taken out.
 */
export function writeRouteRateLimitTestBindings(
  projectDir: string,
  worker: string,
  limits: readonly RouteRateLimitBinding[],
): Promise<string[]> {
  const bindings: TestBinding[] = limits.map((limit) => ({
    kind: "ratelimit",
    name: limit.name,
    limit: limit.limit,
    period: limit.period,
  }));
  return bindings.length === 0 ? Promise.resolve([]) : writeTestBindings(projectDir, worker, bindings);
}

/**
 * What `pithy add` does for the routes the Worker now composes: the same reconcile `pithy worker sync` runs, over
 * every stanza, and the Workers test config given each limiter. A Worker whose config does not load or compose yet
 * is left as it is: `pithy add`'s own migrate step reports that config, and `pithy worker sync` writes the limiters
 * once it composes, refusing with the reason when it does not.
 */
export async function addRouteRateLimits(options: {
  projectDir: string;
  workerDir: string;
  config: () => Promise<WorkerConfig>;
}): Promise<string[]> {
  let limits: RouteRateLimitBinding[];
  try {
    limits = await composedRouteRateLimits(LOCAL_ENVIRONMENT, await options.config());
  } catch {
    return [];
  }
  const runs = await reconcileRouteRateLimits({ workerDir: options.workerDir, limits });
  const notes = await writeRouteRateLimitTestBindings(options.projectDir, basename(options.workerDir), limits);
  const written = [...new Set(runs.flatMap((run) => run.written))];
  return written.length === 0
    ? notes
    : [`Rate limiters written for the routes that declare them: ${written.join(", ")}.`, ...notes];
}

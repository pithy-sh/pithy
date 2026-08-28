// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { WORKER_ORIGIN_VAR } from "@pithy-sh/core/src/worker/identity";

/**
 * The slice of `@cloudflare/vite-plugin`'s worker config this touches.
 *
 * Structural rather than imported. `@pithy-sh/vite` does not depend on that plugin — an adopter picks
 * its own version — and naming one field is enough to be checked against it at the call site, where the
 * real type applies.
 */
export interface WorkerVars {
  /** The Worker's plain environment variables, as `wrangler.jsonc` declared them. */
  vars?: Record<string, WorkerVarValue>;
}

/**
 * What a wrangler `vars` entry may hold — wrangler's own `Json`, restated.
 *
 * Restated rather than imported for the reason {@link WorkerVars} is structural, and it has to be this
 * exact shape rather than `unknown`: the customizer's return type is checked against
 * `Partial<WorkerConfig>` at the call site, and `Record<string, unknown>` is not assignable to
 * `Record<string, Json>` — an index signature is invariant. A looser type here compiles in this package
 * and fails in every adopter's, which is the worst place to find out.
 */
export type WorkerVarValue = string | number | boolean | null | WorkerVarValue[] | { [key: string]: WorkerVarValue };

/**
 * Give the Worker the origin `pithy dev` allocated this checkout, as `BASE_URL`.
 *
 * Spread into `@cloudflare/vite-plugin`'s `config` customizer:
 *
 * ```ts
 * cloudflare({ config: devWorkerConfig() })
 * ```
 *
 * **Why an adopter writes a line at all.** A Worker launched through `wrangler dev` is handed its own
 * origin on the argv, by `pithy dev`, with nothing to configure. A Worker launched through a custom
 * `dev.command` is a Vite dev server, and there is no argv to append a `--var` to: `@cloudflare/vite-plugin`
 * takes the Worker's `vars` from `wrangler.jsonc`, and the only documented way in is this customizer,
 * which lives in the adopter's `vite.config.ts`. `pithy init` scaffolds it; an existing project adds
 * the line once and `pithy doctor` says so until it does.
 *
 * **Why it has to be given rather than written down.** A dev port is *allocated* — every checkout
 * reserves its own block — so a `vars.BASE_URL` in `wrangler.jsonc` is right in the first checkout on a
 * machine and wrong in every other one. That is not cosmetic: `BASE_URL` is the `iss` on every
 * control-plane token a Worker signs and the origin its callback links are built against, so a second
 * checkout signed tokens as the first one and its own seam denied every call, 401, with every stored
 * value agreeing (#462, `pithy-sh/dashboard#95`).
 *
 * **Outside `pithy dev` it does nothing at all.** A plain `vite dev`, a build, or CI has no
 * {@link WORKER_ORIGIN_VAR} in its environment, and the Worker keeps whatever `wrangler.jsonc` says —
 * which for a deployed environment is the value `applyDomains` generated from `domains`, and is
 * correct. This never invents an origin; it only passes on one that was allocated.
 */
export function devWorkerConfig(env: NodeJS.ProcessEnv = process.env): (config: WorkerVars) => WorkerVars {
  return (config) => {
    const origin = env[WORKER_ORIGIN_VAR];
    // Absent, blank, or whitespace is "nobody allocated one", never "use the empty string". An empty
    // `BASE_URL` is worse than a wrong one: it fails a URL parse somewhere far from here rather than
    // being denied at the seam with the origin named.
    if (origin === undefined || origin.trim() === "") return {};
    return { vars: { ...config.vars, BASE_URL: origin } };
  };
}

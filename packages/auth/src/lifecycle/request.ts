// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { EmailEnqueueEnv } from "@pithy-sh/email/src/capability";
import type { Context } from "hono";
import type { AuthWiring } from "../capability";
import { authDatabase } from "../data/tables";
import { resolveDb } from "../http/resolve";
import type { LifecycleDeps } from "./transitions";

/**
 * The transitions' dependencies, resolved from one request — what a lifecycle route hands `./transitions.ts`.
 *
 * One function so every route resolves them the same way: this request's database, its audit seam and logger,
 * the composed email capability's enqueue bound to this request's env, and the adopter's hooks as `auth()` was
 * handed them. A route that assembled its own would be the second place a hook could be forgotten.
 */
export function lifecycleDeps(c: Context<PithyHonoEnv>, wiring: AuthWiring): LifecycleDeps {
  const d1 = resolveDb(c.env, wiring.config.database);
  const enqueue = wiring.enqueueEmail;
  return {
    db: authDatabase(d1),
    d1,
    emit: c.var.emit,
    config: wiring.config,
    hooks: wiring.lifecycleHooks ?? {},
    enqueueEmail: enqueue ? (input) => enqueue(c.env as unknown as EmailEnqueueEnv, input) : undefined,
    log: c.var.log?.child("auth"),
  };
}

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { Context } from "hono";
import type { SecretsStatusDb } from "../admin/status";
import { secretsTables } from "./tables";

/**
 * The per-environment secrets D1 for one request, typed over this capability's tables.
 *
 * One reader, because there are now two callers — the management routes and the manifest's health
 * summary — and a binding rule that lives at a call site is a rule the second call site gets wrong.
 * Every defect class in this kit with three producers began exactly there.
 */
export function secretsStatusDatabase(c: Context<PithyHonoEnv>): SecretsStatusDb {
  const binding = (c.env as Record<string, unknown>).SECRETS as D1Database | undefined;
  if (!binding) {
    throw new InternalError({
      message: "The secrets store is not configured.",
      action: "Bind a D1 database named SECRETS in wrangler.jsonc.",
      detail: "The secrets management surface requires a `SECRETS` D1 binding; none was present on env.",
    });
  }
  return createDatabase(binding, secretsTables);
}

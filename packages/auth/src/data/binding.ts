// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";

/** Read the configured D1 binding by name from the worker env, or fail loudly (not a silent undefined). */
export function resolveDb(env: Record<string, unknown>, bindingName: string): D1Database {
  const binding = env[bindingName];
  if (!binding) {
    throw new InternalError({
      message: "The auth database binding is missing.",
      detail: `D1 binding "${bindingName}" is not present on the worker env`,
    });
  }
  return binding as D1Database;
}

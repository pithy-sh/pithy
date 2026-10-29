// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { SessionRotatedListener } from "@pithy-sh/core/src/session/rotated";
import { organizationDatabase } from "../data/tables";
import { carryActing } from "./acting";

/**
 * Carry the acting selection across a refresh-credential rotation, over the D1 binding the tenancy tables
 * live in. Declared as `sessionRotated` on the capability; auth announces the rotation through core.
 */
export function carryActingOnRotation(database: string): SessionRotatedListener {
  return async ({ env, previousSessionId, sessionId, userId }) => {
    const binding = env[database];
    if (typeof binding !== "object" || binding === null) {
      throw new InternalError({
        message: "The organization database is not bound, so the acting organization could not follow the session.",
        action: `Bind the ${database} D1 database to this Worker.`,
        detail: `session rotation found no ${database} binding on the env`,
      });
    }
    await carryActing(organizationDatabase(binding as D1Database), { previousSessionId, sessionId, userId });
  };
}

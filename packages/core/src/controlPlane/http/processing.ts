// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Context } from "hono";
import type { PithyHonoEnv } from "../../capability/capability";
import { readProcessingRecord } from "../processing/read";
import { type ControlPlaneHandlerDeps, caller } from "./handlers";
import type { ControlPlaneProcessingResponse } from "./responses";

/**
 * `GET /control-plane/processing` — the record of processing activities, GDPR Article 30. Each activity's purpose,
 * classes, legal basis, recipients, retention and measures, and every gap named. Read-only.
 */
export function processingHandler(deps: ControlPlaneHandlerDeps) {
  return async (c: Context<PithyHonoEnv>) => {
    const context = caller(c);
    return c.json((await readProcessingRecord(c, deps, context)) satisfies ControlPlaneProcessingResponse);
  };
}

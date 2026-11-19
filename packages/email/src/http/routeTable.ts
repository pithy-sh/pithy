// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { adminRouteTable, type DeclaredRoute, declareRoutes } from "@pithy-sh/core/src/http/lazyRoutes";
import { emailAdminRoutes } from "./guards";

/** The mount prefix of the callback routes. Tracking URLs are built against `${baseUrl}${CALLBACK_BASE}`. */
export const CALLBACK_BASE = "/_pithy/email";

/**
 * Every route the email capability mounts: the public callbacks under their fixed {@link CALLBACK_BASE}, then
 * the management surface under `base`.
 */
export function emailRouteTable(base: string): DeclaredRoute[] {
  return [
    ...declareRoutes(CALLBACK_BASE, [
      ["GET", "/c/:token"],
      ["GET", "/o/:token"],
      ["GET", "/u/:token"],
      ["POST", "/u/:token"],
    ]),
    ...adminRouteTable(emailAdminRoutes(base)),
  ];
}

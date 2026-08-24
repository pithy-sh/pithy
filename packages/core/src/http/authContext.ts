// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { Locale } from "../i18n/locale";

/**
 * The auth seam. `@pithy-sh/core` defines this shape; `@pithy-sh/auth` populates it on the
 * request via the `bearer`/`session` strategies. Other capabilities depend only on this
 * object (and `requireAuth`), never on auth internals.
 *
 * **`locale` rides here rather than being fetched**, because the session lookup has already loaded the
 * user row and a second read of the same fact would be a query per request for a string auth is
 * holding. It is the `user` link of `@pithy-sh/i18n`'s server chain — the one that makes a reader's
 * stored choice outrank their device's `Accept-Language`. That link read `c.var.locale` at first,
 * which nothing ever wrote, so it silently contributed nothing and the chain degraded to
 * `param → cookie → header → default` while the docs said otherwise.
 */
export const AuthContext = z
  .object({
    userId: z.string().describe("ID of the authenticated user (populated by @pithy-sh/auth)."),
    sessionId: z.string().describe("ID of the active session this request belongs to."),
    scopes: z.array(z.string()).default([]).describe("Permission scopes granted to this session."),
    locale: Locale.nullish().describe(
      "The reader's own stored language, from `pithy_auth_users.locale`; null or absent when they have never chosen.",
    ),
  })
  .describe("Per-request authenticated identity; the seam other capabilities depend on.");
export type AuthContext = z.infer<typeof AuthContext>;

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
 *
 * **`scopes` answers one question: did this request come from the adopter's own trusted backend, or from a
 * device?** The name reads like a grant to the user, and it is not one. Tenancy roles went to `c.var.acting`
 * with `@pithy-sh/organization`; management access is the control plane's, with its own credential and its
 * own scope type. What is left is an attestation about the caller, which `@pithy-sh/auth`'s `resolveScopes`
 * makes on every request from something the request proves — a service binding, a verified client
 * certificate, a short-lived token bound to this origin — and never from anything it merely says (#560).
 */
export const AuthContext = z
  .object({
    userId: z.string().describe("ID of the authenticated user (populated by @pithy-sh/auth)."),
    sessionId: z.string().describe("ID of the active session this request belongs to."),
    scopes: z
      .array(z.string())
      .default([])
      .describe(
        "Attestations about the caller, not permissions granted to the user: what this request's caller was established to be — the adopter's own trusted backend, say — by the `resolveScopes` seam on `@pithy-sh/auth`, resolved per request and never cached. Empty when no resolver is configured. Tenancy roles are not here; they are `c.var.acting`.",
      ),
    locale: Locale.nullish().describe(
      "The reader's own stored language, from `pithy_auth_users.locale`; null or absent when they have never chosen.",
    ),
    authenticatedAt: z
      .date()
      .nullish()
      .describe(
        "When the holder of this session last actually authenticated — a sign-in, never a rotation, which carries the value forward unchanged. It rides here for the same reason `locale` does: the session lookup has already loaded the row, so a gate that needs it should not pay for a second read. Distinct from the session's own `createdAt`, which `/token/rotate` stamps fresh and is therefore resettable by anyone holding a stolen refresh token. Null or absent for a session written before the column existed, and for a Worker whose auth capability predates it.",
      ),
  })
  .describe("Per-request authenticated identity; the seam other capabilities depend on.");
export type AuthContext = z.infer<typeof AuthContext>;

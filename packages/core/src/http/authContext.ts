// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * The auth seam. `@pithy-sh/core` defines this shape; `@pithy-sh/auth` populates it on the
 * request via the `bearer`/`session` strategies. Other capabilities depend only on this
 * object (and `requireAuth`), never on auth internals.
 */
export const AuthContext = z
  .object({
    userId: z.string().describe("ID of the authenticated user (populated by @pithy-sh/auth)."),
    sessionId: z.string().describe("ID of the active session this request belongs to."),
    scopes: z.array(z.string()).default([]).describe("Permission scopes granted to this session."),
  })
  .describe("Per-request authenticated identity; the seam other capabilities depend on.");
export type AuthContext = z.infer<typeof AuthContext>;

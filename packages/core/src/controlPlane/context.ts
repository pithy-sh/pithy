// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { ControlPlaneScope } from "./scope/scope";

/**
 * The verified control-plane caller, on `c.var.controlPlane`.
 *
 * **This is deliberately not `AuthContext`, and the two must never be conflated.** A management client
 * is not a user of the adopter's app: it holds no session, owns no user row, and signed up for
 * nothing. If a control-plane call populated `c.var.auth`, every `requireAuth()` in every capability
 * would pass for it — a scope escalation across the whole tree, from one seemingly convenient
 * assignment. So the seam gets its own request variable, and `requireControlPlane` is the only gate
 * that reads it.
 *
 * Statelessness is the feature. Nothing here is persisted: the context is derived from one token,
 * lives for one request, and is discarded. There is no session to hijack and no row to leak. Exactly
 * two things outlive the call — the `jti` in the replay set, and the audit event.
 */
export const ControlPlaneContext = z
  .object({
    connectionId: z
      .string()
      .describe(
        "The connection this call authenticated against — the token's `aud`, verified against the loaded registration. Identifies the management client, per adopter, per project, per environment.",
      ),
    environment: z
      .string()
      .describe(
        "The environment the connection is bound to, already checked against this Worker's own. A staging credential never reaches production, so by the time this is set the two agree.",
      ),
    issuer: z
      .string()
      .describe(
        "The `iss` this connection trusts and this token carried. Verified, not merely recorded — it is the origin the adopter agreed to accept calls from.",
      ),
    subject: z
      .string()
      .describe(
        "The management client's own user id from the token's `sub` — who, on their side, is acting. Recorded as the audit `actorId` so the trail answers 'which person at the dashboard did this', not just 'the dashboard'.",
      ),
    scope: ControlPlaneScope.describe(
      "The single scope this token was minted for. One call, one operation — a token carrying the whole grant would make every call as dangerous as the most dangerous one.",
    ),
    grantedScopes: z
      .array(ControlPlaneScope)
      .describe(
        "Every scope the adopter granted this connection, read from their own row. The authority: a scope absent here is denied however the token is written.",
      ),
    keyId: z
      .string()
      .describe(
        "Which registered key verified this call. Recorded so a rotation can be traced through the trail, and so a key still in use is visible before it is expired.",
      ),
    tokenId: z
      .string()
      .describe("The token's `jti`, already claimed in the replay set. Recorded to tie one audit event to one call."),
  })
  .describe(
    "The verified control-plane caller for one request. Never an AuthContext: a management client is not a user of the adopter's app.",
  );
export type ControlPlaneContext = z.output<typeof ControlPlaneContext>;

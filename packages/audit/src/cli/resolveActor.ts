// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import type { AuditActorType, AuditMetadata } from "@pithy-sh/core/src/audit/auditEvent";
import { messageOf } from "@pithy-sh/core/src/error/pithyError";

/**
 * The slice of `@pithy-sh/cloudflare`'s `CloudflareUserManager` actor resolution needs — declared
 * structurally so the resolver is unit-testable with a fake and the audit package never hard-depends
 * on the concrete manager. `clients.user()` satisfies it.
 */
export interface CfActorSource {
  /** The Cloudflare user behind a user token (`GET /user`). */
  getUser(): Promise<{ id?: string; email?: string }>;
  /** Verify the calling token, returning its id + status (`GET /user/tokens/verify`). */
  verifyToken(): Promise<{ id: string; status: string }>;
  /** The name of a token by id, or `null` (`GET /user/tokens/:id`). */
  getTokenName(tokenId: string): Promise<string | null>;
}

/** A resolved CLI actor: who to attribute a control-plane audit event to, plus correlation metadata. */
export interface ResolvedActor {
  /** The kind of principal. */
  actorType: AuditActorType;
  /** The principal's id (a user email, a token name), or null when unresolved. */
  actorId: string | null;
  /** Correlation detail for the event's `metadata` — never the raw token value. */
  metadata: AuditMetadata;
}

/** The fallback actor when resolution can't attribute the action: `system`, with a note (never fatal). */
function systemActor(note: string): ResolvedActor {
  return { actorType: "system", actorId: null, metadata: { actorResolutionFailed: true, note } };
}

/**
 * Resolve the actor behind a CF API token from its **prefix** — the only part read, never the value:
 *
 * - `cfut_*` (user token) → a human developer. Resolve the user's email via `GET /user`; the CF user
 *   id rides in `metadata` for stable cross-reference. `actorType: "user"`, `actorId: <email>`.
 * - `cfat_*` (account token) → a service account or CI pipeline. Verify the token, then read its name;
 *   `actorType: "service"`, `actorId: <token-name>` (the token id is the fallback and rides in
 *   `metadata`).
 *
 * Resolution failure — a bad token, a network error, an unrecognized prefix — is **never fatal**: it
 * returns a `system` actor with a `metadata` note, so the event is still written, just unattributed.
 */
export async function resolveActor(apiToken: string, source: CfActorSource): Promise<ResolvedActor> {
  try {
    if (apiToken.startsWith("cfut_")) {
      const user = await source.getUser();
      return {
        actorType: "user",
        actorId: user.email ?? user.id ?? null,
        metadata: { cfTokenType: "user", cfUserId: user.id ?? null },
      };
    }
    if (apiToken.startsWith("cfat_")) {
      const verification = await source.verifyToken();
      const name = await source.getTokenName(verification.id);
      return {
        actorType: "service",
        actorId: name ?? verification.id,
        metadata: { cfTokenType: "account", cfTokenId: verification.id, cfTokenStatus: verification.status },
      };
    }
    return systemActor("Unrecognized Cloudflare API token prefix; expected `cfut_` or `cfat_`.");
  } catch (error) {
    return systemActor(`Cloudflare actor resolution failed: ${messageOf(error)}`);
  }
}

/**
 * A resolver that runs {@link resolveActor} **once** and caches the result for the lifetime of a CLI
 * command — actor identity is resolved at session start, not per event. Memoizes the in-flight
 * promise so concurrent emits share the single resolution.
 */
export function createCachedActorResolver(apiToken: string, source: CfActorSource): () => Promise<ResolvedActor> {
  let cached: Promise<ResolvedActor> | undefined;
  return () => {
    cached ??= resolveActor(apiToken, source);
    return cached;
  };
}

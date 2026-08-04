// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import type { AuditActorType, AuditMetadata } from "@pithy-sh/core/src/audit/auditEvent";
import { messageOf } from "@pithy-sh/core/src/error/pithyError";

/** The user-scoped slice: who is behind a `cfut_*` token. `clients.user()` satisfies it. */
export interface CfUserActorSource {
  /** The Cloudflare user behind a user token (`GET /user`). */
  getUser(): Promise<{ id?: string; email?: string }>;
}

/** The account-scoped slice: which credential a `cfat_*` token is. `clients.accountTokens()` satisfies it. */
export interface CfAccountTokenActorSource {
  /** Verify the calling token against the account, returning its id + status (`GET /accounts/{id}/tokens/verify`). */
  verifyToken(): Promise<{ id: string; status: string }>;
  /** The token's name by id, or `null` when the caller may not read it (`GET /accounts/{id}/tokens/{id}`). */
  getTokenName(tokenId: string): Promise<string | null>;
}

/**
 * The slices of `@pithy-sh/cloudflare` actor resolution needs — declared structurally so the resolver
 * is unit-testable with a fake and the audit package never hard-depends on the concrete managers.
 * `{ user: clients.user(), accountTokens: clients.accountTokens() }` satisfies it.
 *
 * **Two scopes, not one, because a token is valid in exactly one of them.** An account-owned
 * (`cfat_*`) token — the kind CLAUDE.md prefers and `pithy token mint` produces — answers
 * `Invalid API Token` at every `/user/*` endpoint. A single flat source made the wrong scope
 * reachable from the account path, and since resolution failure is never fatal, the whole preferred
 * setup silently attributed to `system`. Split, the account path cannot reach a user endpoint at all.
 */
export interface CfActorSource {
  /** User-scoped reads, for a `cfut_*` token. */
  user: CfUserActorSource;
  /** Account-scoped reads, for a `cfat_*` token. */
  accountTokens: CfAccountTokenActorSource;
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
 * - `cfat_*` (account token) → a service account or CI pipeline. Verify the token **against the
 *   account**, then read its name; `actorType: "service"`, `actorId: <token-name>` (the token id is
 *   the fallback and rides in `metadata`).
 *
 * The name is best-effort by design. Reading a token record needs `API Tokens Read`, which the
 * least-privilege tokens `pithy token mint` produces deliberately do not carry, so the account source
 * answers `null` there and `actorId` falls back to the token id — which verify always yields, for any
 * account token, with no permission at all. Attribution stays on the credential either way — once
 * verify has named it, nothing about a decorative label may take that back — so a name read that
 * *fails* rather than declining takes the same fallback, and records why in `metadata.cfTokenNameError`
 * instead of vanishing. Widening the mint permission set to make the name readable would trade least
 * privilege for a label.
 *
 * Resolution failure — a bad token, a network error, an unrecognized prefix — is **never fatal**: it
 * returns a `system` actor with a `metadata` note, so the event is still written, just unattributed.
 */
export async function resolveActor(apiToken: string, source: CfActorSource): Promise<ResolvedActor> {
  try {
    if (apiToken.startsWith("cfut_")) {
      const user = await source.user.getUser();
      return {
        actorType: "user",
        actorId: user.email ?? user.id ?? null,
        metadata: { cfTokenType: "user", cfUserId: user.id ?? null },
      };
    }
    if (apiToken.startsWith("cfat_")) {
      const verification = await source.accountTokens.verifyToken();
      // Verify has already named the credential, so the name read cannot cost us the attribution: it
      // falls back to the token id rather than collapsing a known credential to `system`. It does not
      // pass unremarked, though — a trail that degrades quietly is the defect this path had. The two
      // cases are different and the record says which: a **declined** read (the source answers `null`)
      // is the ordinary least-privilege shape and needs no note, while a read that **failed** leaves
      // its reason in `metadata` for whoever asks why the actor is an id and not a name.
      let nameError: string | undefined;
      const name = await source.accountTokens.getTokenName(verification.id).catch((error: unknown) => {
        nameError = messageOf(error);
        return null;
      });
      return {
        actorType: "service",
        actorId: name ?? verification.id,
        metadata: {
          cfTokenType: "account",
          cfTokenId: verification.id,
          cfTokenStatus: verification.status,
          ...(nameError === undefined ? {} : { cfTokenNameError: nameError }),
        },
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

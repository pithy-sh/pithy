// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { JsonDate } from "../../data/codecs";
import { ControlPlaneKeyConflictError } from "../error/errors";

/**
 * An OIDC trust: the second credential kind a connection may hold, beside a registered key
 * (`docs/AGENT-ACCESS.md` §6.2, #722).
 *
 * A key is a bearer: one client holds the private half. A trust is a **policy**: a trusted issuer, the
 * audience its tokens must name, and a matcher over the claims that say which workload a token was minted
 * for. Nobody holds a secret. The workload asks its own identity provider for a short-lived token, and the
 * Worker checks it against the issuer's published keys with the verifier the webhooks already use,
 * `core/src/http/oidcWebhook.ts`.
 *
 * ## The claims become data here, and that is a deliberate departure
 *
 * In a webhook the claims check is a predicate the **route** holds, because whoever wrote the route knows
 * the legitimate sender. A connection's trust is per adopter, decided at registration by the same person who
 * grants the scopes, so the matcher is stored with the trust and validated on the way in. That is the whole
 * reason {@link OidcClaimMatch} exists rather than a function.
 *
 * ## The claims check is the boundary, not the signature
 *
 * An identity provider signs for everybody with the same keys. GitHub signs a token for every repository on
 * the planet. A trust whose matcher constrains nothing accepts all of them, so {@link OidcClaimMatch} refuses
 * one at registration — structurally, not as a warning — and refuses the claims that name the token rather
 * than the workload ({@link RESERVED_OIDC_CLAIMS}), since a matcher made of those constrains nothing either.
 *
 * ## Named claims, not the `sub` string
 *
 * A `sub` is a concatenation whose composition belongs to the provider and to the adopter's own template.
 * The claims beneath it — GitHub's `repository_id`, `environment`, `ref`; GitLab's `project_id` — are
 * published individually and are stable. So the matcher is a map of claim names to values, and `sub` is one
 * claim among the others rather than a special case.
 *
 * ## No rotation, and revocation changes shape
 *
 * There is no key to append, prove and expire. A token cannot be revoked; the trust is, and every token
 * already minted stays live until it expires — {@link TRUST_REVOCATION_LATENCY} is the sentence that says
 * so at the moment it matters.
 *
 * Nothing in this module reads a clock, a binding or D1. `now` is injected wherever time matters.
 */

/**
 * Claims that name the token rather than the workload: who minted it, for whom, and when. A matcher built
 * from these alone would accept every workload the issuer serves, so none of them may be registered.
 * `iss` and `aud` are checked anyway, by the trust's own issuer and audience.
 */
export const RESERVED_OIDC_CLAIMS = ["iss", "aud", "exp", "nbf", "iat", "jti"] as const;

/** The most claims one trust may match on. Far above any real constraint; a bound on a stored row. */
export const MAX_TRUST_CLAIMS = 16;

/** The most claims a refusal records, so a token carrying a hundred cannot fill the audit trail. */
export const MAX_OBSERVED_CLAIMS = 32;

/** The longest claim value a matcher stores or a refusal records. */
export const MAX_CLAIM_VALUE = 256;

/** A claim name: the plain alphabet providers use, plus `.`, `:` and `-` for a customized template. */
const CLAIM_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Every C0 and C1 control, the line separators, and the bidi controls: a value is one line of plain text. */
const UNRENDERABLE = /[\p{Cc}\p{Bidi_Control}\u2028\u2029]/u;

const reserved = new Set<string>(RESERVED_OIDC_CLAIMS);

/**
 * One claim name in a matcher. A name, not a path: nested claims are not matched, because a matcher that
 * walks a structure is a matcher with more ways to be wrong on the check the whole trust rests on.
 */
export const OidcClaimName = z
  .string()
  .regex(CLAIM_NAME, "A claim name is letters, digits, `_`, `.`, `:` or `-`, at most 64.")
  .refine((name) => !reserved.has(name), {
    message: `${RESERVED_OIDC_CLAIMS.join(", ")} name the token, not the workload, so they cannot constrain a trust.`,
  })
  .describe(
    "A claim the token must carry, by name — `repository_id`, `environment`, `project_id`, `sub`. Never one of the claims that name the token itself.",
  );
export type OidcClaimName = z.infer<typeof OidcClaimName>;

/** One claim value in a matcher: compared as a string against the token's claim of the same name. */
export const OidcClaimValue = z
  .string()
  .min(1, "A claim value cannot be empty.")
  .max(MAX_CLAIM_VALUE, `A claim value is ${MAX_CLAIM_VALUE} characters at most.`)
  .refine((value) => !UNRENDERABLE.test(value), "A claim value is one line of plain text.")
  .describe(
    "The exact value that claim must have. A numeric or boolean claim is compared by its string form, so `1262274726` matches a `repository_id` whichever way the provider typed it.",
  );
export type OidcClaimValue = z.infer<typeof OidcClaimValue>;

/**
 * Which workloads a trust accepts: every named claim must equal its value.
 *
 * **At least one, and that is the refusal the whole credential kind rests on.** An issuer with no claim
 * constraint accepts every workload it serves.
 */
export const OidcClaimMatch = z
  .record(OidcClaimName, OidcClaimValue)
  .refine((claims) => Object.keys(claims).length > 0, {
    message: "A trust needs at least one claim constraint. An issuer alone accepts every workload it serves.",
  })
  .refine((claims) => Object.keys(claims).length <= MAX_TRUST_CLAIMS, {
    message: `A trust matches on ${MAX_TRUST_CLAIMS} claims at most.`,
  })
  .describe(
    "The subject constraint: every named claim must equal its value. At least one, because an issuer alone accepts every workload it serves.",
  );
export type OidcClaimMatch = z.infer<typeof OidcClaimMatch>;

/** An https URL. A trust's issuer and key endpoint are fetched from, so plain http is refused. */
const HttpsUrl = z.url({ protocol: /^https$/ });

/**
 * One registered OIDC trust, an element of the connection's `trusts` column.
 *
 * Stored beside `keys` rather than inside it: the two kinds share nothing but the connection they grant
 * through, and a union array would make every key reader learn about trusts.
 */
export const OidcTrust = z
  .object({
    trustId: z
      .string()
      .min(1)
      .max(64)
      .describe(
        "The trust's id, named by a call on the `pithy-control-plane-trust` header the way a token's `kid` names a key. Not a secret.",
      ),
    issuer: HttpsUrl.describe(
      "The exact `iss` this trust accepts — `https://token.actions.githubusercontent.com`, `https://gitlab.com`. A token from any other issuer is refused before its claims are read.",
    ),
    jwksUrl: HttpsUrl.describe(
      "Where the issuer publishes the keys that sign its tokens, read from its discovery document at registration. Public, so configuration and not a secret.",
    ),
    audience: z
      .string()
      .min(1)
      .max(512)
      .describe(
        "The `aud` a token must name. Defaults to this environment's own Worker origin, which is what stops a staging token being replayed against production.",
      ),
    claims: OidcClaimMatch,
    authorizedBy: z
      .email()
      .max(254)
      .describe(
        "Who sanctioned this trust: the signed-in session's email at registration. Never who may use it — a trust's users are whoever its claims admit.",
      ),
    validFrom: JsonDate.describe("When the trust was registered and began to be honored."),
    revokedAt: JsonDate.nullable().describe(
      "When the trust was revoked, or null. Takes effect on the next call; a token already minted is refused from then on, but stays in its holder's hands until it expires.",
    ),
    firstCallAt: JsonDate.nullable().describe(
      "When a call first verified under this trust, or null while it is awaiting a first call. Nothing can prove a trust at registration — there is no private key here and no workload present — so this is the only proof there is.",
    ),
  })
  .describe(
    "One OIDC trust: a trusted issuer, the audience its tokens must name, and the claims that say which workloads it admits.",
  );
export type OidcTrust = z.output<typeof OidcTrust>;

/**
 * What a caller should expect after a trust is revoked, said at the moment it is revoked rather than
 * discovered afterwards.
 */
export const TRUST_REVOCATION_LATENCY =
  "A token cannot be revoked, only the trust. Every call naming this trust is refused from now on, but a token already minted stays in its holder's hands until it expires — the issuer's own lifetime, typically minutes.";

/** Every trust that may verify a call at `now`: not revoked, and started. */
export function activeTrusts(trusts: readonly OidcTrust[], now: Date): OidcTrust[] {
  return trusts.filter((trust) => trust.revokedAt === null && trust.validFrom.getTime() <= now.getTime());
}

/** The trust a call names, if it is live at `now`, or null. The revocation check lives here so no caller forgets it. */
export function findVerifyingTrust(trusts: readonly OidcTrust[], trustId: string, now: Date): OidcTrust | null {
  return activeTrusts(trusts, now).find((trust) => trust.trustId === trustId) ?? null;
}

/** Register a trust beside the others. A duplicate id is refused: the id is what a call addresses. */
export function appendTrust(trusts: readonly OidcTrust[], trust: OidcTrust): OidcTrust[] {
  if (trusts.some((existing) => existing.trustId === trust.trustId)) {
    throw new ControlPlaneKeyConflictError({
      message: "That trust id is already registered on this connection.",
      action: "Register the trust under a new id.",
      detail: `duplicate trustId ${trust.trustId}`,
    });
  }
  return [...trusts, trust];
}

/**
 * Revoke one trust at `now`, or answer null when no trust answers to that id. A trust already revoked keeps
 * the instant it was first revoked: the window a call was refused under must not move.
 */
export function revokeTrust(trusts: readonly OidcTrust[], trustId: string, now: Date): OidcTrust[] | null {
  if (!trusts.some((trust) => trust.trustId === trustId)) return null;
  return trusts.map((trust) =>
    trust.trustId === trustId && trust.revokedAt === null ? { ...trust, revokedAt: now } : trust,
  );
}

/** A claim's string form, or undefined for a value that is not a string, number or boolean. */
function claimString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return undefined;
}

/**
 * Whether a token's claims satisfy a trust's matcher: every registered claim present and equal.
 *
 * An empty matcher matches nothing. Registration refuses one, and this refuses it again rather than letting
 * a hand-edited row vacuously admit every workload.
 */
export function claimsMatch(
  match: Readonly<Record<string, string>>,
  claims: Readonly<Record<string, unknown>>,
): boolean {
  const entries = Object.entries(match);
  if (entries.length === 0) return false;
  return entries.every(([name, expected]) => claimString(claims[name]) === expected);
}

/**
 * The claims a refused token carried, as a refusal records them: the workload's claims, as strings, capped.
 *
 * This is what makes a custom issuer workable and a profiled one self-correcting — register, let the
 * workload run once, read what it actually sent. Only ever called once the signature, issuer and audience
 * have verified, so the caller demonstrably holds a genuine token for this audience and naming its claims
 * leaks nothing it does not already hold.
 */
export function observedClaims(claims: Readonly<Record<string, unknown>>): Record<string, string> {
  const recorded: Record<string, string> = {};
  for (const [name, value] of Object.entries(claims)) {
    if (Object.keys(recorded).length >= MAX_OBSERVED_CLAIMS) break;
    if (reserved.has(name) || !CLAIM_NAME.test(name)) continue;
    const text = claimString(value);
    if (text === undefined) continue;
    recorded[name] = text.slice(0, MAX_CLAIM_VALUE);
  }
  return recorded;
}

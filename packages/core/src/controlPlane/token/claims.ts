// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { ControlPlaneScope } from "../scope/scope";

/**
 * The token a management client presents: what it claims, and what shape the envelope around it must
 * have. This is the wire contract between the hosted dashboard and an adopter's Worker.
 *
 * **Not Cloudflare's control plane.** That is the outbound provisioning REST API this project calls
 * through `@pithy-sh/cloudflare`. This is the inbound admin seam, authenticated by the adopter, in the
 * adopter's Worker. The names collide; nothing else does.
 *
 * These schemas describe *untrusted* data. Parsing one proves the token is well-formed and nothing
 * more — a forged token parses exactly as cleanly as a real one. Authenticity comes only from
 * `verifyEd25519` (`./jws`), and nothing may act on these values before it returns true.
 */

/**
 * How long a token may live, from `iat` to `exp`.
 *
 * A minute is the whole budget: mint, send, verify. Nothing legitimate needs more, because the client
 * mints per call rather than caching a credential.
 *
 * **This cap is what makes the replay window sound.** Replay defense is a `jti` held in a KV set with
 * a TTL, and a set with a TTL only covers tokens that expire inside it. Without a cap, a client could
 * mint an `exp` an hour out; the `jti` would age out after {@link CONTROL_PLANE_JTI_TTL_SECONDS} and
 * the same token would then replay freely for the remaining fifty-odd minutes. So the cap is enforced
 * at verification, not merely recommended — a token whose lifetime exceeds it is rejected however
 * validly it is signed.
 */
export const CONTROL_PLANE_MAX_TOKEN_LIFETIME_SECONDS = 60;

/**
 * How far the two clocks may disagree before a valid call is refused.
 *
 * Applied at both ends: a token is not "not yet valid" until it is this far in the future, and not
 * expired until this far in the past. Machines that never sync do exist, and a management client
 * locked out by a drifting clock has no way to notice, let alone fix it. A minute is generous enough
 * to survive that and short enough to stay inside the replay window below.
 */
export const CONTROL_PLANE_CLOCK_SKEW_SECONDS = 60;

/**
 * How long a spent `jti` stays in the replay set.
 *
 * It must **outlive** the longest window in which its token could still verify — the max lifetime plus
 * a skew at each end, so 60 + 60 + 60 = 180. Shorter, and a token becomes replayable the moment its id
 * ages out; longer only costs storage in a store whose entries expire on their own.
 *
 * 300 rather than exactly 180, because equal is not longer. At 180 the memory ends on the same instant
 * the token stops being accepted, which leaves the boundary decided by whichever clock rounds first —
 * and "the replay window is only open for the last instant" is not a property worth defending. The two
 * extra minutes cost nothing and make the relation a strict inequality, which is what
 * `ControlPlaneConfig` now enforces and `claims.test.ts` asserts.
 */
export const CONTROL_PLANE_JTI_TTL_SECONDS = 300;

/** A base64url SHA-256: 32 bytes, unpadded, exactly 43 characters. */
const BODY_SHA256_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * The JWS protected header.
 *
 * **`alg` is a pinned literal, and that is the algorithm-confusion defense.** The classic JWT breaks
 * are both header-driven: `"alg":"none"` asking the verifier to skip verification, and swapping RS256
 * for HS256 so a *public* key is used as an HMAC secret. Both need the verifier to take its algorithm
 * from the token. Here the schema decides and the token merely has to agree, so neither attack has a
 * shape it can be written in — the header is rejected at parse, before a key is ever imported.
 */
export const ControlPlaneJwsHeader = z
  .object({
    alg: z
      .literal("EdDSA")
      .describe(
        "The signature algorithm, pinned to EdDSA (Ed25519). A literal rather than a choice: the verifier never takes its algorithm from the token, so `none` and HMAC-for-RSA confusion are unrepresentable.",
      ),
    typ: z
      .literal("JWT")
      .describe("The token type, always `JWT`. Pinned so a JWS meant for another purpose cannot be replayed here."),
    kid: z
      .string()
      .min(1)
      .max(64)
      .describe(
        "Which registered key signed this token, matched against the connection's `keys`. A hint for lookup only — an unknown or forged `kid` selects no key and the call is denied.",
      ),
  })
  .describe(
    "The protected header of a control-plane token. Untrusted until the signature verifies; `alg` is pinned rather than read.",
  );
export type ControlPlaneJwsHeader = z.infer<typeof ControlPlaneJwsHeader>;

/**
 * The token payload.
 *
 * Every claim is a check the Worker performs against something it already knows — the connection row,
 * its own clock, its own environment, the body it just read. None of them are informational.
 */
export const ControlPlaneClaims = z
  .object({
    iss: z
      .url()
      .describe(
        "The management client's origin. Checked against the `issuer` the adopter stored on the connection, so a token minted by another origin is denied even if it is validly signed.",
      ),
    aud: z
      .uuid()
      .describe(
        "The connection this token addresses — the row's UUID. A UUID because it is externally exposed; checked so a token for one adopter's connection cannot be presented to another's Worker.",
      ),
    sub: z
      .string()
      .min(1)
      .max(256)
      .describe(
        "The dashboard user acting, in the management client's own id space. Recorded as the audit `actorId` so the trail says which person acted, not merely which service.",
      ),
    scope: ControlPlaneScope.describe(
      "The single operation this token authorizes. One call, one scope: a token carrying the whole grant would make every call as dangerous as the most dangerous one it could make.",
    ),
    jti: z
      .string()
      .min(1)
      .max(128)
      .describe(
        "A unique id for this one token, claimed in the replay set on first use. Bounded so an unbounded string cannot be used to bloat that set.",
      ),
    iat: z
      .int()
      .describe(
        "When the token was minted, in seconds since the epoch. With `exp` it bounds the lifetime, which is capped at CONTROL_PLANE_MAX_TOKEN_LIFETIME_SECONDS.",
      ),
    exp: z
      .int()
      .describe(
        "When the token stops being accepted, in seconds since the epoch. Honored within CONTROL_PLANE_CLOCK_SKEW_SECONDS, and never further out than the max lifetime allows.",
      ),
    bodySha256: z
      .string()
      .regex(BODY_SHA256_PATTERN, "bodySha256 must be a base64url SHA-256 digest.")
      .nullable()
      .describe(
        "Base64url SHA-256 of the request body, binding this token to one call — or null for a request with no body. The signature covers the header and claims only, so without this a token could be lifted onto a different body for the same route.",
      ),
  })
  .describe(
    "The claims a management client signs for exactly one control-plane call. Well-formed after parsing; authentic only after the signature verifies.",
  );
export type ControlPlaneClaims = z.infer<typeof ControlPlaneClaims>;

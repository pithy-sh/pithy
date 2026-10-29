// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { sha256Base64Url, timingSafeEqual } from "@pithy-sh/core/src/controlPlane/token/digest";
import { sqliteJson } from "@pithy-sh/core/src/data/codecs";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import { Verification } from "../data/betterAuth";
import type { AuthDatabase } from "../data/tables";

/**
 * The one-time code that hands a redirect sign-in back to a native app.
 *
 * A social sign-in that ends on an app's deep link cannot carry the session the way a browser does: the
 * cookie lands in the system browser, which the app never reads. So the callback answers the deep link with
 * this code instead, and the app trades it once, over `POST {base}/handoff`, for the session token.
 *
 * **Sixty seconds.** The trade happens the moment the app is opened from the link, so a slow device and a
 * cold start are the whole of what the window has to cover. Anything longer only lengthens the time a code
 * read off a URL log, or caught by another app claiming the same scheme, is still worth something.
 *
 * **Only the code's SHA-256 is stored.** The code carries 256 random bits, so a lookup by its digest leaks
 * nothing a timing comparison could, and a read of the table yields nothing anybody can redeem. The row
 * names the session by id, never by token, so the table holds no credential at all.
 *
 * **The code is bound to the app that started the sign-in**, the way RFC 7636 binds an authorization code. The
 * app makes a random verifier, sends its S256 challenge with the sign-in, and presents the verifier with the
 * code. Another app that claims the same scheme and catches the link holds the code but not the verifier, so
 * the code is worth nothing to it. A code is never issued without a challenge.
 *
 * The rows live in `pithy_auth_verifications`, under their own identifier prefix, as Better Auth's own
 * one-time tokens do. The redemption is one `DELETE … RETURNING`, so one code yields one session however
 * many requests present it at once, and a wrong verifier spends the code as surely as the right one. Each issue
 * also deletes a bounded batch of lapsed codes, so codes nobody traded do not pile up.
 */
export const HANDOFF_TTL_SECONDS = 60;

/** The most lapsed codes one issue deletes. The next issue takes the rest. */
export const HANDOFF_SWEEP_LIMIT = 50;

/** The identifier prefix that keeps these rows apart from every other verification. */
const IDENTIFIER_PREFIX = "pithy-handoff:";

/** An S256 challenge: the base64url SHA-256 of a verifier, unpadded, which is always 43 characters. */
const CHALLENGE_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** An RFC 7636 code verifier: 43 to 128 characters, each unreserved (`A-Z a-z 0-9 - . _ ~`). */
const VERIFIER_SHAPE = /^[A-Za-z0-9\-._~]{43,128}$/;

/** Whether a value has the shape RFC 7636 gives a code verifier. */
export function isHandoffVerifier(value: string): boolean {
  return VERIFIER_SHAPE.test(value);
}

/** Whether a value has the shape of an S256 challenge. */
export function isHandoffChallenge(value: string): boolean {
  return CHALLENGE_SHAPE.test(value);
}

/** The S256 challenge a verifier hashes to: `BASE64URL(SHA-256(verifier))`. */
export function handoffChallengeOf(verifier: string): Promise<string> {
  return sha256Base64Url(new TextEncoder().encode(verifier));
}

/** What a code's row holds in its `value`: the session it stands for and the challenge its verifier must meet. */
export const StoredHandoff = z
  .object({
    sessionId: z.string().describe("The id of the session the code stands for. Never its token."),
    challenge: z
      .string()
      .regex(CHALLENGE_SHAPE)
      .describe("The S256 challenge the app sent with the sign-in. The trade's verifier must hash to it."),
  })
  .describe("A handoff code's row value: the session and the challenge that binds the code to one app.");
export type StoredHandoff = z.output<typeof StoredHandoff>;

/** The `value` column as a handoff: JSON text in SQLite, validated both ways. */
const StoredHandoffValue = sqliteJson(StoredHandoff);

/** What issuing a code answers: the code itself, which is never stored, and when it lapses. */
export interface IssuedHandoff {
  readonly code: string;
  readonly expiresAt: Date;
}

/**
 * What a redemption answers. `unknown` covers a code already spent and one never issued alike. The reasons are
 * for the audit trail; the caller answers every refusal the same way.
 */
export type HandoffRedemption =
  | { readonly ok: true; readonly sessionId: string }
  | { readonly ok: false; readonly reason: HandoffRefusal };

/** Why a code was refused. `malformed` is a verifier outside RFC 7636's shape, which no challenge was made from. */
export type HandoffRefusal = "expired" | "unknown" | "mismatch" | "malformed";

async function identifierOf(code: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${IDENTIFIER_PREFIX}${hex}`;
}

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Delete up to {@link HANDOFF_SWEEP_LIMIT} codes that lapsed by `now`. */
async function sweepLapsed(db: AuthDatabase, now: Date): Promise<void> {
  await db
    .deleteFrom("pithyAuthVerifications")
    .where("id", "in", (lapsed) =>
      lapsed
        .selectFrom("pithyAuthVerifications")
        .select("id")
        .where("identifier", "like", `${IDENTIFIER_PREFIX}%`)
        .where("expiresAt", "<=", Verification.shape.expiresAt.encode(now))
        .limit(HANDOFF_SWEEP_LIMIT),
    )
    .execute();
}

/**
 * Issue a code for a session that already exists, bound to the S256 challenge the app sent. A challenge of any
 * other shape throws: an unbound code is never written.
 */
export async function issueHandoff(
  db: AuthDatabase,
  input: { sessionId: string; challenge: string; now: Date },
): Promise<IssuedHandoff> {
  if (!isHandoffChallenge(input.challenge)) {
    throw new InternalError({ detail: "a handoff code was asked for without an S256 challenge to bind it to" });
  }
  await sweepLapsed(db, input.now);
  const code = randomCode();
  const expiresAt = new Date(input.now.getTime() + HANDOFF_TTL_SECONDS * 1000);
  await db
    .insertInto("pithyAuthVerifications")
    .values(
      Verification.encode({
        id: crypto.randomUUID(),
        identifier: await identifierOf(code),
        value: z.string().parse(StoredHandoffValue.encode({ sessionId: input.sessionId, challenge: input.challenge })),
        expiresAt,
        createdAt: input.now,
        updatedAt: input.now,
      }),
    )
    .execute();
  return { code, expiresAt };
}

/**
 * Spend a code against the verifier the app holds. The row goes whatever the answer, so an expired code, or one
 * presented with the wrong or a malformed verifier, is spent by that attempt and a second attempt reads it as unknown.
 */
export async function redeemHandoff(
  db: AuthDatabase,
  input: { code: string; verifier: string },
  now: Date,
): Promise<HandoffRedemption> {
  const row = await db
    .deleteFrom("pithyAuthVerifications")
    .where("identifier", "=", await identifierOf(input.code))
    .returning(["value", "expiresAt"])
    .executeTakeFirst();
  if (!row) return { ok: false, reason: "unknown" };
  const parsed = StoredHandoffValue.safeParse(row.value);
  if (!parsed.success) return { ok: false, reason: "unknown" };
  const stored = parsed.data;
  const expiresAt = Verification.shape.expiresAt.parse(row.expiresAt);
  if (expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };
  if (!isHandoffVerifier(input.verifier)) return { ok: false, reason: "malformed" };
  if (!timingSafeEqual(await handoffChallengeOf(input.verifier), stored.challenge)) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true, sessionId: stored.sessionId };
}

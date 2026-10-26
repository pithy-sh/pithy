// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import type { AuthDatabase } from "../data/tables";
import type { VerificationType } from "../data/verificationOutcome";

/**
 * Writing the verification ledger (#829): a row when auth issues a sign-in link or code, a stamp when one is used.
 *
 * ## Four moments, one request each, and none of them knows everything
 *
 * Better Auth creates the verification row, then calls the kit's send callback, then — in a later request —
 * consumes the row and creates a session. No single one of those holds the whole record:
 *
 * - **`verification.create.after`** has the row's id and expiry, and no idea what it is for: the same table
 *   holds OAuth state.
 * - **The send callback** knows it is a sign-in link or code and, once the email seam answers, the job that
 *   carries it — and not the row's id, which Better Auth never hands it.
 * - **`verification.delete.before`** sees the row about to be consumed, and not whether the consume wins.
 * - **`session.create.after`** knows somebody signed in, and as whom, and not with what.
 *
 * So each moment leaves what it saw on the request, and the next one in the same request completes the record:
 * the send pairs with the row created just before it, and the session pairs with the row consumed just before
 * it. The request is the endpoint's own per-dispatch context object — the one `../audit/evidence.ts` keys on,
 * which Better Auth hands to database hooks and send callbacks alike — held weakly, so nothing outlives it.
 *
 * ## Why the pairing is safe
 *
 * - **A row created and never sent is never recorded.** OAuth state, and a code Better Auth's own enumeration
 *   guard drops before the send, both stop at the first moment.
 * - **A consume that loses, or one that ends in a refusal, is never stamped.** Only a session created in the
 *   same request stamps it, and Better Auth creates none unless the consume returned the row.
 * - **A row consumed for any other reason matches nothing.** An OAuth callback deletes its state row and
 *   creates a session; the stamp looks for that id in the ledger and finds no row.
 * - **A wrong code moves its row.** Better Auth consumes the code to check it, and on a mismatch creates a new
 *   row with the same value and expiry and one more attempt counted. Recognized by that expiry, the ledger row
 *   follows it, so the right code entered next stamps the row the mail was counted against.
 *
 * ## Never fatal
 *
 * A ledger write that fails is swallowed. The ledger reports on sign-in; it must never be the reason one fails,
 * and every caller here is mid-sign-in.
 *
 * **Not through `delete.after`**, deliberately: every `delete.after` in this package goes through `claimedDelete`
 * (`../audit/evidence.ts`), and claiming a verification removal would delete the row before the consume could
 * read it. `delete.before` sees the same row and changes nothing.
 */

/** What one request has seen so far. */
interface Pending {
  /** The verification row created in this request, awaiting the send that says what it is for. */
  created?: { id: string; issuedAt: Date; expiresAt: Date };
  /** The live verification row about to be consumed in this request, awaiting the session that proves its use. */
  consuming?: { id: string; expiresAt: Date };
}

/** The verification ledger's four writers. */
export interface VerificationLedger {
  /** `verification.create.after`: remember the row, and move a wrong code's ledger row onto its re-issue. */
  created(row: unknown, requestContext: unknown): Promise<void>;
  /** `verification.delete.before`: remember the live row about to be consumed. */
  consuming(row: unknown, requestContext: unknown): void;
  /** The send callback, once the email seam has answered: record the row created in this request. */
  issued(requestContext: unknown, input: IssuedInput): Promise<void>;
  /** `session.create.after`: stamp the row consumed in this request as used, by this user. */
  signedIn(requestContext: unknown, userId: unknown): Promise<void>;
}

/** What the send callback knows. The address is read to find the account and is never stored. */
export interface IssuedInput {
  /** What was issued. */
  type: VerificationType;
  /** Who it was sent to — looked up, never written. */
  email: string;
  /** The `pithy_email_jobs` row that carries it, or null when the seam queued nothing. */
  emailJobId: string | null;
}

/** A date off a Better Auth row: a `Date` from the adapter, an ISO string or a number from anywhere else. */
export function dateOf(value: unknown): Date | null {
  const date =
    value instanceof Date ? value : typeof value === "string" || typeof value === "number" ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

/** The id and dates off a verification row, or null for anything not shaped like one. */
export function verificationRowOf(row: unknown): { id: string; createdAt: Date | null; expiresAt: Date } | null {
  if (typeof row !== "object" || row === null) return null;
  const { id, createdAt, expiresAt } = row as { id?: unknown; createdAt?: unknown; expiresAt?: unknown };
  if (typeof id !== "string" || id === "") return null;
  const expires = dateOf(expiresAt);
  if (!expires) return null;
  return { id, createdAt: dateOf(createdAt), expiresAt: expires };
}

/** Build the ledger's writers over one database. `now` is injectable for the tests that pin a clock. */
export function verificationLedger(db: AuthDatabase, now: () => Date = () => new Date()): VerificationLedger {
  const pending = new WeakMap<object, Pending>();
  const stateOf = (requestContext: unknown): Pending | null => {
    if (typeof requestContext !== "object" || requestContext === null) return null;
    let state = pending.get(requestContext);
    if (!state) {
      state = {};
      pending.set(requestContext, state);
    }
    return state;
  };

  return {
    async created(row, requestContext) {
      const state = stateOf(requestContext);
      const verification = verificationRowOf(row);
      if (!state || !verification) return;
      const consumed = state.consuming;
      // A wrong code: consumed to be checked, and re-created with the same expiry. The ledger row follows it.
      if (consumed && consumed.expiresAt.getTime() === verification.expiresAt.getTime()) {
        state.consuming = undefined;
        await swallow(() =>
          db
            .updateTable("pithyAuthVerificationOutcomes")
            .set({ verificationId: verification.id })
            .where("verificationId", "=", consumed.id)
            .execute(),
        );
      }
      state.created = {
        id: verification.id,
        issuedAt: verification.createdAt ?? now(),
        expiresAt: verification.expiresAt,
      };
    },

    consuming(row, requestContext) {
      const state = stateOf(requestContext);
      const verification = verificationRowOf(row);
      if (!state || !verification) return;
      // An expired row is being swept, not consumed: Better Auth's cleanup deletes those on any read.
      if (verification.expiresAt.getTime() <= now().getTime()) return;
      state.consuming = { id: verification.id, expiresAt: verification.expiresAt };
    },

    async issued(requestContext, input) {
      const state = stateOf(requestContext);
      const created = state?.created;
      if (!state || !created) return;
      state.created = undefined;
      await swallow(async () => {
        const user = await db
          .selectFrom("pithyAuthUsers")
          .select("id")
          // Better Auth stores and finds emails lowercased; `/sign-in/magic-link` hands the address on as typed.
          .where("email", "=", input.email.toLowerCase())
          .executeTakeFirst();
        await db
          .insertInto("pithyAuthVerificationOutcomes")
          .values({
            verificationId: created.id,
            type: input.type,
            userId: user?.id ?? null,
            emailJobId: input.emailJobId,
            issuedAt: SQLiteDate.encode(created.issuedAt),
            expiresAt: SQLiteDate.encode(created.expiresAt),
            usedAt: null,
          })
          .execute();
      });
    },

    async signedIn(requestContext, userId) {
      const state = stateOf(requestContext);
      const consumed = state?.consuming;
      if (!state || !consumed || typeof userId !== "string" || userId === "") return;
      state.consuming = undefined;
      await swallow(() =>
        db
          .updateTable("pithyAuthVerificationOutcomes")
          .set((eb) => ({
            usedAt: SQLiteDate.encode(now()),
            // A sign-up's row had no account to name at issue; the one its use just created is it.
            userId: eb.fn.coalesce("userId", eb.val(userId)),
          }))
          .where("verificationId", "=", consumed.id)
          .where("usedAt", "is", null)
          .execute(),
      );
    },
  };
}

/** Run a ledger write and drop its failure: the ledger reports on sign-in and is never the reason one fails. */
async function swallow(write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
  } catch {
    // Deliberately empty. See the file header: every caller is mid-sign-in.
  }
}

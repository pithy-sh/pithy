// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * Who holds a purchase and the entitlements it grants — a **subject**, which is not always a person.
 *
 * A consumer app sells to people: one buyer, one holder, and a user id is the whole answer. A business
 * selling to businesses has a different fact to record — the organization signs, the organization is
 * invoiced, and everybody in it holds what it bought. Modeling that on a user-keyed table means either
 * fanning a plan out across members (which drifts the moment somebody joins or leaves) or keying it to
 * the owner (which makes the plan theirs, transferable with ownership, and invisible to the colleague
 * their employer is paying for).
 *
 * So the holder is a **pair**: {@link PaymentsSubjectType} and an id. Both halves travel together
 * everywhere — in a row, in a comparison, in a provider reference — because either half alone is
 * ambiguous. Nothing in the kit keeps an organization id from equalling some user's id, so a comparison
 * that read only the id would let one hold the other's subscription.
 *
 * **Which kind a project uses is decided once, in config** (`PaymentsConfig.billingSubject`), not per
 * call. A codebase that could grant to a user on one route and an organization on the next is one where
 * the two eventually disagree about who is entitled, and the disagreement surfaces as somebody being
 * refused something they paid for.
 *
 * **The capability never learns what an organization is.** It has no members table, no roles, and no
 * business acquiring either — memberships belong to the adopter. Under organization billing the
 * capability asks *which subject is this caller acting for* and the adopter answers from its own
 * session. Unanswered is unentitled, which is the direction every gate in the kit already fails.
 */

/**
 * The kinds of thing that can hold a purchase.
 *
 * **An enum rather than a free string**, because a free string is a column that ends up holding `org`,
 * `organization` and `Organization` in three adopters, and every gate comparing it is then comparing
 * spellings rather than facts.
 *
 * **Spelled with a `z`, deliberately.** The only realistic way an adopter has organizations at all is
 * Better Auth's `organization()` plugin, which `@pithy-sh/auth` composes verbatim: it ships the
 * `organization`, `member` and `invitation` tables and writes `active_organization_id` onto the session.
 * An adopter wiring the subject seam reads `session.activeOrganizationId` and writes the value below on
 * the next line, so the two must match. This is a stored token in a column and a UNIQUE index — it
 * cannot be respelled later — and it is the one place in this repository where the American spelling is
 * correct: it is an identifier inherited from a dependency, not prose.
 */
export const PaymentsSubjectType = z
  .enum(["user", "organization"])
  .describe(
    "What kind of thing holds a purchase — one person, or one organization. Spelled to match Better Auth's `organization()` plugin, whose session column an adopter reads to answer the subject seam.",
  );
export type PaymentsSubjectType = z.infer<typeof PaymentsSubjectType>;

/**
 * The longest a subject id may be.
 *
 * **Derived from the narrowest provider field a reference is written into, not chosen.** A subject
 * crosses to a store as {@link encodeSubjectReference}'s output, and Stripe's `client_reference_id` caps
 * at 200 characters. A provider that silently truncates a longer value would hand back a string that
 * decodes to a *different* id, attributing the purchase to whoever holds it — so the cap is enforced
 * here, at the schema, where it fails on the way out instead of on the way back.
 *
 * 200 less `organization:` (13) leaves 187; 180 is that with room for a longer type member than either
 * of today's, and it is far past any id the kit or Better Auth mints (both are UUIDs).
 */
export const MAX_SUBJECT_ID_LENGTH = 180;

/** How a subject's two halves are joined in a single string. See {@link encodeSubjectReference}. */
const SUBJECT_REFERENCE_SEPARATOR = ":";

/**
 * The id half of a subject — opaque to this package. It is a Pithy user id under `user`, and whatever
 * the adopter's own membership model calls an organization under `organization`.
 */
const SubjectId = z
  .string()
  .min(1)
  .max(MAX_SUBJECT_ID_LENGTH)
  .describe(
    "The subject's own id — a Pithy user id, or the adopter's organization id. Opaque here: payments never resolves it to anything.",
  );

/**
 * A subject: the pair, as every row carries it and every function takes it.
 *
 * **Passed as this object rather than two positional strings**, deliberately. Two adjacent `string`
 * parameters are two parameters a call site can transpose, and transposing them typechecks. The object
 * makes the halves nameable and inseparable, which is what keeps the invariant — a subject is read from
 * and written to one row atomically, and no code path pairs a type from config with an id from a row.
 */
export const PaymentsSubject = z
  .object({
    subjectType: PaymentsSubjectType.describe("Whether `subjectId` names a user or an organization."),
    subjectId: SubjectId,
  })
  .describe("Who holds a purchase and the entitlements it grants — a user or an organization, and its id.");
export type PaymentsSubject = z.infer<typeof PaymentsSubject>;

/**
 * Whether two subjects are the same holder — **both halves, always**.
 *
 * `undefined` is never equal to anything, including another `undefined`. An unresolved owner compared
 * equal to an unresolved owner is how a webhook nobody could attribute would pass an ownership check,
 * and that check is the only thing standing between one customer's renewal and another's account.
 */
export function sameSubject(a: PaymentsSubject | undefined, b: PaymentsSubject | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return a.subjectType === b.subjectType && a.subjectId === b.subjectId;
}

/**
 * A subject as one string, for the single-field slots a store gives us — Apple's `appAccountToken`,
 * Google's `obfuscatedAccountId`, Stripe's `client_reference_id`, Paddle's and Lemon Squeezy's custom
 * data.
 *
 * **One encoding, in one function, with one decoder.** These values leave our control and come back
 * through a webhook, so the format is a wire contract with five providers at once. A second encoding
 * anywhere means a purchase stamped by one code path and read by another resolves to nobody — or, worse,
 * to somebody.
 *
 * The type half leads so the string sorts and greps by kind, and so a value that is *not* this encoding
 * is recognizable at a glance in a provider's dashboard.
 */
export function encodeSubjectReference(subject: PaymentsSubject): string {
  return `${subject.subjectType}${SUBJECT_REFERENCE_SEPARATOR}${subject.subjectId}`;
}

/**
 * The inverse, and **strict**: anything that is not exactly this encoding is `undefined`, never a guess.
 *
 * The input is a value a client put in a purchase and a store handed back, so it may be anything at all.
 * The dangerous shape is a bare id — the format every pre-subject client sent — which a lenient decoder
 * would read as a user, attributing a stranger's purchase to whoever holds that id. So a reference with
 * no separator does not decode, an unknown type half does not decode, and an empty half does not decode.
 * Every caller treats `undefined` as *orphaned*: the event is recorded and replayable, and nothing is
 * granted.
 *
 * Splits on the **first** separator only, so an adopter whose organization ids contain colons round-trips.
 */
export function decodeSubjectReference(reference: string): PaymentsSubject | undefined {
  const at = reference.indexOf(SUBJECT_REFERENCE_SEPARATOR);
  if (at <= 0) return undefined;
  const parsed = PaymentsSubject.safeParse({
    subjectType: reference.slice(0, at),
    subjectId: reference.slice(at + SUBJECT_REFERENCE_SEPARATOR.length),
  });
  return parsed.success ? parsed.data : undefined;
}

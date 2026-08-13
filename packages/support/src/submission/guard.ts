// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { SupportSubmissionConfig } from "../config/config";
import { SUPPORT_MESSAGES_TABLE, type SupportDatabase } from "../data/tables";
import { GUARD_WINDOW_MS } from "../inbound/guard";

/**
 * The in-app submission guard — the bound between "a signed-in user may write in" and "one account is
 * the whole inbox".
 *
 * ## Why this is not the mail guard with a different column
 *
 * `inbound/guard.ts` exists because a public address is a public write endpoint reachable by anybody
 * with an SMTP client, and its bounds are the shape of that problem: a size cap before parsing, a
 * per-address rate for the broken auto-responder, a global rate for the distributed flood where no
 * single address stands out.
 *
 * None of that describes this surface. **A submission is attributable and revocable**: it carries an
 * account the adopter issued, so the flood the mail guard's global bound exists for cannot happen
 * anonymously here — an attacker needs an account per bucket of ten, and every one of them is a row an
 * adopter can disable. What remains is one real failure, and it is the one this file bounds: a single
 * account, hostile or looping, filling the inbox.
 *
 * So there is one check rather than three, and it counts on the **account** rather than the address.
 * Not the same thing: an address is a claim in a header and an account is an identity a session
 * proved, which is the whole distinction this channel exists to exploit.
 *
 * ## Counted from the messages table, and only against its own channel
 *
 * The same reasoning `inbound/guard.ts` states — the rows already exist, a counter row would be a
 * second write that overcounts a failed store and undercounts a flood — over the same sliding hour,
 * and over an index (`submitted_by_user_id`, `received_at`) that the migration creates for this.
 *
 * **`channel = "app"` is on the count deliberately.** Neither surface may starve the other: a customer
 * who emailed twenty times about a billing dispute must still be able to file a bug from inside the
 * app, and somebody filing bug reports must never consume the mail inbox's capacity. Sharing one
 * counter would couple two threat models that have nothing in common.
 */

/** Why a submission was refused. The value lands in the audit event's `metadata.reason`. */
export type SupportSubmissionRejectionReason = "account_rate" | "attachment_too_large" | "attachment_type";

/** The guard's answer: accept, or refuse with a reason. */
export type SubmissionVerdict =
  | { accepted: true }
  | { accepted: false; reason: SupportSubmissionRejectionReason; detail: string };

/**
 * Check how much this account has already filed inside the window.
 *
 * `>=` rather than `>`, matching the mail guard: the bound is how many an account *may land*, so the
 * request that would be the eleventh is refused when ten are already stored.
 */
export async function checkAccountRate(
  db: SupportDatabase,
  config: SupportSubmissionConfig,
  input: { userId: string; now: Date },
): Promise<SubmissionVerdict> {
  const since = new Date(input.now.getTime() - GUARD_WINDOW_MS);

  const filed = await db
    .selectFrom(SUPPORT_MESSAGES_TABLE)
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("channel", "=", "app")
    // What the *account* filed. An answer delivered in the app is an `app` row too, and it carries no
    // `submittedByUserId` — but the bound is on what a person sends, so it says so rather than
    // relying on a null in another column to keep the count honest.
    .where("direction", "=", "inbound")
    .where("submittedByUserId", "=", input.userId)
    .where("receivedAt", ">=", since.getTime())
    .executeTakeFirst();

  if ((filed?.count ?? 0) >= config.maxPerAccountPerHour) {
    return {
      accepted: false,
      reason: "account_rate",
      // The account id, never anything the submitter wrote. `detail` is stripped by the HTTP codec but
      // reaches the log, and this capability's input is text somebody else chose.
      detail: `account ${input.userId} has filed ${filed?.count} submissions in the last hour, at or over the ${config.maxPerAccountPerHour} bound`,
    };
  }
  return { accepted: true };
}

/**
 * Check one attachment against the declared bounds.
 *
 * Size is measured on the **decoded** bytes, which is the number that matters and not the one the
 * request carried: a base64 payload is a third larger than what lands in R2, and bounding the encoded
 * form would silently make the effective limit whatever `maxBytes * 0.75` happens to be.
 *
 * The type check is an **allowlist**, so a type nobody thought about is refused rather than accepted —
 * the opposite default from the mail path, where refusing an unexpected type would lose a customer's
 * bug report. It bounds what lands in the adopter's bucket; it is not what stops a stored-XSS, which
 * is `putAttachment` writing every object as `application/octet-stream` whatever was declared.
 */
export function checkAttachment(
  config: SupportSubmissionConfig,
  input: { contentType: string; bytes: number },
): SubmissionVerdict {
  if (input.bytes > config.attachments.maxBytes) {
    return {
      accepted: false,
      reason: "attachment_too_large",
      detail: `attachment is ${input.bytes} decoded bytes, over the ${config.attachments.maxBytes} byte bound`,
    };
  }
  if (!config.attachments.allowedContentTypes.includes(input.contentType)) {
    return {
      accepted: false,
      reason: "attachment_type",
      // The declared type is echoed because it is one of a closed set the adopter configured, not free
      // text — an operator reading this needs to know which type was refused to decide whether to
      // allow it.
      detail: `attachment declares ${input.contentType}, which is not in the configured allowlist`,
    };
  }
  return { accepted: true };
}

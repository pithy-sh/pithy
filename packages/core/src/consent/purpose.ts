// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { ValidationError } from "../error/pithyError";
import { PrivacyClassName } from "../privacy/classes";

/**
 * Consent purposes: what a person is asked to agree to, declared where the processing is.
 *
 * ## Declared, never discovered
 *
 * A capability that processes under consent says so, the way it states its migrations: `@pithy-sh/email` declares
 * `email.marketing` and `email.tracking`. The adopter adds their own to `consent({ purposes })`. The consent
 * capability composes every declaration into one catalog, and `hasConsent` answers only for a purpose in it.
 *
 * ## A purpose says what it covers and what it demands
 *
 * Beside its notice version, a purpose names the data classes it covers, whether it is **explicit** (GDPR
 * Article 9), the **minimum method** a grant needs, and whether a withdrawal must be made at least at the grade
 * of the grant it withdraws, the way a HIPAA revocation must be in writing.
 *
 * ## The id is the capability's own
 *
 * `<domain>.<name>`, and a capability may declare purposes only under its own `name`, the rule `pithy_<name>_*`
 * tables and `<name>/…` error codes follow, for the same reason: the domain is what keeps two declarations from
 * colliding. `defineCapability` refuses anything else, naming the capability.
 */

/**
 * How a grant was given, weakest first. The order is the grade: a purpose's `minimumMethod` refuses a grant below
 * it, and a purpose with `writtenWithdrawal` refuses a withdrawal below the grant it withdraws.
 */
export const CONSENT_METHODS = ["click", "typed", "drawn", "provider"] as const;

/** How a consent was given or withdrawn. */
export const ConsentMethod = z
  .enum(CONSENT_METHODS)
  .describe(
    "How a consent was given or withdrawn, weakest first: `click` (a checkbox or a button), `typed` (the person typed their name), `drawn` (a drawn signature), or `provider` (an e-signature provider's completed envelope). The order is the grade a purpose's minimum is held against.",
  );
export type ConsentMethod = z.output<typeof ConsentMethod>;

/** A method's grade: its place in {@link CONSENT_METHODS}, so `click` is 0 and `provider` is 3. */
export function methodRank(method: ConsentMethod): number {
  return CONSENT_METHODS.indexOf(method);
}

/** Whether `method` meets `minimum`: at its grade or above. */
export function meetsMethod(method: ConsentMethod, minimum: ConsentMethod): boolean {
  return methodRank(method) >= methodRank(minimum);
}

/** A purpose id: `<domain>.<name>`, lowercase, the domain being the declaring capability's name. */
export const ConsentPurposeId = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]*\.[a-z][a-z0-9_.-]*$/,
    "A consent purpose id is `<domain>.<name>`: lowercase, the domain being the declaring capability's name.",
  )
  .max(128)
  .describe(
    "A consent purpose id, `<domain>.<name>` — `email.marketing`. The domain is the declaring capability's name, or the adopter's own domain for a purpose declared in `consent({ purposes })`.",
  );
export type ConsentPurposeId = z.output<typeof ConsentPurposeId>;

/** One purpose a capability or the adopter processes under consent. */
export const ConsentPurpose = z
  .object({
    id: ConsentPurposeId,
    summary: z
      .string()
      .min(1)
      .max(500)
      .describe(
        "One sentence, written for the person, on what agreeing allows — `Send me news and offers by email.` Shown on the consent settings screen.",
      ),
    noticeVersion: z
      .number()
      .int()
      .positive()
      .describe(
        "The version of the notice a person agrees to. Bump it when the notice changes: every grant under an older version then needs renewing, and `hasConsent` answers no for it until it is.",
      ),
    classes: z
      .array(PrivacyClassName)
      .default([])
      .describe(
        "The data classes this purpose covers — `pii`, `phi`, or an adopter's own. The processing record reads it to name a classed field with no consent behind it.",
      ),
    explicit: z
      .boolean()
      .default(false)
      .describe(
        "Whether this purpose needs explicit consent (GDPR Article 9), as processing health data does. Recorded so an auditor can see which purposes claim it.",
      ),
    minimumMethod: ConsentMethod.default("click").describe(
      "The weakest method a grant may be given by. A grant below it is refused, and `hasConsent` answers no for one recorded below it before the minimum was raised.",
    ),
    writtenWithdrawal: z
      .boolean()
      .default(false)
      .describe(
        "Whether a withdrawal must be made at least at the grade of the grant it withdraws, as a HIPAA revocation must be in writing. Off, a click withdraws any grant: withdrawing is then never harder than granting.",
      ),
  })
  .describe("One purpose processed under consent: what it allows, its notice version, and what a grant demands.");
export type ConsentPurpose = z.output<typeof ConsentPurpose>;
export type ConsentPurposeInput = z.input<typeof ConsentPurpose>;

/** The domain half of a purpose id: `email` for `email.marketing`. */
export function purposeDomain(id: string): string {
  const dot = id.indexOf(".");
  return dot === -1 ? id : id.slice(0, dot);
}

/**
 * Parse one declarer's purposes and refuse what no consent capability could answer for: an id that is not a
 * purpose id, one under a domain that is not the declarer's, or two with one id. `domain` is the declaring
 * capability's name, or `null` for the adopter's own, which may use any domain but a reserved one.
 */
export function parseConsentPurposes(
  declarer: string,
  purposes: readonly ConsentPurposeInput[],
  domain: string | null,
  reserved: ReadonlySet<string> = new Set(),
): ConsentPurpose[] {
  const seen = new Set<string>();
  return purposes.map((input) => {
    const parsed = ConsentPurpose.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError({
        message: `${declarer} declares a consent purpose that is not valid: ${parsed.error.issues[0]?.message ?? "invalid"}.`,
        action: "Give it an id of the form `<domain>.<name>`, a summary, and a positive notice version.",
      });
    }
    const purpose = parsed.data;
    const own = purposeDomain(purpose.id);
    if (domain !== null && own !== domain) {
      throw new ValidationError({
        message: `The ${declarer} capability declares the consent purpose "${purpose.id}" outside its own domain.`,
        action: `Name it under ${domain}. — a capability declares purposes only under its own name.`,
      });
    }
    if (domain === null && reserved.has(own)) {
      throw new ValidationError({
        message: `The consent purpose "${purpose.id}" is under ${own}., which a composed capability owns.`,
        action: "Name your own purposes under your own domain, such as your app's name.",
      });
    }
    if (seen.has(purpose.id)) {
      throw new ValidationError({
        message: `${declarer} declares the consent purpose "${purpose.id}" twice.`,
        action: "Declare each purpose once.",
      });
    }
    seen.add(purpose.id);
    return purpose;
  });
}

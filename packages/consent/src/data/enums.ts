// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * The consent record's closed vocabularies, apart from the table: the request schemas a browser program reads import
 * these and nothing that reaches a database.
 */

/** Whose consent a row records: an account, or a visitor known only by an anonymous device id. */
export const ConsentSubjectKind = z
  .enum(["account", "visitor"])
  .describe(
    "Whose consent this is. `account` is a user id from `@pithy-sh/auth`. `visitor` is an anonymous device id, held in a first-party cookie set only once the visitor has chosen.",
  );
export type ConsentSubjectKind = z.output<typeof ConsentSubjectKind>;

/** Whether a row gives consent or takes it back. */
export const ConsentAction = z
  .enum(["grant", "withdraw"])
  .describe("Whether this row gives consent to the purpose or withdraws it.");
export type ConsentAction = z.output<typeof ConsentAction>;

/** How the signer's identity was verified, as the adopter's flow declares it. */
export const ConsentIdentity = z
  .enum(["none", "session", "verified_email", "in_person", "provider"])
  .describe(
    "How the person's identity was verified when they gave or withdrew consent, as the adopter's flow declares it: `none` (an anonymous visitor), `session` (a signed-in session), `verified_email` (an address they proved they hold), `in_person` (checked face to face), or `provider` (the e-signature provider's own check).",
  );
export type ConsentIdentity = z.output<typeof ConsentIdentity>;

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * What `organization({ … })` takes.
 *
 * **The role catalog is deliberately not here.** It is a module in the adopter's project —
 * `src/organization/roles.ts`, scaffolded by `pithy add organization` — because their own route code
 * imports the typed powers, and importing from `pithy.config.ts` into a handler is backwards. The
 * factory takes the catalog as a value; this schema is everything else.
 */
export const OrganizationConfig = z
  .object({
    basePath: z
      .string()
      .startsWith("/")
      .default("/organizations")
      .describe(
        "Where the tenancy routes mount, the invitation accept link included. Change it and the links in already-sent invitations break, so pick it before you invite anybody.",
      ),
    baseUrl: z
      .url()
      .optional()
      .describe(
        "The absolute origin an invitation link is built from, e.g. `https://app.example.com`. Required before an invitation can be sent, because an email cannot carry a relative URL.",
      ),
    invitationTtlDays: z
      .number()
      .int()
      .positive()
      .max(90)
      .default(14)
      .describe(
        "How long an invitation stays redeemable. Days rather than hours, deliberately: somebody invited on a Friday should not find a dead link on Monday. Short enough that a forwarded link does not stay live for a quarter.",
      ),
    nominationTtlDays: z
      .number()
      .int()
      .positive()
      .max(90)
      .default(7)
      .describe(
        "How long an offer of ownership stands. Shorter than an invitation, because it is an offer to take responsibility for an account rather than to join one, and an open-ended one is accepted a year later by somebody who has forgotten it was made.",
      ),
    allowSelfService: z
      .boolean()
      .default(true)
      .describe(
        "Whether a signed-in person may create an organization of their own. True for a product anybody can sign up to; false where every tenant is provisioned by the operator, and then the create route refuses for everyone rather than checking a power nobody holds.",
      ),
    sendInvitationEmail: z
      .boolean()
      .default(true)
      .describe(
        "Whether an invitation is mailed through the composed `@pithy-sh/email`. False hands the link back to the caller instead, for a product that delivers it its own way — the token is minted and digested identically either way.",
      ),
  })
  .describe(
    "The tenancy capability's configuration. The role catalog is not here: it is a module in the project, because the project's own handlers import its powers.",
  );
export type OrganizationConfig = z.output<typeof OrganizationConfig>;
export type OrganizationConfigInput = z.input<typeof OrganizationConfig>;

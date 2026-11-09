// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";
import { MAX_ORGANIZATION_NAME_LENGTH, Organization } from "./organization";

/**
 * The key a client sends with a founding so a retry finds the organization it already founded. The client chooses
 * it, once per organization it means to found.
 */
export const FoundingIdempotencyKey = z.string().min(1).max(200);

/**
 * The `pithy_organization_foundings` table: one row per organization founded with an idempotency key.
 *
 * **Keyed on `(founderUserId, idempotencyKey)`**, so a key belongs to the person who sent it and two people
 * choosing the same key found two organizations. The primary key is what decides a race: of two foundings
 * carrying one key, one batch commits this row and the other's batch fails on it.
 *
 * **It keeps what the request asked for, not what was committed.** `slug` is null when the founding derived its
 * short name, so a repeat of the same request matches it whatever suffix the derived slug took, and the committed
 * slug is read from the organization's own row. A repeat that asks for a different name or slug is a different
 * request reusing the key, and is refused.
 *
 * The row is deleted with its organization, in `deleteOrganization`'s batch, so a key whose organization was
 * erased founds a new one. A soft deletion leaves it, so the key stays spent until the purge. A person's purge
 * deletes every row they founded, and their export returns them.
 */
export const OrganizationFounding = z
  .object({
    founderUserId: z
      .string()
      .min(1)
      .describe("Who founded the organization, from `pithy_auth_users`. The first half of the primary key."),
    idempotencyKey: FoundingIdempotencyKey.describe(
      "The key the founder sent. The second half of the primary key, so a key is unique per founder.",
    ),
    organizationId: z
      .uuid()
      .describe("The organization this key founded. References `pithy_organization_organizations(id)`."),
    name: z
      .string()
      .min(1)
      .max(MAX_ORGANIZATION_NAME_LENGTH)
      .describe("The display name the founding request asked for, compared against a repeat's."),
    slug: Organization.shape.slug
      .nullable()
      .describe(
        "The short name the founding request asked for, or null when it asked for none and the slug was derived. Compared against a repeat's.",
      ),
    createdAt: SQLiteDate.describe("When the organization was founded. Ms-epoch in SQLite; a `Date` in app code."),
  })
  .describe(
    "One founding made with an idempotency key, in `pithy_organization_foundings`: which organization the key founded, and what the request asked for.",
  );
export type OrganizationFounding = z.output<typeof OrganizationFounding>;
export type OrganizationFoundingRow = z.input<typeof OrganizationFounding>;

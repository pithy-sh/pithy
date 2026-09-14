// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { StoredImage } from "@pithy-sh/core/src/image/storedImage";
import { z } from "zod";

/**
 * The `pithy_organization_organizations` table — one row per tenant.
 *
 * An organization is who signs in, who pays, and who owns whatever this product's tenanted things are.
 * **It is never a container for the tenant's own subject matter**: the academy's coaching sessions and
 * the dashboard's customer connections are owned *by* an organization and live in the adopter's own
 * tables. The only thing tenancy-shaped about them is the id in their `organizationId` column.
 */

/**
 * A slug is lowercase alphanumerics joined by single hyphens. Enforced at the column rather than only
 * at a form, because it is a URL segment before it is a display value, and the schema is the one
 * definition both the write path and the read path share.
 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Bounded because a slug becomes a path segment, an audit field, and a cache key. */
export const MAX_SLUG_LENGTH = 64;

/** Bounded because a name is rendered in every chooser, every log line and every invitation email. */
export const MAX_ORGANIZATION_NAME_LENGTH = 128;

export const Organization = z
  .object({
    id: z
      .uuid()
      .describe(
        "Primary key. A random UUID text id, not an autoincrement, so organizations cannot be enumerated from a URL or inferred from each other's ids.",
      ),
    name: z
      .string()
      .min(1)
      .max(MAX_ORGANIZATION_NAME_LENGTH)
      .describe(
        "The organization's display name, as it appears on screen. Free text; the slug, not this, is what addresses it.",
      ),
    slug: z
      .string()
      .min(1)
      .max(MAX_SLUG_LENGTH)
      .regex(SLUG_PATTERN)
      .describe(
        "URL-safe short name, unique across all organizations. Lowercase alphanumerics and single hyphens. Treated as stable: every link, bookmark and audit entry addresses the organization by it, so changing one is a deliberate rename rather than an edit.",
      ),
    logo: StoredImage.nullable().describe(
      "The organization's mark, or null when nobody has set one — and then a caller draws initials, which is a real answer and not a placeholder. Bytes under the kit's one image rule (`@pithy-sh/core/src/image/storedImage`), never a link to somebody else's host: a remote URL would mean fetching an attacker-chosen host from a page listing somebody's tenancies. Nullable rather than an empty string, because a column that could hold both would have two spellings of *no logo*.",
    ),
    createdAt: SQLiteDate.describe(
      "When the organization was created. Ms-epoch in SQLite; a `Date` in app code. Indexed for listing.",
    ),
    updatedAt: SQLiteDate.describe(
      "When the organization was last changed. Ms-epoch in SQLite; a `Date` in app code. Also the version a served mark's URL carries, so a changed logo is a different URL.",
    ),
  })
  .describe(
    "One tenant, in `pithy_organization_organizations` — the account that holds memberships and carries whatever this product bills for.",
  );
export type Organization = z.output<typeof Organization>;
export type OrganizationRow = z.input<typeof Organization>;

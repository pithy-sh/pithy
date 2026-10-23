// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { KitErrorCode } from "@pithy-sh/core/src/error/payload";

/**
 * The code a suspended organization's refusal comes back with, for a screen to branch on (#623).
 *
 * **Imported rather than spelled**, for the reason `@pithy-sh/auth`'s `ACCOUNT_SUSPENDED` is: a literal in a copied
 * screen and a literal in the Worker are a pair that can drift, and the drift shows as a member of a suspended
 * organization landing on a screen that says nothing. The type ties it to the kit's taxonomy, so a rename there is
 * a compile error here — and the import is a type's, erased before a bundler sees it, so this module still
 * imports nothing at run time.
 */
export const ORGANIZATION_SUSPENDED = "organization/organization_suspended" satisfies KitErrorCode;

/** Whether a refusal's code says the organization is suspended, or `null` for anything else. */
export function organizationRefusal(code: string | null | undefined): "suspended" | null {
  return code === ORGANIZATION_SUSPENDED ? "suspended" : null;
}

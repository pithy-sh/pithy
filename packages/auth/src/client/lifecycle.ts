// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { KitErrorCode } from "@pithy-sh/core/src/error/payload";

/**
 * The two codes a refused account comes back with, for a screen to branch on (#620).
 *
 * **Imported rather than spelled**, for the reason the sign-in screen imports `NEUTRAL_PROVIDER_REFUSAL`: a
 * literal in a copied screen and a literal in the Worker are a pair that can drift, and the drift shows as a
 * locked-out person landing on a sign-in form that says nothing. The type ties each to the kit's taxonomy, so
 * a rename there is a compile error here.
 *
 * Either arrives as a `PithyError` body's `code` from a JSON call, or as `?error=` on the screen a magic link
 * or a social sign-in returned to.
 */
export const ACCOUNT_SUSPENDED = "auth/account_suspended" satisfies KitErrorCode;

/** The code for an account inside its purge window. See {@link ACCOUNT_SUSPENDED}. */
export const ACCOUNT_DELETED = "auth/account_deleted" satisfies KitErrorCode;

/** Which of the two a code is, or `null` for anything else — a refusal a screen should not reroute. */
export function accountRefusal(code: string | null | undefined): "suspended" | "deleted" | null {
  if (code === ACCOUNT_SUSPENDED) return "suspended";
  if (code === ACCOUNT_DELETED) return "deleted";
  return null;
}

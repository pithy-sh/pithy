// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Whether a Worker's `pithy.config.ts` **registers** a capability — the call, not the import.
 *
 * The call is what composes, so the call is what is asked about. A config that imports `email` and never
 * writes `email()` composes nothing, and `createBackend` agrees. Anchored to the start of a line and to
 * the whole name, so `myauth(` is not `auth(` — the same rule `pithy add`'s idempotency check uses, and
 * it reads the source rather than importing it: the config this is asked about is frequently one that
 * cannot boot.
 */
export function isRegistered(source: string, name: string): boolean {
  return new RegExp(`^[ \\t]*${escapeRegExp(name)}[ \\t]*\\(`, "m").test(source);
}

/** Escape a capability name for use inside a `RegExp` (names are bare identifiers, but be safe). */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

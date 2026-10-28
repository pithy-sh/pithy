// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

function entries(values: readonly unknown[]): string[] {
  return values
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * A client's stored redirect URIs, as a list. The adapter stores them as a JSON array or comma-joined, and the
 * connected-applications screen shows them as the one value that identifies the client, so a value that is JSON
 * but not an array or a string names no URI rather than showing a fragment of itself as one.
 */
export function redirectList(stored: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return entries(stored.split(","));
  }
  if (Array.isArray(parsed)) return entries(parsed);
  if (typeof parsed === "string") return entries([parsed]);
  return [];
}

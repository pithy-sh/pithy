// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/** One seeded identity, as the picker needs it: who it is, and the value that signs in as them. */
export interface PickerIdentity {
  userId: string;
  email: string;
}

export interface PickerRow {
  /**
   * The identity's id — carried so a row can be keyed by it.
   *
   * `pithy seed` keys its record by `userId`, and two identities can share an email: the same person
   * seeded twice, or a set with a repeated address. Keying a rendered row on the email gave React
   * duplicate keys in one list.
   */
  userId: string;
  email: string;
  marked: boolean;
}

export interface PickerView {
  rows: PickerRow[];
  /** `8-17 of 29`. Empty when the whole list fits, where there is nothing to say. */
  position: string;
}

/**
 * Every identity whose email or id contains `query`, case-insensitively.
 *
 * Substring rather than prefix because the useful thing to type is rarely the start: a seed spread across
 * five domains is searched by domain (`tidewater`) far more often than by first initial.
 *
 * Exported because the store resolves the *choice* against the same list the view draws — if the two
 * disagreed about what matches, Enter would sign you in as whoever occupied that row in the other list.
 */
export function filterIdentities(identities: readonly PickerIdentity[], query: string): readonly PickerIdentity[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return identities;
  return identities.filter(
    (identity) => identity.email.toLowerCase().includes(needle) || identity.userId.toLowerCase().includes(needle),
  );
}

/**
 * The slice of identities to show, and where it sits.
 *
 * **The marked row is always visible** — that is the one property the windowing exists for, and the one
 * a test can assert across the whole range rather than at a couple of points. The window is centered on
 * the selection and then clamped to both ends, so moving through a long list scrolls rather than jumping,
 * and the first and last pages stay full.
 */
export function pickerView(
  identities: readonly PickerIdentity[],
  selected: number,
  max: number,
  query = "",
): PickerView {
  const matches = filterIdentities(identities, query);
  if (matches.length === 0) {
    // A query that matches nothing says so, rather than showing an empty box and leaving you to wonder
    // whether the list failed to load.
    return { rows: [], position: query.trim() === "" ? "" : `no match of ${identities.length}` };
  }
  if (max <= 0) return { rows: [], position: "" };

  // A selection past either end is clamped rather than refused: it comes from a keypress, and the honest
  // answer to "down" at the bottom is to stay there.
  const marked = Math.max(0, Math.min(selected, matches.length - 1));
  const size = Math.min(max, matches.length);
  // Centered, then pulled back inside the list — which is what keeps the last page full instead of
  // trailing off with blank rows.
  const start = Math.max(0, Math.min(marked - Math.floor(size / 2), matches.length - size));

  const rows = matches.slice(start, start + size).map((identity, offset) => ({
    userId: identity.userId,
    email: identity.email,
    marked: start + offset === marked,
  }));

  const total = query.trim() === "" ? `${matches.length}` : `${matches.length} of ${identities.length}`;
  return {
    rows,
    position:
      matches.length <= size ? (query.trim() === "" ? "" : `${total}`) : `${start + 1}-${start + size} of ${total}`,
  };
}

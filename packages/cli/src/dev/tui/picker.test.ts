// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { filterIdentities, type PickerIdentity, pickerView } from "./picker";

/**
 * **Choosing who to sign in as, when a seed mints 29 of them.**
 *
 * `l` used to print the whole list into the stream as prose — fine for three identities, a wall of output
 * for twenty-nine, and impossible past nine, where it fell back to a prompt the live roster cannot hand
 * the keyboard to. A windowed, filterable list answers all three.
 *
 * Two properties carry the weight: **the marked row is always visible**, and **the view and the choice
 * agree about what matches** — if they disagreed, Enter would sign you in as whoever occupied that row in
 * the other list.
 */
const people = (count: number): PickerIdentity[] =>
  Array.from({ length: count }, (_, i) => ({ userId: `dev-${i + 1}`, email: `user${i + 1}@example.com` }));

const mixed: PickerIdentity[] = [
  { userId: "dev-jim", email: "jim@pithy.sh" },
  { userId: "dev-zadie", email: "zadie.mwangi@wexford.test" },
  { userId: "dev-aisha", email: "aisha.nkemelu@larkspur.test" },
  { userId: "dev-bo", email: "bo.fenwick@larkspur.test" },
  { userId: "dev-jonas", email: "jonas.villumsen@tidewater.test" },
];

describe("filterIdentities", () => {
  test("an empty query matches everything", () => {
    expect(filterIdentities(mixed, "")).toHaveLength(5);
    expect(filterIdentities(mixed, "   ")).toHaveLength(5);
  });

  test("it matches anywhere in the email, not just the start", () => {
    // What you reach for on a seed spread across five domains is the domain, which is never the prefix.
    expect(filterIdentities(mixed, "larkspur").map((i) => i.userId)).toEqual(["dev-aisha", "dev-bo"]);
  });

  test("it ignores case, because nobody types a domain twice to get it right", () => {
    expect(filterIdentities(mixed, "LARKSPUR")).toHaveLength(2);
    expect(filterIdentities(mixed, "Jim")).toHaveLength(1);
  });

  test("it matches the userId too, since that is what dev.json takes", () => {
    expect(filterIdentities(mixed, "dev-jonas").map((i) => i.email)).toEqual(["jonas.villumsen@tidewater.test"]);
  });

  test("a query matching nothing matches nothing, rather than falling back to everything", () => {
    expect(filterIdentities(mixed, "nobody")).toEqual([]);
  });
});

describe("pickerView", () => {
  test("a list shorter than the window shows all of it, and says nothing about position", () => {
    const view = pickerView(people(3), 0, 10);
    expect(view.rows.map((r) => r.email)).toEqual(["user1@example.com", "user2@example.com", "user3@example.com"]);
    expect(view.position).toBe("");
  });

  test("exactly one row is marked, and it is the selected one", () => {
    const view = pickerView(people(29), 4, 10);
    expect(view.rows.filter((r) => r.marked)).toHaveLength(1);
    expect(view.rows.find((r) => r.marked)?.email).toBe("user5@example.com");
  });

  test("a longer list is windowed, and says where the window sits", () => {
    const view = pickerView(people(29), 0, 10);
    expect(view.rows).toHaveLength(10);
    expect(view.position).toBe("1-10 of 29");
  });

  test("the window follows the marker, and stops at both ends", () => {
    expect(pickerView(people(29), 12, 10).position).toBe("8-17 of 29");
    const end = pickerView(people(29), 28, 10);
    expect(end.rows).toHaveLength(10);
    expect(end.rows.at(-1)?.email).toBe("user29@example.com");
    expect(pickerView(people(29), 1, 10).rows[0]?.email).toBe("user1@example.com");
  });

  test("the marked row is visible wherever the selection is", () => {
    for (let selected = 0; selected < 29; selected++) {
      const view = pickerView(people(29), selected, 10);
      expect(view.rows.some((r) => r.marked && r.email === `user${selected + 1}@example.com`)).toBe(true);
    }
  });

  test("a query narrows the rows and says how many of how many", () => {
    const view = pickerView(mixed, 0, 10, "larkspur");
    expect(view.rows.map((r) => r.email)).toEqual(["aisha.nkemelu@larkspur.test", "bo.fenwick@larkspur.test"]);
    expect(view.position).toBe("2 of 5");
  });

  test("a query that matches nothing says so, rather than showing an empty box", () => {
    const view = pickerView(mixed, 0, 10, "nobody");
    expect(view.rows).toEqual([]);
    expect(view.position).toBe("no match of 5");
  });

  test("the selection is relative to the matches, not to the whole list", () => {
    const view = pickerView(mixed, 1, 10, "larkspur");
    expect(view.rows.find((r) => r.marked)?.email).toBe("bo.fenwick@larkspur.test");
  });

  test("a narrowed list still windows, and counts against the whole", () => {
    const view = pickerView(people(29), 0, 3, "user1");
    // user1, user10..user19 — eleven matches, three shown.
    expect(view.rows).toHaveLength(3);
    expect(view.position).toBe("1-3 of 11 of 29");
  });

  test("an empty list is an empty view rather than a crash", () => {
    expect(pickerView([], 0, 10)).toEqual({ rows: [], position: "" });
  });

  test("a selection past the end is clamped onto a real row", () => {
    expect(pickerView(people(3), 99, 10).rows.find((r) => r.marked)?.email).toBe("user3@example.com");
  });
});

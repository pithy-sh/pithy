// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { render } from "ink-testing-library";
import { describe, expect, test } from "vitest";
import { stripAnsi } from "../logging";
import { IdentityPicker } from "./identityPicker";
import type { PickerIdentity } from "./picker";

/** The windowing itself is `picker.test.ts`; this is what reaches a frame. */
const people = (count: number): PickerIdentity[] =>
  Array.from({ length: count }, (_, i) => ({ userId: `dev-${i + 1}`, email: `user${i + 1}@example.com` }));

const frame = (identities: PickerIdentity[], selected: number, query = "") =>
  stripAnsi(
    render(<IdentityPicker identities={identities} selected={selected} query={query} columns={80} />).lastFrame() ?? "",
  );

describe("IdentityPicker", () => {
  test("it asks the question and lists the emails", () => {
    const out = frame(people(3), 0);
    expect(out).toContain("Sign in as");
    expect(out).toContain("user1@example.com");
    expect(out).toContain("user3@example.com");
  });

  test("it shows ten rows out of twenty-nine, and says so", () => {
    const out = frame(people(29), 0);
    expect(out.split("\n").filter((l) => l.includes("@example.com"))).toHaveLength(10);
    expect(out).toContain("1-10 of 29");
  });

  test("the marked row carries the marker, and only it", () => {
    const out = frame(people(29), 3);
    const marked = out.split("\n").filter((l) => l.trimStart().startsWith("▸"));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain("user4@example.com");
  });

  test("no row is numbered — the numbers only existed for the jump", () => {
    const out = frame(people(3), 0);
    expect(out).toMatch(/▸ user1@example\.com/);
  });

  test("a short list says nothing about position", () => {
    expect(frame(people(4), 0)).not.toContain(" of 4");
  });

  test("the keys it offers are the keys it takes", () => {
    const out = frame(people(3), 0);
    for (const hint of ["↑↓ select", "⏎ sign in", "esc cancel"]) expect(out).toContain(hint);
  });

  test("it never offers `1–9 jump`, which pointed at rows that were not on screen", () => {
    // The numbers were places in the whole list, so while the window showed 8-17 the hint named rows
    // nowhere in view. Typing replaced it, and a digit is filter text now.
    expect(frame(people(29), 20)).not.toContain("jump");
  });

  test("it invites typing, and echoes what was typed", () => {
    expect(frame(people(29), 0)).toContain("type to filter");
    const filtered = frame(people(29), 0, "user1");
    expect(filtered).toContain("user1");
    expect(filtered).not.toContain("type to filter");
  });

  test("a query narrows the rows and counts them against the whole", () => {
    // `user25` matches one of twenty-nine; `user2` would match eleven and still fill the window, which
    // is why the narrow query is the one that demonstrates anything.
    const out = frame(people(29), 0, "user25");
    expect(out).toContain("of 29");
    expect(out.split("\n").filter((l) => l.includes("@example.com"))).toHaveLength(1);
  });

  test("a query matching nobody says so", () => {
    expect(frame(people(29), 0, "nobody")).toContain("no match of 29");
  });

  test("esc is offered as clear once something is typed", () => {
    expect(frame(people(3), 0, "x")).toContain("esc clear");
  });

  test("no claim is rendered — the picker names people, never credentials", () => {
    // `#667`'s rule, and the reason the roster shows an email and nothing else: a session claim in a
    // frame is a session claim in a scrollback and a screenshot.
    const out = frame(people(3), 0);
    expect(out).not.toMatch(/claim|token|eyJ/i);
  });
});

describe("IdentityPicker — rows are keyed by id", () => {
  test("two identities sharing an email both render", () => {
    // `pithy seed` keys its record by `userId`, and an email can repeat — the same person seeded twice,
    // or a set with a repeated address. Keying the row on the email gave React duplicate keys.
    const twins: PickerIdentity[] = [
      { userId: "dev-one", email: "same@example.com" },
      { userId: "dev-two", email: "same@example.com" },
    ];
    const out = stripAnsi(
      render(<IdentityPicker identities={twins} selected={1} query="" columns={80} />).lastFrame() ?? "",
    );
    expect(out.split("\n").filter((l) => l.includes("same@example.com"))).toHaveLength(2);
  });
});

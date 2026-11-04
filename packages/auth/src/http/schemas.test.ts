// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { inputOf } from "@pithy-sh/core/src/controlPlane/discovery/routeInput";
import { validate } from "@pithy-sh/core/src/http/validation";
import { describe, expect, test } from "vitest";
import { MAX_REASON } from "../lifecycle/reason";
import {
  DeleteAccountBody,
  DeleteUserBody,
  ExportUserBody,
  ListUsersQuery,
  ReinstateUserBody,
  RestoreUserBody,
  SearchUsersBody,
  SuspendUserBody,
} from "./schemas";

/**
 * The lifecycle request bodies. The routes read only what these hand back, so a reason the transition
 * would refuse, or an end that is not a timestamp, is a 400 here and never a conflict later.
 */
describe("SuspendUserBody", () => {
  test("takes a reason alone, and leaves the end and notify absent", () => {
    expect(SuspendUserBody.parse({ reason: "Chargeback under review." })).toEqual({
      reason: "Chargeback under review.",
    });
  });

  test("trims the reason, and refuses one that is only whitespace or missing", () => {
    expect(SuspendUserBody.parse({ reason: "  Review.  " }).reason).toBe("Review.");
    expect(SuspendUserBody.safeParse({ reason: "   " }).success).toBe(false);
    expect(SuspendUserBody.safeParse({}).success).toBe(false);
    expect(SuspendUserBody.safeParse({ reason: null }).success).toBe(false);
  });

  test("bounds the reason by the constant the transition enforces", () => {
    expect(SuspendUserBody.safeParse({ reason: "x".repeat(MAX_REASON) }).success).toBe(true);
    expect(SuspendUserBody.safeParse({ reason: "x".repeat(MAX_REASON + 1) }).success).toBe(false);
  });

  test("reads the end as a date, and refuses one that is not a timestamp", () => {
    const parsed = SuspendUserBody.parse({ reason: "x", until: "2026-11-01T00:00:00.000Z" });
    expect(parsed.until?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(SuspendUserBody.safeParse({ reason: "x", until: "next tuesday" }).success).toBe(false);
  });

  test("notify is a boolean, never a string that looks like one", () => {
    expect(SuspendUserBody.parse({ reason: "x", notify: false }).notify).toBe(false);
    expect(SuspendUserBody.safeParse({ reason: "x", notify: "false" }).success).toBe(false);
  });
});

describe("ReinstateUserBody", () => {
  test("takes a reason and an optional notify, and refuses no reason", () => {
    expect(ReinstateUserBody.parse({ reason: " Cleared. ", notify: false })).toEqual({
      reason: "Cleared.",
      notify: false,
    });
    expect(ReinstateUserBody.safeParse({ notify: true }).success).toBe(false);
  });

  test("has no end to take: a reinstatement is now", () => {
    expect(Object.keys(ReinstateUserBody.shape)).toEqual(["reason", "notify"]);
  });
});

describe("DeleteUserBody", () => {
  test("no mode is soft: the window is the default, and nothing defaults to an erasure", () => {
    expect(DeleteUserBody.parse({ reason: "Asked by email." })).toEqual({ mode: "soft", reason: "Asked by email." });
  });

  test("hard is reached only by naming it exactly", () => {
    expect(DeleteUserBody.parse({ reason: "x", mode: "hard" }).mode).toBe("hard");
    // A typo is a 400, never the default and never the other mode. Each of these would otherwise be a guess
    // about which of two very different things the operator meant.
    for (const mode of ["Hard", "HARD", "hrad", "hard ", "purge", "immediate", true, 1, null, ""]) {
      expect(DeleteUserBody.safeParse({ reason: "x", mode }).success, String(mode)).toBe(false);
    }
  });

  test("a reason is required, trimmed and bounded, as the other lifecycle bodies require one", () => {
    expect(DeleteUserBody.safeParse({ mode: "soft" }).success).toBe(false);
    expect(DeleteUserBody.safeParse({ reason: "   " }).success).toBe(false);
    expect(DeleteUserBody.safeParse({ reason: "x".repeat(MAX_REASON + 1) }).success).toBe(false);
    expect(DeleteUserBody.parse({ reason: " Closed. " }).reason).toBe("Closed.");
  });

  test("notify is an optional boolean", () => {
    expect(DeleteUserBody.parse({ reason: "x", notify: false }).notify).toBe(false);
    expect(DeleteUserBody.safeParse({ reason: "x", notify: "no" }).success).toBe(false);
  });
});

describe("RestoreUserBody", () => {
  test("takes a reason and nothing else, and refuses none", () => {
    expect(RestoreUserBody.parse({ reason: " Changed their mind. " })).toEqual({ reason: "Changed their mind." });
    expect(RestoreUserBody.safeParse({}).success).toBe(false);
  });
});

describe("ExportUserBody", () => {
  test("a disclosure says why, like every other lifecycle call, and nothing else", () => {
    expect(ExportUserBody.parse({ reason: "Access request 4411." })).toEqual({ reason: "Access request 4411." });
    expect(ExportUserBody.safeParse({}).success).toBe(false);
    expect(ExportUserBody.safeParse({ reason: "" }).success).toBe(false);
    expect(ExportUserBody.safeParse({ reason: "Access request 4411.", userId: "other" }).success).toBe(false);
  });
});

describe("DeleteAccountBody", () => {
  test("requires the confirmation, and only the literal true", () => {
    expect(DeleteAccountBody.parse({ confirm: true })).toEqual({ confirm: true });
    for (const confirm of [undefined, false, "true", 1, "yes", null]) {
      expect(DeleteAccountBody.safeParse({ confirm }).success, String(confirm)).toBe(false);
    }
  });

  test("names no account: whatever else the body says, the subject is the session's own", () => {
    expect(DeleteAccountBody.parse({ confirm: true, userId: "somebody-else" })).toEqual({ confirm: true });
  });
});

describe("ListUsersQuery", () => {
  test("decodes the filters: verified to a boolean, the window to dates", () => {
    expect(
      ListUsersQuery.parse({
        state: "suspended",
        verified: "false",
        since: "2026-06-01T00:00:00Z",
        until: "2026-06-02T00:00:00Z",
      }),
    ).toEqual({
      state: "suspended",
      verified: false,
      since: new Date("2026-06-01T00:00:00Z"),
      until: new Date("2026-06-02T00:00:00Z"),
    });
  });

  test("refuses an unknown state, a verified that is not a boolean, and a window that ends before it starts", () => {
    expect(ListUsersQuery.safeParse({ state: "banned" }).success).toBe(false);
    expect(ListUsersQuery.safeParse({ verified: "1" }).success).toBe(false);
    expect(ListUsersQuery.safeParse({ since: "2026-06-02T00:00:00Z", until: "2026-06-01T00:00:00Z" }).success).toBe(
      false,
    );
  });

  test("refuses a search term rather than listing everyone as though they were the match", () => {
    const refused = ListUsersQuery.safeParse({ search: "ada@example.com" });
    expect(refused.success).toBe(false);
  });

  test("every filter reaches the manifest's route input, so a client can discover it", () => {
    const query = inputOf([validate("query", ListUsersQuery)]).properties as { query: { properties: object } };
    expect(Object.keys(query.query.properties)).toEqual(
      expect.arrayContaining(["state", "verified", "since", "until", "cursor", "limit"]),
    );
    expect(Object.keys(query.query.properties)).not.toContain("search");
  });
});

describe("SearchUsersBody", () => {
  test("takes the term, the listing's filters and its cursor, with JSON types", () => {
    expect(
      SearchUsersBody.parse({
        search: " ada@example.com ",
        state: "active",
        verified: true,
        since: "2026-06-01T00:00:00Z",
        cursor: "abc",
        limit: 5,
      }),
    ).toEqual({
      search: "ada@example.com",
      state: "active",
      verified: true,
      since: new Date("2026-06-01T00:00:00Z"),
      cursor: "abc",
      limit: 5,
    });
  });

  test("takes the previous page's `nextCursor` as it came, `null` included, as a first page", () => {
    expect(SearchUsersBody.parse({ search: "ada", cursor: null })).toEqual({ search: "ada" });
  });

  test("refuses no term, an empty one, an unknown key, string flags and a backwards window", () => {
    for (const body of [
      {},
      { search: " " },
      { search: "ada", q: "ada" },
      { search: "ada", verified: "true" },
      { search: "ada", limit: "5" },
      { search: "ada", since: "2026-06-02T00:00:00Z", until: "2026-06-01T00:00:00Z" },
    ]) {
      expect(SearchUsersBody.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});

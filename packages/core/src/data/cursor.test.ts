// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_SIZE, decodeCursor, encodeCursor, MAX_PAGE_SIZE, pageLimit, toPage } from "./cursor";

describe("pageLimit", () => {
  it("defaults when a caller names none", () => {
    expect(pageLimit(undefined)).toBe(DEFAULT_PAGE_SIZE);
  });

  it("clamps rather than rejects, at both ends", () => {
    // A client asking for 1000 wants "as many as you'll give me"; failing the request teaches it nothing
    // a capped page does not. A 0 must yield a row, not an empty page that reads as the end of the list.
    expect(pageLimit(1000)).toBe(MAX_PAGE_SIZE);
    expect(pageLimit(0)).toBe(1);
    expect(pageLimit(-5)).toBe(1);
    expect(pageLimit(10)).toBe(10);
  });
});

describe("cursor encoding", () => {
  it("round-trips a numeric position", () => {
    const cursor = { sort: 1_700_000_000_000, id: 42 };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("round-trips a string position — an ISO-8601 date column sorts as text", () => {
    // Better Auth's tables store dates as ISO-8601 text where Pithy's own use ms-epoch numbers. A cursor
    // carrying the wrong one compares the wrong way and mis-sorts silently rather than throwing.
    const cursor = { sort: "2026-02-01T09:30:00.000Z", id: "usr_01HQ" };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("is base64url — safe in a query string with no further escaping", () => {
    const encoded = encodeCursor({ sort: 1, id: "a/b+c=" });
    expect(encoded).not.toMatch(/[+/=]/);
    expect(decodeCursor(encoded)).toEqual({ sort: 1, id: "a/b+c=" });
  });

  it("round-trips a non-Latin-1 id instead of throwing", () => {
    // `btoa` rejects any code unit above U+00FF, and a cursor's `id` can be a caller-minted string — a
    // device id, an external reference. Without the UTF-8 step a single such character turns a page
    // boundary into a 500.
    const cursor = { sort: 1, id: "dispositivo-café-日本" };
    expect(() => encodeCursor(cursor)).not.toThrow();
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("treats anything malformed as a first page rather than an error", () => {
    // A cursor that travelled through a URL, got truncated, or outlived a deploy must not turn an
    // ordinary client bug into a page that never loads — and must not let a prober tell a parse failure
    // from a not-found.
    expect(decodeCursor(undefined)).toBeUndefined();
    expect(decodeCursor("")).toBeUndefined();
    expect(decodeCursor("!!!not base64!!!")).toBeUndefined();
    expect(decodeCursor(btoa("not json"))).toBeUndefined();
    expect(decodeCursor(btoa(JSON.stringify({ sort: 1 })))).toBeUndefined();
    expect(decodeCursor(btoa(JSON.stringify({ sort: null, id: 1 })))).toBeUndefined();
    expect(decodeCursor(btoa(JSON.stringify(["sort", "id"])))).toBeUndefined();
  });
});

describe("toPage", () => {
  const rows = [
    { id: 5, at: 500 },
    { id: 4, at: 400 },
    { id: 3, at: 300 },
  ];
  const position = (row: { id: number; at: number }) => ({ sort: row.at, id: row.id });

  it("drops the over-fetched row and points the cursor at the last row it kept", () => {
    // `limit + 1` is what answers "is there another page" without a count query — on an audit table the
    // difference between a page load and a table scan.
    const page = toPage(rows, 2, position);
    expect(page.items).toEqual([rows[0], rows[1]]);
    expect(decodeCursor(page.nextCursor ?? undefined)).toEqual({ sort: 400, id: 4 });
  });

  it("reports the end of the list when the query returned no extra row", () => {
    const page = toPage(rows, 3, position);
    expect(page.items).toEqual(rows);
    expect(page.nextCursor).toBeNull();
  });

  it("handles an empty result without inventing a cursor", () => {
    expect(toPage([], 25, position)).toEqual({ items: [], nextCursor: null });
  });
});

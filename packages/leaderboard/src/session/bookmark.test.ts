import { describe, expect, it } from "vitest";
import { BOOKMARK_HEADER, readBookmark } from "./bookmark";

describe("readBookmark", () => {
  it("reads the bookmark a client echoed back", () => {
    expect(readBookmark(new Headers({ [BOOKMARK_HEADER]: "abc-123" }))).toBe("abc-123");
  });

  it("returns undefined when the client sent none, so the read is simply unconstrained", () => {
    expect(readBookmark(new Headers())).toBeUndefined();
  });

  it("treats an empty header as absent rather than anchoring a session at the empty string", () => {
    expect(readBookmark(new Headers({ [BOOKMARK_HEADER]: "" }))).toBeUndefined();
  });

  it("treats a whitespace-only header as absent", () => {
    expect(readBookmark(new Headers({ [BOOKMARK_HEADER]: "   " }))).toBeUndefined();
  });

  it("trims surrounding whitespace a proxy may have introduced", () => {
    expect(readBookmark(new Headers({ [BOOKMARK_HEADER]: "  abc-123  " }))).toBe("abc-123");
  });

  it("is case-insensitive on the header name, as HTTP requires", () => {
    expect(readBookmark(new Headers({ "X-Pithy-D1-Bookmark": "abc-123" }))).toBe("abc-123");
  });
});

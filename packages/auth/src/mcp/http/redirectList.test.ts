// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { redirectList } from "./redirectList";

describe("redirectList", () => {
  test("a JSON array is read as its entries", () => {
    expect(redirectList('["https://a.test/cb","http://127.0.0.1:7777/callback"]')).toEqual([
      "https://a.test/cb",
      "http://127.0.0.1:7777/callback",
    ]);
  });

  test("a JSON array keeps only its non-empty strings", () => {
    expect(redirectList('["https://a.test/cb", 7, null, {"a":1}, "", " "]')).toEqual(["https://a.test/cb"]);
  });

  test("JSON that is not an array names no redirect URI, rather than leaking a fragment of itself", () => {
    expect(redirectList('{"a":1}')).toEqual([]);
    expect(redirectList("42")).toEqual([]);
    expect(redirectList("null")).toEqual([]);
  });

  test("a JSON string is the one URI it holds", () => {
    expect(redirectList('"https://a.test/cb"')).toEqual(["https://a.test/cb"]);
  });

  test("the comma-joined form is split, trimmed, and its empty entries dropped", () => {
    expect(redirectList(" https://a.test/cb , ,https://b.test/cb,")).toEqual([
      "https://a.test/cb",
      "https://b.test/cb",
    ]);
  });

  test("an empty string names none", () => {
    expect(redirectList("")).toEqual([]);
    expect(redirectList("   ")).toEqual([]);
  });
});

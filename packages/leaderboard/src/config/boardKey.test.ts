// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { InstanceParam } from "../http/schemas";
import { isInstanceId, MAX_INSTANCE_ID_LENGTH, RESERVED_INSTANCE_IDS } from "./boardKey";

const RESERVED_MESSAGE = "`segment` cannot name an instance.";
const SHA256_HEX = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

const accepted: [string, string][] = [
  ["a single character", "a"],
  ["mixed case, digits, dashes and underscores", "V1StGXR8_Z5jdHi6B-myT"],
  ["a UUID", "3f2b8c1e-4d5a-4e6f-9a7b-1c2d3e4f5a6b"],
  ["a SHA-256 in hex, 64 characters", SHA256_HEX],
  ["64 characters, the most an id may take", "a".repeat(MAX_INSTANCE_ID_LENGTH)],
  ["a word that only contains the reserved one", "segments"],
  ["the reserved word in another case", "Segment"],
];

const refused: [string, string][] = [
  ["the empty string", ""],
  ["65 characters, one past the limit", "a".repeat(MAX_INSTANCE_ID_LENGTH + 1)],
  ["the reserved `segment`", "segment"],
  ["a leading dash", "-abc"],
  ["a leading underscore", "_abc"],
  ["a space", "a b"],
  ["a dot", "a.b"],
  ["a slash", "a/b"],
  ["a percent-encoded byte", "a%20b"],
  ["a non-ASCII letter", "café"],
];

describe("isInstanceId", () => {
  test("a SHA-256 in hex is exactly the longest id", () => {
    expect(SHA256_HEX).toHaveLength(MAX_INSTANCE_ID_LENGTH);
  });

  test.each(accepted)("accepts %s", (_name, id) => {
    expect(isInstanceId(id)).toBe(true);
  });

  test.each(refused)("refuses %s", (_name, id) => {
    expect(isInstanceId(id)).toBe(false);
  });
});

describe("the instance route's id segment", () => {
  test.each([...accepted, ...refused])("agrees with isInstanceId on %s", (_name, id) => {
    expect(InstanceParam.safeParse({ board: "level", instance: id }).success).toBe(isInstanceId(id));
  });

  test.each(refused)("names the reserved word for %s only if it is reserved", (_name, id) => {
    const result = InstanceParam.safeParse({ board: "level", instance: id });
    expect(result.success).toBe(false);
    const messages = result.error?.issues.map((issue) => issue.message) ?? [];
    expect(messages.includes(RESERVED_MESSAGE)).toBe(RESERVED_INSTANCE_IDS.has(id));
  });

  test("the reserved word is the one issue `segment` gets", () => {
    const result = InstanceParam.safeParse({ board: "level", instance: "segment" });
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([RESERVED_MESSAGE]);
  });
});

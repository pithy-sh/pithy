// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { CborError, cborBytes, cborText, decodeCbor } from "./cbor";

const hex = (value: string) => Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));

describe("decodeCbor", () => {
  test.each([
    ["00", 0],
    ["17", 23],
    ["1818", 24],
    ["190100", 256],
    ["1a000f4240", 1_000_000],
    ["20", -1],
    ["3863", -100],
    ["f4", false],
    ["f5", true],
    ["f6", null],
  ])("reads the RFC 8949 example %s", (encoded, value) => {
    expect(decodeCbor(hex(encoded))).toBe(value);
  });

  test("reads a byte string, a text string, an array and a map", () => {
    expect(decodeCbor(hex("4401020304"))).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(decodeCbor(hex("6449455446"))).toBe("IETF");
    expect(decodeCbor(hex("83010203"))).toEqual([1, 2, 3]);
    const map = decodeCbor(hex("a201020304")) as Map<unknown, unknown>;
    expect([...map.entries()]).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  test("reads text keys, as an attestation object carries them", () => {
    const map = decodeCbor(hex("a2616101616202"));
    expect(cborText(map, "a")).toBeUndefined();
    expect(map).toEqual(
      new Map([
        ["a", 1],
        ["b", 2],
      ]),
    );
  });

  test("cborBytes and cborText read one field of a map, and answer nothing for the wrong type", () => {
    const map = decodeCbor(hex("a263666d746161636b657943010203"));
    expect(cborText(map, "fmt")).toBe("a");
    expect(cborBytes(map, "key")).toEqual(new Uint8Array([1, 2, 3]));
    expect(cborBytes(map, "fmt")).toBeUndefined();
    expect(cborText(map, "key")).toBeUndefined();
    expect(cborBytes("not a map", "key")).toBeUndefined();
  });

  test.each([
    ["an empty input", ""],
    ["a truncated byte string", "4401"],
    ["a truncated argument", "19"],
    ["an indefinite length", "5f4101ff"],
    ["a reserved additional value", "1c"],
    ["a tag", "c11a514b67b0"],
    ["a float", "fa47c35000"],
    ["trailing bytes", "0000"],
    ["an integer past 2^53", "1b0020000000000000"],
    ["a duplicate map key", "a2616101616102"],
    ["invalid UTF-8 in a text string", "61ff"],
  ])("refuses %s", (_, encoded) => {
    expect(() => decodeCbor(hex(encoded))).toThrow(CborError);
  });

  test("refuses nesting deeper than any attestation needs", () => {
    expect(() => decodeCbor(new Uint8Array([...new Array(40).fill(0x81), 0x00]))).toThrow(/deep/);
  });

  test("refuses a length that runs past the input before allocating for it", () => {
    expect(() => decodeCbor(hex("9a7fffffff"))).toThrow(CborError);
    expect(() => decodeCbor(hex("5a7fffffff"))).toThrow(CborError);
  });
});

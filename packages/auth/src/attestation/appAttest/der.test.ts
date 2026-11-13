// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { DerError, derChildren, derInteger, derOid, derTime, readDer } from "./der";

const hex = (value: string) => Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));

describe("readDer", () => {
  test("reads one element: its tag, its content, and where it ends", () => {
    const node = readDer(hex("0403010203"));
    expect(node.tag).toBe(0x04);
    expect(node.content).toEqual(hex("010203"));
    expect(node.raw).toEqual(hex("0403010203"));
  });

  test("reads a long-form length", () => {
    const content = new Uint8Array(200).fill(7);
    const node = readDer(new Uint8Array([0x04, 0x81, 200, ...content]));
    expect(node.content).toEqual(content);
  });

  test("reads the children of a constructed element, in order", () => {
    const children = derChildren(readDer(hex("3006020101020102")));
    expect(children.map((child) => derInteger(child))).toEqual([hex("01"), hex("02")]);
  });

  test.each([
    ["an empty input", ""],
    ["a length past the input", "040501"],
    ["an indefinite length", "3080020101 0000".replace(" ", "")],
    ["a non-minimal long-form length", "04810101"],
    ["a length wider than four bytes", "0485010000000001"],
    ["bytes after the element", "04010102"],
    ["a high tag number", "1f0101"],
  ])("refuses %s", (_, encoded) => {
    expect(() => readDer(hex(encoded))).toThrow(DerError);
  });

  test("refuses the children of a primitive element", () => {
    expect(() => derChildren(readDer(hex("0403010203")))).toThrow(DerError);
  });
});

describe("derOid", () => {
  test.each([
    ["06082a8648ce3d040302", "1.2.840.10045.4.3.2"],
    ["06072a8648ce3d0201", "1.2.840.10045.2.1"],
    ["06052b81040022", "1.3.132.0.34"],
    ["06092a864886f763640802", "1.2.840.113635.100.8.2"],
  ])("reads %s as %s", (encoded, oid) => {
    expect(derOid(readDer(hex(encoded)))).toBe(oid);
  });

  test("refuses an element that is not an OID", () => {
    expect(() => derOid(readDer(hex("0401ff")))).toThrow(DerError);
  });
});

describe("derTime", () => {
  test("reads a UTCTime, in the century RFC 5280 assigns it", () => {
    expect(derTime(readDer(new Uint8Array([0x17, 13, ...new TextEncoder().encode("260420181312Z")])))).toEqual(
      new Date("2026-04-20T18:13:12Z"),
    );
    expect(derTime(readDer(new Uint8Array([0x17, 13, ...new TextEncoder().encode("700101000000Z")])))).toEqual(
      new Date("1970-01-01T00:00:00Z"),
    );
  });

  test("reads a GeneralizedTime", () => {
    expect(derTime(readDer(new Uint8Array([0x18, 15, ...new TextEncoder().encode("20450315000000Z")])))).toEqual(
      new Date("2045-03-15T00:00:00Z"),
    );
  });

  test("refuses a time that is not UTC to the second", () => {
    expect(() => derTime(readDer(new Uint8Array([0x17, 11, ...new TextEncoder().encode("2604201813Z")])))).toThrow(
      DerError,
    );
    expect(() =>
      derTime(readDer(new Uint8Array([0x17, 17, ...new TextEncoder().encode("260420181312+0100")]))),
    ).toThrow(DerError);
  });
});

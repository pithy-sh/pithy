// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { dateOf, verificationRowOf } from "./record";

const AT = new Date("2026-10-26T12:00:00.000Z");

describe("dateOf", () => {
  test("takes a Date, an ISO string and an epoch alike", () => {
    expect(dateOf(AT)?.getTime()).toBe(AT.getTime());
    expect(dateOf(AT.toISOString())?.getTime()).toBe(AT.getTime());
    expect(dateOf(AT.getTime())?.getTime()).toBe(AT.getTime());
  });

  test("answers null for what is not a date, rather than an Invalid Date", () => {
    expect(dateOf("tomorrow-ish")).toBeNull();
    expect(dateOf(new Date(Number.NaN))).toBeNull();
    expect(dateOf(undefined)).toBeNull();
    expect(dateOf({})).toBeNull();
  });
});

describe("verificationRowOf", () => {
  test("reads the id and both dates off a Better Auth row", () => {
    expect(verificationRowOf({ id: "v-1", createdAt: AT, expiresAt: AT, identifier: "x", value: "y" })).toEqual({
      id: "v-1",
      createdAt: AT,
      expiresAt: AT,
    });
  });

  test("a row with no creation date still reads, with the date null", () => {
    expect(verificationRowOf({ id: "v-1", expiresAt: AT })?.createdAt).toBeNull();
  });

  test("refuses anything without an id or an expiry", () => {
    expect(verificationRowOf(null)).toBeNull();
    expect(verificationRowOf({ expiresAt: AT })).toBeNull();
    expect(verificationRowOf({ id: "", expiresAt: AT })).toBeNull();
    expect(verificationRowOf({ id: 7, expiresAt: AT })).toBeNull();
    expect(verificationRowOf({ id: "v-1" })).toBeNull();
    expect(verificationRowOf({ id: "v-1", expiresAt: "never" })).toBeNull();
  });
});

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ConflictError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { partialWriteReport } from "./partialWrite";

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string");

describe("partialWriteReport", () => {
  test("the error is carried, never replaced", () => {
    const channel = partialWriteReport<string[]>("pithy.test.carry", isStrings);
    const original = new ConflictError({ message: "Secret 'k' is global.", detail: "throw-site context" });

    const thrown = channel.carry(original, ["staging"]);

    // Same object, same class, same payload. An operator reads the failure that happened.
    expect(thrown).toBe(original);
    expect(thrown).toBeInstanceOf(ConflictError);
    expect(thrown.payload.message).toBe("Secret 'k' is global.");
    expect(channel.read(thrown)).toEqual(["staging"]);
  });

  test("the report does not serialize with the error", () => {
    const channel = partialWriteReport<string[]>("pithy.test.hidden", isStrings);
    const error = channel.carry(new Error("boom"), ["staging", "prod"]);

    // `--json` prints `{ error }` from the payload. A report that enumerated would ride along into it.
    expect(Object.keys(error)).not.toContain("pithy.test.hidden");
    expect(JSON.stringify({ ...error })).not.toContain("staging");
    expect(Object.getOwnPropertyDescriptor(error, Symbol.for("pithy.test.hidden"))?.enumerable).toBe(false);
  });

  test("two channels cannot read each other's report", () => {
    // The reason the key is an argument. One shared symbol with two payload shapes is a reader decoding
    // somebody else's report as its own.
    const mint = partialWriteReport<string[]>("pithy.test.mint", isStrings);
    const dispatch = partialWriteReport<string[]>("pithy.test.dispatch", isStrings);
    const error = mint.carry(new Error("boom"), ["staging"]);

    expect(mint.read(error)).toEqual(["staging"]);
    expect(dispatch.read(error)).toBeUndefined();
  });

  test("a payload of the wrong shape is not returned as if it were right", () => {
    const channel = partialWriteReport<string[]>("pithy.test.shape", isStrings);
    const error = new Error("boom");
    Object.defineProperty(error, Symbol.for("pithy.test.shape"), { value: { not: "an array" } });

    expect(channel.read(error)).toBeUndefined();
  });

  test("a throw from anywhere else carries nothing, and reading it is not a crash", () => {
    const channel = partialWriteReport<string[]>("pithy.test.absent", isStrings);

    expect(channel.read(new Error("unrelated"))).toBeUndefined();
    expect(channel.read(null)).toBeUndefined();
    expect(channel.read(undefined)).toBeUndefined();
    expect(channel.read("a thrown string")).toBeUndefined();
    // The known limit: nothing attaches to a primitive, so a thrown string loses its report rather than
    // being wrapped in something the operator did not throw. See the module header.
    expect(channel.carry("a thrown string", ["staging"])).toBe("a thrown string");
  });
});

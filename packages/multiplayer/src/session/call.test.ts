// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { NotFoundError, PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { callSession } from "./call";
import { RPC_ERROR_PREFIX } from "./protocol";

describe("callSession", () => {
  test("revives a PithyError the session encoded across the RPC boundary", async () => {
    const payload = new NotFoundError({ message: "That session does not exist." }).payload;
    const error = await callSession(() => Promise.reject(new Error(RPC_ERROR_PREFIX + JSON.stringify(payload)))).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload).toMatchObject({ code: "core/not_found", status: 404 });
  });

  test("passes a real PithyError and a plain failure through untouched", async () => {
    const real = new NotFoundError({});
    await expect(callSession(() => Promise.reject(real))).rejects.toBe(real);
    const plain = new Error("D1 is busy");
    await expect(callSession(() => Promise.reject(plain))).rejects.toBe(plain);
  });

  test("a malformed envelope is the original error, never a crash in the reviver", async () => {
    const malformed = new Error(`${RPC_ERROR_PREFIX}{not json`);
    await expect(callSession(() => Promise.reject(malformed))).rejects.toBe(malformed);
    const wrongShape = new Error(`${RPC_ERROR_PREFIX}{"code":42}`);
    await expect(callSession(() => Promise.reject(wrongShape))).rejects.toBe(wrongShape);
  });

  test("answers what the call answered", async () => {
    expect(await callSession(() => Promise.resolve(7))).toBe(7);
  });
});

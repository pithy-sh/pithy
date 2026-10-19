// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Artifacts, ArtifactsRepo } from "@cloudflare/workers-types";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, expectTypeOf, test } from "vitest";
import {
  type ArtifactsNamespaceBinding,
  type ArtifactsRepoHandle,
  artifactsBinding,
  artifactsErrorCode,
  callArtifacts,
  withRepo,
} from "./artifacts";

/** An `ArtifactsError` as the binding throws one. */
function artifactsError(code: string): Error {
  return Object.assign(new Error(`artifacts: ${code}`), { name: "ArtifactsError", code, numericCode: 1 });
}

describe("the binding this capability calls", () => {
  test("is a slice of Cloudflare's own Artifacts type", () => {
    expectTypeOf<Artifacts>().toMatchTypeOf<ArtifactsNamespaceBinding>();
    expectTypeOf<ArtifactsRepo>().toMatchTypeOf<ArtifactsRepoHandle>();
  });

  test("is refused by name when the Worker does not bind it", () => {
    expect(() => artifactsBinding({}, "ARTIFACTS")).toThrow(/not configured/);
    const bound = { get: async () => ({}) };
    expect(artifactsBinding({ ARTIFACTS: bound }, "ARTIFACTS")).toBe(bound);
  });
});

describe("callArtifacts", () => {
  test("reads an ArtifactsError's code, and only an ArtifactsError's", () => {
    expect(artifactsErrorCode(artifactsError("NOT_FOUND"))).toBe("NOT_FOUND");
    expect(artifactsErrorCode(new Error("NOT_FOUND"))).toBeUndefined();
    expect(artifactsErrorCode("NOT_FOUND")).toBeUndefined();
  });

  test.each([
    ["NOT_FOUND", "artifacts/not_found"],
    ["INVALID_REPO_NAME", "artifacts/invalid_name"],
    ["ALREADY_EXISTS", "artifacts/name_taken"],
    ["INTERNAL_ERROR", "core/upstream_failed"],
    ["UPSTREAM_UNAVAILABLE", "core/upstream_failed"],
  ])("translates %s into %s", async (code, expected) => {
    const failure = await callArtifacts("probe", async () => {
      throw artifactsError(code);
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.code).toBe(expected);
  });

  test("passes a PithyError through untouched", async () => {
    const own = new PithyError({ code: "core/internal", status: 500, message: "ours" });
    await expect(callArtifacts("probe", async () => Promise.reject(own))).rejects.toBe(own);
  });
});

describe("withRepo", () => {
  test("disposes of the stub however the work ends", async () => {
    let disposed = 0;
    const handle = { [Symbol.dispose]: () => (disposed += 1) } as unknown as ArtifactsRepoHandle;
    const binding = { get: async () => handle } as unknown as ArtifactsNamespaceBinding;
    expect(await withRepo(binding, "r1", async () => "done")).toBe("done");
    await expect(
      withRepo(binding, "r1", async () => Promise.reject(artifactsError("INTERNAL_ERROR"))),
    ).rejects.toThrow();
    expect(disposed).toBe(2);
  });
});

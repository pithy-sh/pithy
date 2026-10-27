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
  revokeEveryToken,
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

describe("revokeEveryToken", () => {
  /**
   * A repository whose listing answers one page of at most `page` tokens with no cursor, as Cloudflare's does. By
   * default it lists active tokens only, as the real binding does; `listsRevoked` keeps revoked ones on the page, the
   * worse listing that revoking by record must survive.
   */
  function paged(live: number, page: number, revokes = true, listsRevoked = false) {
    const states = Array.from({ length: live }, () => "active" as "active" | "revoked");
    const repo = {
      listTokens: async () => {
        const every = states
          .map((state, index) => ({ id: `t${index}`, scope: "read" as const, state, createdAt: "", expiresAt: "" }))
          .filter((token) => listsRevoked || token.state === "active");
        return { tokens: every.slice(0, page), total: every.length };
      },
      revokeToken: async (id: string) => {
        if (!revokes) return false;
        states[Number(id.slice(1))] = "revoked";
        return true;
      },
    } as unknown as ArtifactsRepoHandle;
    return { repo, states };
  }

  test("revokes a page at a time until none is live", async () => {
    const { repo, states } = paged(7, 3);
    expect(await revokeEveryToken(repo)).toBe(7);
    expect(states.every((state) => state === "revoked")).toBe(true);
  });

  test("stops on a round that revokes nothing, rather than asking forever", async () => {
    const { repo } = paged(2, 10, false);
    expect(await revokeEveryToken(repo)).toBe(0);
  });

  test("reaches every recorded token when the listing shows revoked ones, which ends its paging at the first page", async () => {
    const { repo, states } = paged(7, 3, true, true);
    const recorded = states.map((_, index) => `t${index}`);
    expect(await revokeEveryToken(repo, recorded)).toBe(7);
    expect(states.every((state) => state === "revoked")).toBe(true);
  });

  test("still sweeps the listing for a live token nobody recorded", async () => {
    const { repo, states } = paged(4, 10, true, true);
    expect(await revokeEveryToken(repo, ["t0", "t1"])).toBe(4);
    expect(states.every((state) => state === "revoked")).toBe(true);
  });

  test("counts a recorded token that was already dead as nothing", async () => {
    const { repo, states } = paged(3, 10, true, true);
    states[0] = "revoked";
    const calls: string[] = [];
    const counted = {
      listTokens: async () => {
        calls.push("list");
        return repo.listTokens();
      },
      revokeToken: async (id: string) => {
        calls.push(`revoke ${id}`);
        return states[Number(id.slice(1))] === "active" ? repo.revokeToken(id) : false;
      },
    } as unknown as ArtifactsRepoHandle;
    expect(await revokeEveryToken(counted, ["t0", "t1"])).toBe(2);
    expect(calls).toEqual(["revoke t0", "revoke t1", "list", "revoke t2", "list"]);
  });

  test("answers zero for a repository with nothing live", async () => {
    expect(await revokeEveryToken(paged(0, 10).repo)).toBe(0);
  });

  test("lists, revokes each live token, then lists again to confirm none is left", async () => {
    const calls: string[] = [];
    const { repo } = paged(3, 10);
    const counted = {
      listTokens: async () => {
        calls.push("list");
        return repo.listTokens();
      },
      revokeToken: async (id: string) => {
        calls.push("revoke");
        return repo.revokeToken(id);
      },
    } as unknown as ArtifactsRepoHandle;
    expect(await revokeEveryToken(counted)).toBe(3);
    expect(calls).toEqual(["list", "revoke", "revoke", "revoke", "list"]);
    calls.length = 0;
    expect(await revokeEveryToken(counted)).toBe(0);
    expect(calls).toEqual(["list"]);
  });
});

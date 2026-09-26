// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  collectPermissionFlags,
  deadTokenNotice,
  parsePermissions,
  parseStore,
  publicToken,
  resolveAppDatabaseId,
  routeScopeNotice,
  tokenProfiles,
} from "./token";

describe("collectPermissionFlags", () => {
  test("collects every repeated --permission from raw argv (citty keeps only the last)", () => {
    expect(
      collectPermissionFlags(["mint", "ci-system", "--permission", "workers:write", "--permission", "d1:read"]),
    ).toEqual(["workers:write", "d1:read"]);
  });

  test("handles --permission=key and returns [] when none are given", () => {
    expect(collectPermissionFlags(["mint", "ci-system", "--permission=d1:read"])).toEqual(["d1:read"]);
    expect(collectPermissionFlags(["mint", "ci-system", "--env", "staging"])).toEqual([]);
  });
});

describe("parsePermissions", () => {
  test("treats an empty collected list as no override", () => {
    expect(parsePermissions([])).toBeUndefined();
  });

  test("accepts a single key or a repeated list", () => {
    expect(parsePermissions("d1:read")).toEqual(["d1:read"]);
    expect(parsePermissions(["d1:read", "workers:write"])).toEqual(["d1:read", "workers:write"]);
    expect(parsePermissions(undefined)).toBeUndefined();
  });

  test("rejects an unknown key with an actionable error", () => {
    expect(() => parsePermissions("d1:destroy")).toThrow(PithyError);
  });
});

describe("parseStore", () => {
  test("accepts a valid sink and rejects an unknown one", () => {
    expect(parseStore("dev-vars")).toBe("dev-vars");
    expect(parseStore(undefined)).toBeUndefined();
    expect(() => parseStore("s3")).toThrow(PithyError);
  });
});

describe("publicToken", () => {
  test("projects the safe fields and never the secret value", () => {
    const pub = publicToken({
      profile: "ci-system",
      env: "staging",
      tokenId: "tok-1",
      name: "pithy-ci-system-staging",
      value: "super-secret",
      sink: { sink: "dev-vars", location: ".dev.vars.staging" },
    });
    expect(pub).toEqual({
      profile: "ci-system",
      env: "staging",
      tokenId: "tok-1",
      store: "dev-vars",
      location: ".dev.vars.staging",
    });
    expect(JSON.stringify(pub)).not.toContain("super-secret");
  });
});

describe("resolveAppDatabaseId", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-token-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("reads the app DB id from a worker's env stanza, dev from its top level, undefined when absent", async () => {
    // The id lives in the Worker's own apps/<name>/wrangler.jsonc — there is no root one.
    const worker = join(dir, "apps", "api");
    await mkdir(worker, { recursive: true });
    await writeFile(
      join(worker, "wrangler.jsonc"),
      JSON.stringify({
        name: "api",
        d1_databases: [{ binding: "DB", database_id: "dev-db" }],
        env: { staging: { d1_databases: [{ binding: "DB", database_id: "staging-db" }] } },
      }),
    );
    expect(await resolveAppDatabaseId(dir, "dev")).toBe("dev-db");
    expect(await resolveAppDatabaseId(dir, "staging")).toBe("staging-db");
    expect(await resolveAppDatabaseId(dir, "prod")).toBeUndefined();
  });

  test("returns undefined when the project has no workers", async () => {
    expect(await resolveAppDatabaseId(dir, "staging")).toBeUndefined();
  });
});

describe("tokenProfiles", () => {
  /** A resolved worker carrying just its capabilities — the only field the profile fold reads. */
  const worker = (capabilities: never[] = []) =>
    ({ name: "api", dir: "/proj/apps/api", config: { capabilities }, capabilities, target: {} }) as never;

  test("**an unknowable capability set is refused, never emptied**", () => {
    // The docstring over `buildEngine` insists the *root* config is required and never guessed, because
    // `revoke` deletes every account token of the name it computes — and then the Worker half was
    // best-effort. With capabilities emptied, `resolveTokenProfiles([])` returns only `ci-system` and drops
    // every capability's `ciPermissions`. So `pithy token list <env>` reported to an operator auditing live
    // credentials that capability-profile tokens do not exist, and exited 0; and `pithy token rotate
    // ci-system <env>` minted a replacement carrying only the base permissions, then deleted the
    // fully-permissioned token it replaced. CI silently lost permissions and nothing in the run said the
    // capability set was unknown.
    const refusal = () => tokenProfiles({ unknown: "No pithy.config.ts in collab." });

    expect(refusal).toThrow(PithyError);
    expect(refusal).toThrow(/capability set is unknown/i);
    // And it names the worker, quoting the set's own diagnosis rather than inventing one (#454).
    try {
      refusal();
    } catch (error) {
      expect((error as PithyError).payload.action).toMatch(/No pithy\.config\.ts in collab\./);
    }
  });

  test("a project with no Workers still resolves — ci-system is project-level", () => {
    // `resolveTokenProfiles([])` is the right answer here, not a refusal: `ci-system` mints fine for a
    // project that has not added a Worker yet.
    expect(Object.keys(tokenProfiles([]))).toContain("ci-system");
  });

  test("a healthy set resolves to its profiles", () => {
    expect(Object.keys(tokenProfiles([worker()]))).toContain("ci-system");
  });
});

describe("routeScopeNotice", () => {
  const row = (
    profile: string,
    routeScope: "not-required" | "scoped" | "stale" | "overridden" | "inactive" | "unknown",
  ) => ({
    profile,
    env: "staging",
    name: `acme-staging-${profile}`,
    tokenId: "t1",
    routeScope,
  });

  test("names the stale profile and the one command that fixes it — rotate, not mint", () => {
    // #651 round four. `mint` rolls the value and never touches the policy set, so it cannot re-scope a
    // token that predates the zone grant; `rotate` mints with the current policies and deletes the old
    // one, which is what re-scoping is. Naming mint here is the no-op the earlier rounds kept finding.
    const notice = routeScopeNotice([row("ci-system", "stale")], "staging");
    expect(notice).toContain("ci-system");
    expect(notice).toContain("pithy token rotate ci-system --env staging");
    expect(notice).not.toContain("pithy token mint");
    // And it says what rotate costs, because it is not the same act as a mint.
    expect(notice).toMatch(/replace|new token|deletes the old/i);
  });

  test("the stale line states what the token lacks, never when it was minted", () => {
    // A `--permission` narrowing on a *rotate* produces a route-less token seconds ago, and "minted
    // before this project's domains were scoped" is then simply false. The remedy is unchanged — a plain
    // rotate restores the profile's set — so only the diagnosis needed to stop guessing at history.
    const notice = routeScopeNotice([row("ci-system", "stale")], "staging");
    expect(notice).not.toMatch(/minted before/);
    expect(notice).toMatch(/does not carry/);
  });

  test("an inactive token is reported as dead rather than as unscoped", () => {
    const notice = routeScopeNotice([row("ci-system", "inactive")], "staging");
    expect(notice).toMatch(/disabled|expired|not active/i);
    expect(notice).not.toContain("minted before");
  });

  test("an overridden grant names the override, never a re-mint that would not change it", () => {
    // The no-op loop: the adopter runs the printed command, the standing override strips the route
    // policy from that mint too, and the listing prints the same line again. #651 round three.
    const notice = routeScopeNotice([row("ci-system", "overridden")], "staging");
    expect(notice).toContain("tokens.overrides");
    expect(notice).toContain("re-minting will not change that");
    // The mint command may appear, but never as the remedy on its own: it is only useful *after* the
    // override is gone, and the line that offers it has to say so.
    const commandLine = (notice ?? "").split("\n").find((line) => line.includes("pithy token rotate"));
    expect(commandLine).toMatch(/Remove that override/);
  });

  test("a stale token gets the plain rotate remedy, with no override talk", () => {
    const notice = routeScopeNotice([row("ci-system", "stale")], "staging");
    expect(notice).toContain("pithy token rotate ci-system --env staging");
    expect(notice).not.toContain("tokens.overrides");
  });

  test("says nothing when every token is scoped, needs no scope, or could not be read", () => {
    expect(routeScopeNotice([row("ci-system", "scoped")], "staging")).toBeNull();
    expect(routeScopeNotice([row("ci-system", "not-required")], "staging")).toBeNull();
    // Unknown is not stale: claiming a token is wrong on a policy set that never came back would send
    // an adopter to roll a working credential.
    expect(routeScopeNotice([row("ci-system", "unknown")], "staging")).toBeNull();
  });
});

describe("deadTokenNotice", () => {
  const result = (status?: "active" | "disabled" | "expired") => ({
    profile: "ci-system",
    env: "staging",
    tokenId: "t1",
    name: "acme-staging-ci-system",
    value: "never printed",
    sink: { sink: "dev-vars" as const, location: "/tmp/tokens.json" },
    ...(status ? { status } : {}),
  });

  test.each(["disabled", "expired"] as const)("a %s token is named, with what to do about it", (status) => {
    // The value is real and the token is dead. `Done.` over that is the failure (#651).
    const notice = deadTokenNotice(result(status));
    expect(notice).toContain(status);
    expect(notice).toContain("pithy token rotate ci-system --env staging");
  });

  test("says nothing for an active token, or one whose status Cloudflare did not give", () => {
    expect(deadTokenNotice(result("active"))).toBeNull();
    expect(deadTokenNotice(result())).toBeNull();
  });

  test("never carries the secret", () => {
    expect(deadTokenNotice(result("disabled"))).not.toContain("never printed");
  });
});

describe("publicToken", () => {
  test("carries the status so --json can be acted on, and never the value", () => {
    const json = publicToken({
      profile: "ci-system",
      env: "staging",
      tokenId: "t1",
      name: "acme-staging-ci-system",
      value: "never printed",
      sink: { sink: "dev-vars", location: "/tmp/tokens.json" },
      status: "disabled",
    });
    expect(json).toMatchObject({ status: "disabled" });
    expect(JSON.stringify(json)).not.toContain("never printed");
  });
});

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { collectPermissionFlags, parsePermissions, parseStore, publicToken, resolveAppDatabaseId } from "./token";

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
    expect(await resolveAppDatabaseId(dir, "production")).toBeUndefined();
  });

  test("returns undefined when the project has no workers", async () => {
    expect(await resolveAppDatabaseId(dir, "staging")).toBeUndefined();
  });
});

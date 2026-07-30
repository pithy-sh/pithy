// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { writeTokenToSink } from "./sinks";

describe("writeTokenToSink", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-sink-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("ephemeral writes nothing and reports it", async () => {
    const target = await writeTokenToSink("ephemeral", "secret-value", {
      projectDir: dir,
      env: "staging",
      secretName: "CF_TOKEN_CI_SYSTEM",
    });
    expect(target.sink).toBe("ephemeral");
    expect(target.location).not.toContain("secret-value");
  });

  test("dev-vars upserts the secret name in .dev.vars.<env>, preserving other lines", async () => {
    await writeFile(join(dir, ".dev.vars.staging"), "CLOUDFLARE_ACCOUNT_ID=acct\nOTHER=keep\n");

    const target = await writeTokenToSink("dev-vars", "v1", {
      projectDir: dir,
      env: "staging",
      secretName: "CF_TOKEN_CI_SYSTEM",
    });
    expect(target).toEqual({ sink: "dev-vars", location: ".dev.vars.staging" });

    const body = await readFile(join(dir, ".dev.vars.staging"), "utf8");
    expect(body).toContain("CLOUDFLARE_ACCOUNT_ID=acct");
    expect(body).toContain("OTHER=keep");
    expect(body).toContain("CF_TOKEN_CI_SYSTEM=v1");

    // A second write replaces the value in place — no duplicate line.
    await writeTokenToSink("dev-vars", "v2", { projectDir: dir, env: "staging", secretName: "CF_TOKEN_CI_SYSTEM" });
    const updated = await readFile(join(dir, ".dev.vars.staging"), "utf8");
    expect(updated).toContain("CF_TOKEN_CI_SYSTEM=v2");
    expect(updated.match(/CF_TOKEN_CI_SYSTEM=/g)).toHaveLength(1);
  });

  test("dev-vars for the dev env writes plain .dev.vars", async () => {
    const target = await writeTokenToSink("dev-vars", "v1", {
      projectDir: dir,
      env: "dev",
      secretName: "CF_TOKEN_CI_SYSTEM",
    });
    expect(target.location).toBe(".dev.vars");
    expect(await readFile(join(dir, ".dev.vars"), "utf8")).toContain("CF_TOKEN_CI_SYSTEM=v1");
  });

  test("secrets-store calls putSecret under the secret name, never leaking the value into the location", async () => {
    const putSecret = vi.fn(async () => {});
    const target = await writeTokenToSink("secrets-store", "sv", {
      projectDir: dir,
      env: "production",
      secretName: "GLOBAL_SECRETS_MANAGER_CF_API_TOKEN",
      putSecret,
    });
    expect(putSecret).toHaveBeenCalledWith("GLOBAL_SECRETS_MANAGER_CF_API_TOKEN", "sv");
    expect(target.sink).toBe("secrets-store");
    expect(target.location).not.toContain("sv");
  });

  test("secrets-store without a configured store fails with an actionable error", async () => {
    await expect(
      writeTokenToSink("secrets-store", "sv", { projectDir: dir, env: "production", secretName: "X" }),
    ).rejects.toThrow(PithyError);
  });
});

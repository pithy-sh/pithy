// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
      storeEntryName: "acme-staging-cf-token-ci-system",
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
      // Deliberately different from the variable key: a dev-vars write must ignore it entirely.
      storeEntryName: "acme-staging-cf-token-ci-system",
    });
    expect(target).toEqual({ sink: "dev-vars", location: ".dev.vars.staging" });

    const body = await readFile(join(dir, ".dev.vars.staging"), "utf8");
    expect(body).toContain("CLOUDFLARE_ACCOUNT_ID=acct");
    expect(body).toContain("OTHER=keep");
    expect(body).toContain("CF_TOKEN_CI_SYSTEM=v1");

    // A second write replaces the value in place — no duplicate line.
    await writeTokenToSink("dev-vars", "v2", {
      projectDir: dir,
      env: "staging",
      secretName: "CF_TOKEN_CI_SYSTEM",
      storeEntryName: "acme-staging-cf-token-ci-system",
    });
    const updated = await readFile(join(dir, ".dev.vars.staging"), "utf8");
    expect(updated).toContain("CF_TOKEN_CI_SYSTEM=v2");
    expect(updated.match(/CF_TOKEN_CI_SYSTEM=/g)).toHaveLength(1);
  });

  test("dev-vars for the dev env writes plain .dev.vars", async () => {
    const target = await writeTokenToSink("dev-vars", "v1", {
      projectDir: dir,
      env: "dev",
      secretName: "CF_TOKEN_CI_SYSTEM",
      storeEntryName: "acme-dev-cf-token-ci-system",
    });
    expect(target.location).toBe(".dev.vars");
    expect(await readFile(join(dir, ".dev.vars"), "utf8")).toContain("CF_TOKEN_CI_SYSTEM=v1");
  });

  test("dev-vars creates a file that did not exist owner-only, not at the umask default", async () => {
    // Every other test here writes into a `.dev.vars` the test already created, and an existing file
    // keeps its own mode — which is exactly how this survived. `pithy token mint --store dev-vars`
    // against an environment with no dev-vars file yet *creates* one, and the first thing in it is a
    // live Cloudflare API token. Falling through to the umask put a production credential at 0664.
    const target = await writeTokenToSink("dev-vars", "live-prod-token", {
      projectDir: dir,
      env: "prod",
      secretName: "CLOUDFLARE_API_TOKEN",
      storeEntryName: "acme-prod-cloudflare-api-token",
    });
    expect(target.location).toBe(".dev.vars.prod");

    const file = join(dir, ".dev.vars.prod");
    expect(((await stat(file)).mode & 0o777).toString(8)).toBe("600");
    expect(await readFile(file, "utf8")).toContain("CLOUDFLARE_API_TOKEN=live-prod-token");
  });

  test("dev-vars leaves the mode of a file that already exists alone", async () => {
    // The mode is for creating a file, never for overruling one an adopter has already set.
    await writeFile(join(dir, ".dev.vars.staging"), "OTHER=keep\n", { mode: 0o640 });
    await writeTokenToSink("dev-vars", "v1", {
      projectDir: dir,
      env: "staging",
      secretName: "CF_TOKEN_CI_SYSTEM",
      storeEntryName: "acme-staging-cf-token-ci-system",
    });
    expect(((await stat(join(dir, ".dev.vars.staging"))).mode & 0o777).toString(8)).toBe("640");
  });

  test("dev-vars leaves a commented-out key commented, rather than rewriting the comment", async () => {
    // A `.dev.vars` seeded from `.dev.vars.example` is mostly comments. Upserting has to add the key,
    // not edit the documentation that happens to mention it.
    await writeFile(join(dir, ".dev.vars"), "# CLOUDFLARE_API_TOKEN=put-yours-here\n");
    await writeTokenToSink("dev-vars", "real", {
      projectDir: dir,
      env: "dev",
      secretName: "CLOUDFLARE_API_TOKEN",
      storeEntryName: "acme-dev-cloudflare-api-token",
    });
    const body = await readFile(join(dir, ".dev.vars"), "utf8");
    expect(body).toContain("# CLOUDFLARE_API_TOKEN=put-yours-here");
    expect(body).toContain("\nCLOUDFLARE_API_TOKEN=real");
  });

  test("secrets-store writes the project-scoped entry name, not the .dev.vars variable key", async () => {
    // The two names split for a reason: the store is one flat namespace shared by every project in the
    // account, so its entry is scoped — while the variable key stays verbatim for CI to read.
    const putSecret = vi.fn(async () => {});
    const target = await writeTokenToSink("secrets-store", "sv", {
      projectDir: dir,
      env: "prod",
      secretName: "SECRETS_MANAGER_CF_API_TOKEN",
      storeEntryName: "acme-global-secrets-manager-cf-api-token",
      putSecret,
    });
    expect(putSecret).toHaveBeenCalledWith("acme-global-secrets-manager-cf-api-token", "sv");
    expect(putSecret).not.toHaveBeenCalledWith("SECRETS_MANAGER_CF_API_TOKEN", "sv");
    expect(target.sink).toBe("secrets-store");
    expect(target.location).not.toContain("sv");
  });

  test("secrets-store without a configured store fails with an actionable error", async () => {
    await expect(
      writeTokenToSink("secrets-store", "sv", {
        projectDir: dir,
        env: "prod",
        secretName: "X",
        storeEntryName: "acme-prod-x",
      }),
    ).rejects.toThrow(PithyError);
  });
});

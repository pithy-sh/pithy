// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { StatePathOptions } from "../notifier/state";
import { writeTokenToSink } from "./sinks";

describe("writeTokenToSink", () => {
  let dir: string;
  let config: string;

  /** The seams, as a function: `config` is fresh per test, so a captured const would go stale. */
  function paths(): StatePathOptions {
    return { platform: "linux", homedir: "/home/nobody", env: { PITHY_CONFIG_DIR: config } };
  }

  /** Where a minted token for `env` lands — the file this whole module exists to move out of the checkout. */
  function tokensFile(): string {
    return join(config, "replay", "tokens.json");
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-sink-"));
    config = await mkdtemp(join(tmpdir(), "pithy-sink-cfg-"));
    // The project's name is what keys its config directory — deliberately different from the directory
    // basename, which is a temp path. A fixture where the two match hides a whole class of bug.
    await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "replay" };\n');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(config, { recursive: true, force: true });
  });

  test("ephemeral writes nothing and reports it", async () => {
    const target = await writeTokenToSink("ephemeral", "secret-value", {
      project: "replay",
      env: "staging",
      secretName: "CF_TOKEN_CI_SYSTEM",
      storeEntryName: "acme-staging-cf-token-ci-system",
      paths: paths(),
    });
    expect(target.sink).toBe("ephemeral");
    expect(target.location).not.toContain("secret-value");
  });

  test("dev-vars records the token under its environment, outside the project", async () => {
    const target = await writeTokenToSink("dev-vars", "v1", {
      project: "replay",
      env: "staging",
      secretName: "CF_TOKEN_CI_SYSTEM",
      // Deliberately different from the variable key: a dev-vars write must ignore it entirely.
      storeEntryName: "acme-staging-cf-token-ci-system",
      paths: paths(),
    });
    expect(target).toEqual({ sink: "dev-vars", location: tokensFile() });
    expect(JSON.parse(await readFile(tokensFile(), "utf8"))).toEqual({ staging: { CF_TOKEN_CI_SYSTEM: "v1" } });

    // A second write replaces the value in place, and nothing else in the document moves.
    await writeTokenToSink("dev-vars", "v2", {
      project: "replay",
      env: "dev",
      secretName: "CF_TOKEN_CI_SYSTEM",
      storeEntryName: "acme-dev-cf-token-ci-system",
      paths: paths(),
    });
    await writeTokenToSink("dev-vars", "v3", {
      project: "replay",
      env: "staging",
      secretName: "CF_TOKEN_CI_SYSTEM",
      storeEntryName: "acme-staging-cf-token-ci-system",
      paths: paths(),
    });
    expect(JSON.parse(await readFile(tokensFile(), "utf8"))).toEqual({
      dev: { CF_TOKEN_CI_SYSTEM: "v2" },
      staging: { CF_TOKEN_CI_SYSTEM: "v3" },
    });
  });

  /**
   * The whole of #182 in one assertion. `pithy token mint --env production --store dev-vars` used to
   * write `.dev.vars.production` into the checkout — a live production Cloudflare credential, gitignored
   * but reachable by `npm pack`, which does not consult `.gitignore` when `files` is set (#145).
   */
  test("no minted credential lands in the project directory, for any environment", async () => {
    for (const env of ["dev", "staging", "production"]) {
      await writeTokenToSink("dev-vars", `live-${env}-token`, {
        project: "replay",
        env,
        secretName: "CLOUDFLARE_API_TOKEN",
        storeEntryName: `replay-${env}-cloudflare-api-token`,
        paths: paths(),
      });
    }
    // Nothing at all was written into the project — not `.dev.vars`, not a `.dev.vars.<env>`, nothing.
    expect(await readdir(dir)).toEqual(["pithy.config.ts"]);
    const written: unknown = JSON.parse(await readFile(tokensFile(), "utf8"));
    expect(written).toEqual({
      dev: { CLOUDFLARE_API_TOKEN: "live-dev-token" },
      staging: { CLOUDFLARE_API_TOKEN: "live-staging-token" },
      production: { CLOUDFLARE_API_TOKEN: "live-production-token" },
    });
  });

  test("the file it creates is owner-only, in an owner-only directory, not at the umask default", async () => {
    // The defect on record: a private copy of the upsert that lacked the shared one's `0600`, so minting
    // for an environment with no file yet left a live production credential at 0664.
    await writeTokenToSink("dev-vars", "live-prod-token", {
      project: "replay",
      env: "production",
      secretName: "CLOUDFLARE_API_TOKEN",
      storeEntryName: "replay-production-cloudflare-api-token",
      paths: paths(),
    });
    expect(((await stat(tokensFile())).mode & 0o777).toString(8)).toBe("600");
    expect(((await stat(join(config, "replay"))).mode & 0o777).toString(8)).toBe("700");
  });

  test("secrets-store writes the project-scoped entry name, not the variable key", async () => {
    // The two names split for a reason: the store is one flat namespace shared by every project in the
    // account, so its entry is scoped — while the variable key stays verbatim for CI to read.
    const putSecret = vi.fn(async () => {});
    const target = await writeTokenToSink("secrets-store", "sv", {
      project: "replay",
      env: "prod",
      secretName: "SECRETS_MANAGER_CF_API_TOKEN",
      storeEntryName: "acme-global-secrets-manager-cf-api-token",
      putSecret,
      paths: paths(),
    });
    expect(putSecret).toHaveBeenCalledWith("acme-global-secrets-manager-cf-api-token", "sv");
    expect(putSecret).not.toHaveBeenCalledWith("SECRETS_MANAGER_CF_API_TOKEN", "sv");
    expect(target.sink).toBe("secrets-store");
    expect(target.location).not.toContain("sv");
  });

  test("secrets-store without a configured store fails with an actionable error", async () => {
    await expect(
      writeTokenToSink("secrets-store", "sv", {
        project: "replay",
        env: "prod",
        secretName: "X",
        storeEntryName: "acme-prod-x",
        paths: paths(),
      }),
    ).rejects.toThrow(PithyError);
  });
});

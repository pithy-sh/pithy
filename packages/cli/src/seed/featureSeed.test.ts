// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { defineSeed, type SeedPrepareContext } from "@pithy-sh/core/src/seed/seed";
import { defineSecretRegistry } from "@pithy-sh/secrets/src/registry";
import { afterEach, describe, expect, test } from "vitest";
import { devSecretsFile } from "../devSecrets/location";
import type { WorkerScope } from "../migrations/run";
import { featureConfigPath } from "../provision/featureConfig";
import { seedProject } from "./run";

/**
 * **`pithy seed` on a feature environment (#643): the origin a prepared set is handed, and the secrets.**
 *
 * Project `replay`, Worker `board`, deliberately unequal: a feature Worker deploys as
 * `replay-f643-feature-address-board`, and a fixture where project and Worker share a name cannot tell a script
 * composed from the right one from a script composed from the wrong one.
 *
 * Nothing here reaches Cloudflare. The account's `workers.dev` subdomain is the one thing a feature's address
 * needs from it, and it arrives through the `workersSubdomain` seam.
 */

const PROJECT = "replay";
const SCRIPT = "replay-f643-feature-address-board";
const FEATURE_ORIGIN = `https://${SCRIPT}.acme.workers.dev`;

/** A secret the registry can mint, one it cannot, as auth and an OAuth provider declare them. */
const REGISTRY = defineSecretRegistry({
  "auth-session-secret": {
    backend: "d1",
    scope: "environment",
    rotatable: true,
    valueType: "text",
    devValue: "random",
  },
  "auth-github-credentials": { backend: "d1", scope: "environment", rotatable: false, valueType: "text" },
});

/** One prepared set per name, capturing the context and every secret it asked for. Writes no store. */
function capturing(
  seen: { context: SeedPrepareContext; secrets: Record<string, string | undefined> }[],
  names: readonly string[] = ["first"],
): Capability {
  return defineCapability({
    name: "app",
    requiredBindings: [],
    secretRegistry: REGISTRY,
    seeds: names.map((name, index) =>
      defineSeed({
        name,
        order: 1000 + index,
        environments: ["dev", "staging", "feature"],
        prepare: async (context) => {
          const secrets: Record<string, string | undefined> = {};
          if (context.env !== "staging") {
            for (const secret of ["auth-session-secret", "auth-github-credentials"]) {
              secrets[secret] = await context.secret(secret);
            }
          }
          seen.push({ context, secrets });
          return {};
        },
      }),
    ),
  });
}

describe("pithy seed on a feature environment", () => {
  const made: string[] = [];
  afterEach(async () => {
    await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  /** A project root holding Worker `board`, with the feature stanza provisioning generates for it. */
  async function project(options: { stanza?: Record<string, unknown>; tracked?: Record<string, unknown> } = {}) {
    const dir = await mkdtemp(join(tmpdir(), "pithy-feature-seed-"));
    made.push(dir);
    const workerDir = join(dir, "apps", "board");
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "wrangler.jsonc"), JSON.stringify(options.tracked ?? { name: "replay-board" }));
    await mkdir(dirname(featureConfigPath(workerDir)), { recursive: true });
    await writeFile(
      featureConfigPath(workerDir),
      JSON.stringify({ name: "replay-board", env: { feature: options.stanza ?? { name: SCRIPT } } }),
    );
    return {
      dir,
      worker: (capabilities: Capability[]): WorkerScope => ({ name: "board", dir: workerDir, capabilities }),
    };
  }

  test("hands a prepared set the feature's workers.dev origin, asking the account once", async () => {
    const target = await project();
    const seen: { context: SeedPrepareContext; secrets: Record<string, string | undefined> }[] = [];
    let lookups = 0;

    await seedProject({
      account: null,
      project: PROJECT,
      projectDir: target.dir,
      env: "feature",
      yes: true,
      workers: [target.worker([capturing(seen, ["first", "second"])])],
      workersSubdomain: async () => {
        lookups += 1;
        return "acme";
      },
    });

    expect(seen.map((entry) => entry.context.origin)).toEqual([FEATURE_ORIGIN, FEATURE_ORIGIN]);
    expect(lookups).toBe(1);
  });

  test("the host flag overrides it, and the account is never asked", async () => {
    const target = await project();
    const seen: { context: SeedPrepareContext; secrets: Record<string, string | undefined> }[] = [];

    await seedProject({
      account: null,
      project: PROJECT,
      projectDir: target.dir,
      env: "feature",
      yes: true,
      host: "preview.example.com",
      workers: [target.worker([capturing(seen)])],
      workersSubdomain: async () => {
        throw new Error("a --host run must not look the subdomain up");
      },
    });

    expect(seen[0]?.context.origin).toBe("https://preview.example.com");
  });

  test("reads the address provisioning stamped when the account has no subdomain to give", async () => {
    const target = await project({ stanza: { name: SCRIPT, vars: { BASE_URL: FEATURE_ORIGIN } } });
    const seen: { context: SeedPrepareContext; secrets: Record<string, string | undefined> }[] = [];

    await seedProject({
      account: null,
      project: PROJECT,
      projectDir: target.dir,
      env: "feature",
      yes: true,
      workers: [target.worker([capturing(seen)])],
      workersSubdomain: async () => null,
    });

    expect(seen[0]?.context.origin).toBe(FEATURE_ORIGIN);
  });

  test("is null for a feature with no address anywhere — never an invented one", async () => {
    const target = await project();
    const seen: { context: SeedPrepareContext; secrets: Record<string, string | undefined> }[] = [];

    await seedProject({
      account: null,
      project: PROJECT,
      projectDir: target.dir,
      env: "feature",
      yes: true,
      workers: [target.worker([capturing(seen)])],
      workersSubdomain: async () => null,
    });

    expect(seen[0]?.context.origin).toBeNull();
  });

  test("a declared environment is handed its own address, through the same resolver", async () => {
    // "A set is never again handed null on an environment with a real address."
    const target = await project({
      tracked: { name: "replay-board", env: { staging: { routes: ["staging.replay.test"] } } },
    });
    const seen: { context: SeedPrepareContext; secrets: Record<string, string | undefined> }[] = [];

    await seedProject({
      account: null,
      project: PROJECT,
      projectDir: target.dir,
      env: "staging",
      yes: true,
      workers: [target.worker([capturing(seen)])],
      workersSubdomain: async () => {
        throw new Error("a declared environment never derives a workers.dev address");
      },
    });

    expect(seen[0]?.context.origin).toBe("https://staging.replay.test");
  });

  test("the host flag reaches dev too, over dev's own scheme", async () => {
    const target = await project();
    const seen: { context: SeedPrepareContext; secrets: Record<string, string | undefined> }[] = [];

    await seedProject({
      account: null,
      project: PROJECT,
      projectDir: target.dir,
      env: "dev",
      host: "localhost:9999",
      workers: [target.worker([capturing(seen)])],
      secret: async () => undefined,
    });

    expect(seen[0]?.context.origin).toBe("http://localhost:9999");
  });

  test("refuses a host that is not one", async () => {
    const target = await project();
    for (const host of ["https://preview.example.com/path", "ftp://preview.example.com", "preview example", ""]) {
      await expect(
        seedProject({
          account: null,
          project: PROJECT,
          projectDir: target.dir,
          env: "feature",
          yes: true,
          host,
          workers: [target.worker([capturing([])])],
          workersSubdomain: async () => "acme",
        }),
        host,
      ).rejects.toSatisfy(
        (error) => error instanceof PithyError && error.payload.message.startsWith("--host takes a host"),
      );
    }
  });

  /**
   * **A feature's seed secrets are its own, and never the dev secrets file's (#643, and #159 unchanged).**
   *
   * The file is planted with a sentinel and made unreadable. A run that so much as opens it fails with
   * `EACCES`; a run that reads it some other way hands the set the sentinel. Neither may happen.
   */
  test("never opens the dev secrets file: mintable secrets are generated for it, supplied ones are absent", async () => {
    const target = await project();
    const path = devSecretsFile(PROJECT);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        "auth-session-secret": { currentVersion: "1", versions: { "1": "DEV-SENTINEL" } },
        "auth-github-credentials": { currentVersion: "1", versions: { "1": "DEV-SENTINEL" } },
      }),
    );
    await chmod(path, 0o000);
    const seen: { context: SeedPrepareContext; secrets: Record<string, string | undefined> }[] = [];

    try {
      await seedProject({
        account: null,
        project: PROJECT,
        projectDir: target.dir,
        env: "feature",
        yes: true,
        workers: [target.worker([capturing(seen, ["first", "second"])])],
        workersSubdomain: async () => "acme",
      });
    } finally {
      await chmod(path, 0o600);
    }

    const [first, second] = seen;
    const generated = first?.secrets["auth-session-secret"];
    expect(generated).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generated).not.toContain("DEV-SENTINEL");
    // One value per run, whichever set asks: two sets signing with two keys would disagree with each other.
    expect(second?.secrets["auth-session-secret"]).toBe(generated);
    // A secret nothing may invent — an OAuth credential — is absent rather than made up or borrowed.
    expect(first?.secrets["auth-github-credentials"]).toBeUndefined();
  });
});

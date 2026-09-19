// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { defineSeed, type SeedPrepareContext } from "@pithy-sh/core/src/seed/seed";
import { defineSecretRegistry } from "@pithy-sh/secrets/src/registry";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { devSecretsFile } from "../devSecrets/location";
import { featureSecretsPath } from "../feature/secrets";
import type { WorkerScope } from "../migrations/run";
import { featureConfigPath } from "../provision/featureConfig";
import { seedHostOrigin } from "./prepare";
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
/** The feature this checkout is, as its branch names it — the key its kept secrets are filed under. */
const FEATURE = { project: PROJECT, issue: "643", slug: "feature-address" };

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
  // What `pithy provision --feature` kept for this feature: the values every set on a feature is handed.
  beforeEach(async () => {
    const kept = featureSecretsPath(FEATURE);
    await mkdir(dirname(kept), { recursive: true });
    await writeFile(
      kept,
      JSON.stringify({ "auth-session-secret": { currentVersion: "1", versions: { "1": "KEPT-AT-PROVISION" } } }),
    );
  });
  afterEach(async () => {
    await rm(featureSecretsPath(FEATURE), { force: true });
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
      featureIdentity: async () => FEATURE,
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
      featureIdentity: async () => FEATURE,
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
      featureIdentity: async () => FEATURE,
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
      featureIdentity: async () => FEATURE,
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
          featureIdentity: async () => FEATURE,
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
   * The dev file is planted with a sentinel and made unreadable. A run that so much as opens it fails with
   * `EACCES`; a run that reads it some other way hands the set the sentinel. Neither may happen. What the set
   * is handed is the value `pithy provision --feature` kept — the one the deployment holds — never a fresh one.
   */
  test("hands a prepared set the feature's kept values, and never opens the dev secrets file", async () => {
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
    const keptPath = featureSecretsPath(FEATURE);
    await mkdir(dirname(keptPath), { recursive: true });
    await writeFile(
      keptPath,
      JSON.stringify({ "auth-session-secret": { currentVersion: "1", versions: { "1": "KEPT-AT-PROVISION" } } }),
    );
    const seen: { context: SeedPrepareContext; secrets: Record<string, string | undefined> }[] = [];

    try {
      for (let run = 0; run < 2; run += 1) {
        await seedProject({
          account: null,
          project: PROJECT,
          projectDir: target.dir,
          env: "feature",
          yes: true,
          workers: [target.worker([capturing(seen, ["first", "second"])])],
          workersSubdomain: async () => "acme",
          featureIdentity: async () => FEATURE,
        });
      }
    } finally {
      await chmod(path, 0o600);
      await rm(keptPath, { force: true });
    }

    // Every set, on every run, the one kept value: two sets or two runs signing with two keys would disagree.
    expect(seen.map((entry) => entry.secrets["auth-session-secret"])).toEqual(Array(4).fill("KEPT-AT-PROVISION"));
    // A secret nothing may invent — an OAuth credential — is absent rather than made up or borrowed.
    expect(seen[0]?.secrets["auth-github-credentials"]).toBeUndefined();
  });

  test("with no kept values on this machine, a set that asks for a secret is refused, naming provision", async () => {
    const target = await project();
    await expect(
      seedProject({
        account: null,
        project: PROJECT,
        projectDir: target.dir,
        env: "feature",
        yes: true,
        workers: [target.worker([capturing([])])],
        workersSubdomain: async () => "acme",
        featureIdentity: async () => ({ ...FEATURE, slug: "never-provisioned" }),
      }),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof PithyError &&
        error.payload.message === "This feature's secrets are not on this machine." &&
        (error.payload.action ?? "").includes("pithy provision --feature"),
    );
  });
});

/**
 * **`--host` names a host, and one rule decides which (#643).** Reproduced: `%2e%2e` passed (the parser decodes
 * it to `..`), a bare `localhost` took `https` on a feature, a port passed here that `featureOrigin` refuses for
 * the same deployment, and `?`, `#` and a trailing `/` were normalized away rather than refused.
 */
describe("seedHostOrigin", () => {
  /** The refusal every bad host gets, by its first words: the flag, and what it takes. */
  const refused = (host: string, env: string): boolean => {
    try {
      seedHostOrigin(host, env);
      return false;
    } catch (error) {
      return error instanceof PithyError && error.payload.message.startsWith("--host takes a host");
    }
  };

  test("takes a bare host or an https origin off dev, over https", () => {
    expect(seedHostOrigin("preview.example.com", "feature")).toBe("https://preview.example.com");
    expect(seedHostOrigin("https://preview.example.com", "feature")).toBe("https://preview.example.com");
    expect(seedHostOrigin("Preview.Example.com", "staging")).toBe("https://preview.example.com");
  });

  test("refuses a host a URL parser would decode, or that has an empty or malformed label", () => {
    for (const host of [
      "%2e%2e",
      "https://%2e%2e",
      "a.%2e%2e.example.com",
      "a..example.com",
      "a_b.example.com",
      "-a.example.com",
      "example.com.",
    ]) {
      expect(refused(host, "feature"), host).toBe(true);
    }
  });

  test("refuses rather than normalizes a path, a query, or a fragment — a trailing slash included", () => {
    for (const host of [
      "https://preview.example.com/",
      "https://preview.example.com/x",
      "https://preview.example.com?",
      "https://preview.example.com?a=1",
      "https://preview.example.com#",
      "preview.example.com/",
      "preview.example.com?",
      "preview.example.com#top",
    ]) {
      expect(refused(host, "feature"), host).toBe(true);
    }
  });

  test("off dev, a port is refused, as featureOrigin refuses one for the same deployment", () => {
    for (const host of [
      "preview.example.com:8443",
      "https://preview.example.com:8443",
      "https://preview.example.com:443",
    ]) {
      expect(refused(host, "feature"), host).toBe(true);
    }
  });

  test("off dev, http is refused: a deployed environment is served over https", () => {
    expect(refused("http://preview.example.com", "feature")).toBe(true);
  });

  test("localhost is dev's alone: over http there, with its port, and refused anywhere deployed", () => {
    expect(seedHostOrigin("localhost:9999", "dev")).toBe("http://localhost:9999");
    expect(seedHostOrigin("localhost", "dev")).toBe("http://localhost");
    expect(seedHostOrigin("127.0.0.1:8787", "dev")).toBe("http://127.0.0.1:8787");
    for (const host of ["localhost", "https://localhost", "localhost:9999", "app.localhost", "127.0.0.1"]) {
      expect(refused(host, "feature"), host).toBe(true);
    }
  });

  test("in dev, a port out of range is refused", () => {
    expect(refused("localhost:0", "dev")).toBe(true);
    expect(refused("localhost:65536", "dev")).toBe(true);
  });

  test("credentials, whitespace, other schemes and nothing at all are refused everywhere", () => {
    for (const env of ["dev", "feature"]) {
      for (const host of [
        "user@preview.example.com",
        "https://u:p@preview.example.com",
        "preview example",
        "ftp://preview.example.com",
        "",
      ]) {
        expect(refused(host, env), `${env} ${host}`).toBe(true);
      }
    }
  });
});

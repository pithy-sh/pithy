// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auth } from "@pithy-sh/auth/src/capability";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  type AttestationModeOptions,
  assertAttestationDeployable,
  assertNoTestAttestation,
  attestationModeOf,
  checkAttestation,
  describeTestAttestation,
} from "./attestationMode";

const API = { name: "api", dir: "/p/apps/api" };
const WEB = { name: "web", dir: "/p/apps/web" };
const IOS = { teamId: "ABCDE12345", bundleId: "com.example.app" };

function authWith(environments: Record<string, { mode: "test" | "enforce" }>): Capability {
  const blocks = Object.fromEntries(
    Object.entries(environments).map(([env, block]) => [env, { ...block, ios: [IOS] }]),
  );
  return auth({ baseURL: "https://api.example.com", attestation: { environments: blocks } });
}

function options(overrides: Partial<AttestationModeOptions> = {}): AttestationModeOptions {
  return {
    workers: [API, WEB],
    environments: ["staging", "prod"],
    productionEnvironments: [],
    composeWorker: async (worker) => ({
      capabilities: worker.name === "api" ? [authWith({ staging: { mode: "test" }, prod: { mode: "test" } })] : [],
    }),
    ...overrides,
  };
}

describe("attestationModeOf", () => {
  test("reads the mode auth's block names for the environment", () => {
    const capabilities = [authWith({ staging: { mode: "test" }, prod: { mode: "enforce" } })];
    expect(attestationModeOf(capabilities, "staging")).toBe("test");
    expect(attestationModeOf(capabilities, "prod")).toBe("enforce");
  });

  test("answers null for an environment with no block, and for a Worker with no auth", () => {
    expect(attestationModeOf([authWith({})], "prod")).toBeNull();
    expect(attestationModeOf([{ name: "auth" } as Capability], "prod")).toBeNull();
    expect(attestationModeOf([], "prod")).toBeNull();
  });
});

describe("checkAttestation", () => {
  test("names a production environment set to test, and only the production one", async () => {
    const check = await checkAttestation(options());
    expect(check).toEqual({ state: "findings", findings: [{ worker: "api", environment: "prod" }] });
    expect(describeTestAttestation(check.findings[0] as never)).toBe(
      "api: prod sets auth's attestation to test, which accepts a test assertion in place of a real app. Set attestation.environments.prod.mode to enforce in apps/api/pithy.config.ts. A production Worker refuses the test assertion anyway, and pithy deploy refuses the environment.",
    );
  });

  test("holds a project's own production names to the same rule", async () => {
    const check = await checkAttestation(
      options({
        environments: ["staging", "live"],
        productionEnvironments: ["live"],
        composeWorker: async () => ({ capabilities: [authWith({ live: { mode: "test" } })] }),
      }),
    );
    expect(check.findings).toEqual([
      { worker: "api", environment: "live" },
      { worker: "web", environment: "live" },
    ]);
  });

  test("is ok when production enforces", async () => {
    const check = await checkAttestation(
      options({ composeWorker: async () => ({ capabilities: [authWith({ prod: { mode: "enforce" } })] }) }),
    );
    expect(check).toEqual({ state: "ok", findings: [] });
  });

  test("says it could not check when a composition throws and nothing was found", async () => {
    const check = await checkAttestation(
      options({
        composeWorker: async () => {
          throw new Error("config throws");
        },
      }),
    );
    expect(check).toEqual({ state: "could-not-check", findings: [] });
  });
});

describe("assertNoTestAttestation", () => {
  test("refuses to deploy a production environment set to test, naming the Worker", async () => {
    const refused = await assertNoTestAttestation({ ...options(), environment: "prod" }).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(PithyError);
    expect((refused as PithyError).payload).toMatchObject({
      code: "core/precondition_failed",
      message: "prod sets attestation to test: api.",
    });
  });

  test("lets staging set to test deploy", async () => {
    await expect(assertNoTestAttestation({ ...options(), environment: "staging" })).resolves.toBeUndefined();
  });

  test("refuses nothing it could not compose", async () => {
    await expect(
      assertNoTestAttestation({
        ...options(),
        environment: "prod",
        composeWorker: async () => {
          throw new Error("config throws");
        },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("assertAttestationDeployable", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-attestation-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A project with one Worker whose auth-shaped capability sets each environment's mode as given. */
  async function project(modes: Record<string, string>, productionEnvironments: string[] = []): Promise<void> {
    await writeFile(
      join(dir, "pithy.config.ts"),
      `export default { name: "replay", environments: ["staging", "prod", "live"], seed: { productionEnvironments: ${JSON.stringify(productionEnvironments)} } };\n`,
    );
    const workerDir = join(dir, "apps", "api");
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "wrangler.jsonc"), '{ "name": "replay-api" }\n');
    await writeFile(join(workerDir, "pithy.worker.jsonc"), '{ "dev": {} }\n');
    const environments = Object.fromEntries(Object.entries(modes).map(([env, mode]) => [env, { mode }]));
    await writeFile(
      join(workerDir, "pithy.config.ts"),
      `export default { capabilities: [{ name: "auth", requiredBindings: [], authConfig: { attestation: { environments: ${JSON.stringify(environments)} } } }] };\n`,
    );
  }

  test("refuses pithy deploy --env prod when prod is set to test", async () => {
    await project({ prod: "test" });
    const failure = await assertAttestationDeployable(dir, "prod").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.message).toBe("prod sets attestation to test: api.");
  });

  test("refuses a project's own production name too", async () => {
    await project({ live: "test" }, ["live"]);
    await expect(assertAttestationDeployable(dir, "live")).rejects.toThrow(/live sets attestation to test/);
  });

  test("deploys staging set to test, and prod set to enforce", async () => {
    await project({ staging: "test", prod: "enforce" });
    await expect(assertAttestationDeployable(dir, "staging")).resolves.toBeUndefined();
    await expect(assertAttestationDeployable(dir, "prod")).resolves.toBeUndefined();
  });
});

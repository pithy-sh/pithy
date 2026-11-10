// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { writeCapabilityTestBindings } from "./capabilityTestBindings";
import { WORKERS_TEST_CONFIG } from "./workersTestConfig";
import { WORKERS_TEST_ENV } from "./workersTestEnv";

const STARTER = join(dirname(fileURLToPath(import.meta.url)), "../../../../templates/starter");
const TEMPLATE = readFileSync(join(STARTER, WORKERS_TEST_CONFIG), "utf8");
const ENV_TEMPLATE = readFileSync(join(STARTER, "apps/api", WORKERS_TEST_ENV), "utf8");

describe("writeCapabilityTestBindings", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-capability-test-bindings-"));
    await writeFile(join(dir, WORKERS_TEST_CONFIG), TEMPLATE);
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, WORKERS_TEST_ENV), ENV_TEMPLATE);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const controlplane = {
    name: "controlplane",
    requiredBindings: [
      { type: "d1" as const, name: "DB", optional: false },
      { type: "kv" as const, name: "CONTROL_PLANE", optional: true },
    ],
    testBindings: [
      { kind: "d1" as const, name: "DB" },
      { kind: "kv" as const, name: "CONTROL_PLANE" },
    ],
  };

  /** The project and the Worker share one directory here; the Env declaration sits under its `src/`. */
  const write: (
    manifest: Parameters<typeof writeCapabilityTestBindings>[0]["manifest"],
    composed: Parameters<typeof writeCapabilityTestBindings>[0]["composed"],
  ) => Promise<string[]> = (manifest, composed) =>
    writeCapabilityTestBindings({ projectDir: dir, workerDir: dir, manifest, composed });

  test("writes the bindings into the Workers test config and the Worker's Env declaration", async () => {
    await write(
      {
        name: "secrets",
        requiredBindings: [{ type: "d1", name: "SECRETS" }],
        testBindings: [{ kind: "d1", name: "SECRETS" }],
      },
      async () => undefined,
    );
    expect(await readFile(join(dir, WORKERS_TEST_CONFIG), "utf8")).toContain('d1Databases: ["DB", "SECRETS"],');
    expect(await readFile(join(dir, WORKERS_TEST_ENV), "utf8")).toContain("    SECRETS: D1Database;\n");
  });

  test("writes an optional binding the composed capability requires", async () => {
    const composed = async () => ({ requiredBindings: [{ type: "kv" as const, name: "CONTROL_PLANE" }] });
    await write(controlplane, composed);
    expect(await readFile(join(dir, WORKERS_TEST_CONFIG), "utf8")).toContain(
      'kvNamespaces: ["SESSIONS", "CONTROL_PLANE"],',
    );
  });

  test("leaves it out when the composed capability does not require it, or cannot be built", async () => {
    await write(controlplane, async () => ({ requiredBindings: [] }));
    await write(controlplane, async () => {
      throw new Error("Cannot find module '@pithy-sh/core/src/index'");
    });
    expect(await readFile(join(dir, WORKERS_TEST_CONFIG), "utf8")).toBe(TEMPLATE);
  });

  test("notes an unbound binding only when it applies", async () => {
    const support = {
      name: "support",
      requiredBindings: [{ type: "ai" as const, name: "AI", optional: true }],
      testBindings: [{ kind: "unbound" as const, name: "AI" }],
    };
    expect(await write(support, async () => ({ requiredBindings: [] }))).toEqual([]);
    expect(
      await write(support, async () => ({
        requiredBindings: [{ type: "ai" as const, name: "AI" }],
      })),
    ).toEqual([
      "support: vitest.workers.config.ts cannot bind AI. A Workers test that sends a request through the Worker's fetch answers 500 without it.",
    ]);
  });

  test("builds no composed capability for a manifest with no optional test binding", async () => {
    let built = false;
    const secrets = {
      name: "secrets",
      requiredBindings: [{ type: "d1" as const, name: "SECRETS", optional: false }],
      testBindings: [{ kind: "d1" as const, name: "SECRETS" }],
    };
    await write(secrets, async () => {
      built = true;
      return undefined;
    });
    expect(built).toBe(false);
    expect(await readFile(join(dir, WORKERS_TEST_CONFIG), "utf8")).toContain('d1Databases: ["DB", "SECRETS"],');
  });
});

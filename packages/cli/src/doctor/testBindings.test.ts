// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WORKERS_TEST_CONFIG, writeTestBindings } from "../project/workersTestConfig";
import { checkTestBindings, describeTestBindings } from "./testBindings";

const TEMPLATE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../../templates/starter", WORKERS_TEST_CONFIG),
  "utf8",
);

const secrets = CapabilityManifest.parse({
  name: "secrets",
  package: "@pithy-sh/secrets",
  requiredBindings: [],
  testBindings: [
    { kind: "d1", name: "SECRETS" },
    {
      kind: "value",
      name: "SECRETS_ENCRYPTION_KEYS",
      module: "@pithy-sh/secrets/src/test-utils/devEncryptionKeys",
      export: "devEncryptionKeys",
    },
  ],
});
const email = CapabilityManifest.parse({
  name: "email",
  package: "@pithy-sh/email",
  requiredBindings: [],
  testBindings: [
    { kind: "d1", name: "DB" },
    { kind: "unbound", name: "EMAIL_SENDER" },
  ],
});

const readManifests = async () => ({ manifests: [secrets, email], faults: [] });
const worker = (name: string, capabilities: string[]) => ({
  name,
  dir: name,
  capabilities: capabilities.map((capability) => ({ name: capability })),
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-doctor-test-bindings-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("checkTestBindings", () => {
  test("names a composed capability whose test bindings the Workers config lacks, and the Workers composing it", async () => {
    await writeFile(join(dir, WORKERS_TEST_CONFIG), TEMPLATE);
    const check = await checkTestBindings({
      projectDir: dir,
      workers: [worker("api", ["secrets", "email", "app"]), worker("admin", ["secrets"])],
      readManifests,
    });
    expect(check).toEqual({
      state: "missing",
      missing: [
        {
          capability: "secrets",
          workers: ["api", "admin"],
          bindings: ["SECRETS", "SECRETS_ENCRYPTION_KEYS"],
          incomplete: [],
          fix: "pithy add secrets --worker api",
        },
      ],
    });
    expect(describeTestBindings(check)).toEqual([
      "secrets (api, admin): SECRETS, SECRETS_ENCRYPTION_KEYS missing from vitest.workers.config.ts.",
    ]);
  });

  test("is quiet once the config provides them", async () => {
    const provided = TEMPLATE.replace('d1Databases: ["DB"],', 'd1Databases: ["DB", "SECRETS"],').replace(
      'kvNamespaces: ["SESSIONS"],',
      'kvNamespaces: ["SESSIONS"],\n        bindings: { SECRETS_ENCRYPTION_KEYS: devEncryptionKeys() },',
    );
    await writeFile(join(dir, WORKERS_TEST_CONFIG), provided);
    const check = await checkTestBindings({ projectDir: dir, workers: [worker("api", ["secrets"])], readManifests });
    expect(check).toEqual({ state: "ok", missing: [] });
    expect(describeTestBindings(check)).toEqual([]);
  });

  test("reads an optional binding as missing only where the composed capability requires it", async () => {
    const controlplane = CapabilityManifest.parse({
      name: "controlplane",
      package: "@pithy-sh/core",
      requiredBindings: [{ type: "kv", name: "CONTROL_PLANE", optional: true }],
      testBindings: [{ kind: "kv", name: "CONTROL_PLANE" }],
    });
    await writeFile(join(dir, WORKERS_TEST_CONFIG), TEMPLATE);
    const composing = (requiredBindings: { type: "kv"; name: string }[]) => ({
      name: "api",
      dir: "api",
      capabilities: [{ name: "controlplane", requiredBindings }],
    });
    const read = async () => ({ manifests: [controlplane], faults: [] });
    const d1 = await checkTestBindings({ projectDir: dir, workers: [composing([])], readManifests: read });
    expect(d1).toEqual({ state: "ok", missing: [] });
    const kv = await checkTestBindings({
      projectDir: dir,
      workers: [composing([{ type: "kv", name: "CONTROL_PLANE" }])],
      readManifests: read,
    });
    expect(kv.missing.map(({ capability, bindings }) => [capability, bindings])).toEqual([
      ["controlplane", ["CONTROL_PLANE"]],
    ]);
  });

  test("names a rate limiter stated without a namespace_id, with the add that fills it in, until that add runs", async () => {
    const auth = CapabilityManifest.parse({
      name: "auth",
      package: "@pithy-sh/auth",
      requiredBindings: [],
      testBindings: [{ kind: "ratelimit", name: "AUTH_RATE_LIMITER", limit: 100, period: 60 }],
    });
    const read = async () => ({ manifests: [auth], faults: [] });
    const stale = TEMPLATE.replace(
      'kvNamespaces: ["SESSIONS"],',
      'kvNamespaces: ["SESSIONS"],\n        ratelimits: { AUTH_RATE_LIMITER: { simple: { limit: 100, period: 60 } } },',
    );
    await writeFile(join(dir, WORKERS_TEST_CONFIG), stale);
    const workers = [worker("app-a", ["auth"]), worker("app-b", ["auth"])];
    const check = await checkTestBindings({ projectDir: dir, workers, readManifests: read });
    expect(check).toEqual({
      state: "missing",
      missing: [
        {
          capability: "auth",
          workers: ["app-a", "app-b"],
          bindings: [],
          incomplete: ["AUTH_RATE_LIMITER"],
          fix: "pithy add auth --worker app-a --with-prerequisites",
        },
      ],
    });
    expect(describeTestBindings(check)).toEqual([
      "auth (app-a, app-b): AUTH_RATE_LIMITER in vitest.workers.config.ts has no namespace_id.",
    ]);

    await writeTestBindings(dir, "auth", auth.testBindings);
    expect(await checkTestBindings({ projectDir: dir, workers, readManifests: read })).toEqual({
      state: "ok",
      missing: [],
    });
  });

  test("names a missing binding and an incomplete one in one line", () => {
    expect(
      describeTestBindings({
        state: "missing",
        missing: [{ capability: "auth", workers: ["api"], bindings: ["DB"], incomplete: ["LIMITER"], fix: null }],
      }),
    ).toEqual([
      "auth (api): DB missing from vitest.workers.config.ts. LIMITER in vitest.workers.config.ts has no namespace_id.",
    ]);
  });

  test("asks nothing of a project with no Workers test config", async () => {
    const check = await checkTestBindings({ projectDir: dir, workers: [worker("api", ["secrets"])], readManifests });
    expect(check).toEqual({ state: "ok", missing: [] });
  });
});

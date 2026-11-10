// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestBinding } from "@pithy-sh/core/src/capability/testBinding";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  missingTestBindings,
  removeTestBindings,
  STARTER_TEST_BINDINGS,
  WORKERS_TEST_CONFIG,
  withoutTestBindings,
  withTestBindings,
  writeTestBindings,
} from "./workersTestConfig";

const TEMPLATE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../../templates/starter", WORKERS_TEST_CONFIG),
  "utf8",
);

const MASTER_KEY: TestBinding = {
  kind: "value",
  name: "SECRETS_ENCRYPTION_KEYS",
  module: "@pithy-sh/secrets/src/test-utils/devEncryptionKeys",
  export: "devEncryptionKeys",
};
const SECRETS: TestBinding[] = [{ kind: "d1", name: "SECRETS" }, MASTER_KEY];

describe("withTestBindings", () => {
  test("adds a D1 to the scaffolded config's list, and a value with its import", () => {
    const { source, written } = withTestBindings(TEMPLATE, SECRETS);
    expect(written).toEqual(["SECRETS", "SECRETS_ENCRYPTION_KEYS"]);
    expect(source).toContain('d1Databases: ["DB", "SECRETS"],');
    expect(source).toContain("bindings: { SECRETS_ENCRYPTION_KEYS: devEncryptionKeys() },");
    // Sorted among the imports, the order Biome's import organizer keeps.
    expect(source).toMatch(
      /^import \{ cloudflareTest \} from "@cloudflare\/vitest-plugin";\nimport \{ devEncryptionKeys \} from "@pithy-sh\/secrets\/src\/test-utils\/devEncryptionKeys";\nimport \{ defineConfig \} from "vitest\/config";\n/,
    );
  });

  test("changes nothing on a second run", () => {
    const once = withTestBindings(TEMPLATE, SECRETS).source;
    const twice = withTestBindings(once, SECRETS);
    expect(twice.source).toBe(once);
    expect(twice.written).toEqual([]);
  });

  test("leaves a binding already present as the adopter wrote it", () => {
    const { source, written } = withTestBindings(TEMPLATE, [{ kind: "d1", name: "DB" }]);
    expect(source).toBe(TEMPLATE);
    expect(written).toEqual([]);
  });

  test("adds a new property for a kind the config does not list yet", () => {
    const { source } = withTestBindings(TEMPLATE, [
      { kind: "r2", name: "MEDIA_BUCKET" },
      { kind: "ratelimit", name: "AUTH_RATE_LIMITER", limit: 100, period: 60 },
    ]);
    expect(source).toContain('        kvNamespaces: ["SESSIONS"],\n        r2Buckets: ["MEDIA_BUCKET"],\n');
    expect(source).toContain("        ratelimits: { AUTH_RATE_LIMITER: { simple: { limit: 100, period: 60 } } },\n");
  });

  test("adds to an object property already there", () => {
    const config = TEMPLATE.replace(
      'kvNamespaces: ["SESSIONS"],',
      'kvNamespaces: ["SESSIONS"],\n        bindings: { OTHER: "x" },',
    );
    const { source } = withTestBindings(config, [MASTER_KEY]);
    expect(source).toContain('bindings: { OTHER: "x", SECRETS_ENCRYPTION_KEYS: devEncryptionKeys() },');
  });

  test("adds to an empty list, and to a list written one entry per line", () => {
    expect(
      withTestBindings(TEMPLATE.replace('["SESSIONS"]', "[]"), [{ kind: "kv", name: "MATCHMAKING" }]).source,
    ).toContain('kvNamespaces: ["MATCHMAKING"],');
    const expanded = TEMPLATE.replace('d1Databases: ["DB"],', 'd1Databases: [\n          "DB",\n        ],');
    expect(withTestBindings(expanded, [{ kind: "d1", name: "SECRETS" }]).source).toContain(
      'd1Databases: [\n          "DB",\n          "SECRETS",\n        ],',
    );
  });

  test("reads past a commented-out binding", () => {
    const config = TEMPLATE.replace(
      'd1Databases: ["DB"],',
      '// d1Databases: ["SECRETS"],\n        d1Databases: ["DB"],',
    );
    expect(withTestBindings(config, [{ kind: "d1", name: "SECRETS" }]).source).toContain(
      'd1Databases: ["DB", "SECRETS"],',
    );
  });

  test("reads past a binding commented out inside the list", () => {
    const commented = TEMPLATE.replace('d1Databases: ["DB"]', 'd1Databases: ["DB" /* , "SECRETS" */]');
    const { source, written } = withTestBindings(commented, SECRETS);
    expect(written).toEqual(["SECRETS", "SECRETS_ENCRYPTION_KEYS"]);
    expect(source).toContain('d1Databases: ["DB", "SECRETS" /* , "SECRETS" */],');
  });

  test("counts a name only as an element or a key, never as another entry's value", () => {
    const valued = TEMPLATE.replace('d1Databases: ["DB"]', 'd1Databases: { DB: "SECRETS" }');
    expect(withTestBindings(valued, [{ kind: "d1", name: "SECRETS" }]).written).toEqual(["SECRETS"]);
  });

  test("adds a list kind to an option written as an object, as a key naming its id", () => {
    const pinned = TEMPLATE.replace('d1Databases: ["DB"]', 'd1Databases: { DB: "db" }');
    const { source } = withTestBindings(pinned, [{ kind: "d1", name: "SECRETS" }]);
    expect(source).toContain('d1Databases: { DB: "db", SECRETS: "SECRETS" },');
    expect(withTestBindings(source, [{ kind: "d1", name: "SECRETS" }]).source).toBe(source);
    expect(withoutTestBindings(source, [{ kind: "d1", name: "SECRETS" }]).source).toBe(pinned);
  });

  test("states nothing for an unbound binding", () => {
    const { source, written } = withTestBindings(TEMPLATE, [{ kind: "unbound", name: "QUEUE" }]);
    expect(source).toBe(TEMPLATE);
    expect(written).toEqual([]);
  });

  test("reports what it could not place in a config with no miniflare block", () => {
    const config = 'export default { test: { name: "workers" } };\n';
    const { source, written, unplaced } = withTestBindings(config, SECRETS);
    expect(source).toBe(config);
    expect(written).toEqual([]);
    expect(unplaced).toEqual(["SECRETS", "SECRETS_ENCRYPTION_KEYS"]);
  });
});

describe("missingTestBindings", () => {
  test("names the bindings the config does not provide, and never an unbound one", () => {
    const declared: TestBinding[] = [{ kind: "d1", name: "DB" }, ...SECRETS, { kind: "unbound", name: "QUEUE" }];
    expect(missingTestBindings(TEMPLATE, declared).map((binding) => binding.name)).toEqual([
      "SECRETS",
      "SECRETS_ENCRYPTION_KEYS",
    ]);
    expect(missingTestBindings(withTestBindings(TEMPLATE, SECRETS).source, declared)).toEqual([]);
  });

  test("does not count a binding commented out inside the list", () => {
    const commented = TEMPLATE.replace('d1Databases: ["DB"]', 'd1Databases: ["DB" /* , "SECRETS" */]');
    expect(missingTestBindings(commented, SECRETS).map((binding) => binding.name)).toEqual([
      "SECRETS",
      "SECRETS_ENCRYPTION_KEYS",
    ]);
  });
});

describe("writeTestBindings", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-test-bindings-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("writes the project's Workers test config", async () => {
    await writeFile(join(dir, WORKERS_TEST_CONFIG), TEMPLATE);
    expect(await writeTestBindings(dir, "secrets", SECRETS)).toEqual([]);
    expect(await readFile(join(dir, WORKERS_TEST_CONFIG), "utf8")).toContain('d1Databases: ["DB", "SECRETS"],');
  });

  test("notes a binding no test config can provide", async () => {
    await writeFile(join(dir, WORKERS_TEST_CONFIG), TEMPLATE);
    const notes = await writeTestBindings(dir, "email", [{ kind: "unbound", name: "EMAIL_SENDER" }]);
    expect(notes).toEqual([
      "email: vitest.workers.config.ts cannot bind EMAIL_SENDER. A Workers test that sends a request through the Worker's fetch answers 500 without it.",
    ]);
  });

  test("notes what to add by hand to a config it cannot read", async () => {
    await writeFile(join(dir, WORKERS_TEST_CONFIG), "export default {};\n");
    expect(await writeTestBindings(dir, "secrets", SECRETS)).toEqual([
      "secrets: add SECRETS, SECRETS_ENCRYPTION_KEYS to the miniflare options in vitest.workers.config.ts. No miniflare block was found to write them into.",
    ]);
  });

  test("writes nothing to a project with no Workers test config", async () => {
    expect(await writeTestBindings(dir, "secrets", SECRETS)).toEqual([]);
  });

  test("declares the package a value binding imports as a root devDependency, and syncs the lockfile", async () => {
    await workspace(dir);
    await writeFile(join(dir, WORKERS_TEST_CONFIG), TEMPLATE);
    const synced: string[] = [];

    await writeTestBindings(dir, "secrets", SECRETS, async (projectDir) => {
      synced.push(projectDir);
    });

    const root = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    expect(root.devDependencies).toEqual({ "@pithy-sh/secrets": "^0.6.8", vitest: "^4.1.0" });
    expect(root.dependencies).toBeUndefined();
    expect(synced).toEqual([dir]);
  });

  test("a re-run on a config that already binds the value declares its package at a root that lacks it", async () => {
    await workspace(dir);
    const bound = withTestBindings(TEMPLATE, SECRETS).source;
    await writeFile(join(dir, WORKERS_TEST_CONFIG), bound);
    const synced: string[] = [];

    expect(
      await writeTestBindings(dir, "secrets", SECRETS, async (projectDir) => {
        synced.push(projectDir);
      }),
    ).toEqual([]);

    expect(await readFile(join(dir, WORKERS_TEST_CONFIG), "utf8")).toBe(bound);
    const root = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    expect(root.devDependencies).toEqual({ "@pithy-sh/secrets": "^0.6.8", vitest: "^4.1.0" });
    expect(synced).toEqual([dir]);
  });
});

/** A Bun workspace whose `apps/board` member declares `@pithy-sh/secrets`, and whose root does not. */
async function workspace(dir: string): Promise<void> {
  await writeFile(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "replay", workspaces: ["apps/*"], devDependencies: { vitest: "^4.1.0" } }, null, 2)}\n`,
  );
  await mkdir(join(dir, "apps", "board"), { recursive: true });
  await writeFile(
    join(dir, "apps", "board", "package.json"),
    JSON.stringify({ name: "board", dependencies: { "@pithy-sh/secrets": "^0.6.8" } }),
  );
}

describe("withoutTestBindings", () => {
  const MEDIA: TestBinding[] = [
    { kind: "r2", name: "MEDIA_BUCKET" },
    { kind: "ratelimit", name: "AUTH_RATE_LIMITER", limit: 100, period: 60 },
  ];

  test("undoes what withTestBindings wrote, import included", () => {
    for (const bindings of [SECRETS, MEDIA, [...SECRETS, ...MEDIA]]) {
      const added = withTestBindings(TEMPLATE, bindings).source;
      const { source, removed } = withoutTestBindings(added, bindings);
      expect(source).toBe(TEMPLATE);
      expect(removed).toEqual(bindings.map((binding) => binding.name));
    }
  });

  test("keeps the starter's own bindings", () => {
    const starter: TestBinding[] = [
      { kind: "d1", name: "DB" },
      { kind: "kv", name: "SESSIONS" },
    ];
    expect(starter.map((binding) => binding.name)).toEqual(STARTER_TEST_BINDINGS);
    expect(missingTestBindings(TEMPLATE, starter)).toEqual([]);
    expect(withoutTestBindings(TEMPLATE, starter)).toEqual({ source: TEMPLATE, removed: [] });
  });

  test("takes one entry out of a list, inline or one per line, and keeps the rest", () => {
    expect(withoutTestBindings('miniflare: { d1Databases: ["SECRETS", "DB"] }', SECRETS).source).toBe(
      'miniflare: { d1Databases: ["DB"] }',
    );
    const lines = 'miniflare: {\n  d1Databases: [\n    "DB",\n    "SECRETS",\n    "APP",\n  ],\n}';
    expect(withoutTestBindings(lines, SECRETS).source).toBe(
      'miniflare: {\n  d1Databases: [\n    "DB",\n    "APP",\n  ],\n}',
    );
  });

  test("keeps an import something else still uses", () => {
    const added = withTestBindings(TEMPLATE, SECRETS).source.replace(
      "SECRETS_ENCRYPTION_KEYS: devEncryptionKeys()",
      "SECRETS_ENCRYPTION_KEYS: devEncryptionKeys(), OTHER_KEYS: devEncryptionKeys()",
    );
    const { source } = withoutTestBindings(added, SECRETS);
    expect(source).toContain('import { devEncryptionKeys } from "@pithy-sh/secrets/src/test-utils/devEncryptionKeys";');
    expect(source).toContain("bindings: { OTHER_KEYS: devEncryptionKeys() },");
  });

  test("reads past a commented-out binding and changes nothing the config does not state", () => {
    const commented = TEMPLATE.replace('d1Databases: ["DB"]', 'd1Databases: ["DB" /* , "SECRETS" */]');
    expect(withoutTestBindings(commented, SECRETS)).toEqual({ source: commented, removed: [] });
    expect(withoutTestBindings("export default {};\n", SECRETS).removed).toEqual([]);
  });
});

describe("removeTestBindings", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-workers-config-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("rewrites the project's Workers test config", async () => {
    await writeFile(join(dir, WORKERS_TEST_CONFIG), withTestBindings(TEMPLATE, SECRETS).source);
    expect(await removeTestBindings(dir, SECRETS)).toEqual(["SECRETS", "SECRETS_ENCRYPTION_KEYS"]);
    expect(await readFile(join(dir, WORKERS_TEST_CONFIG), "utf8")).toBe(TEMPLATE);
  });

  test("takes out the root devDependency once nothing imports the package", async () => {
    await workspace(dir);
    await writeFile(join(dir, WORKERS_TEST_CONFIG), TEMPLATE);
    const sync = async () => {};
    await writeTestBindings(dir, "secrets", SECRETS, sync);

    await removeTestBindings(dir, SECRETS, sync);

    const root = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    expect(root.devDependencies).toEqual({ vitest: "^4.1.0" });
  });

  test("leaves a project with no Workers test config alone", async () => {
    expect(await removeTestBindings(dir, SECRETS)).toEqual([]);
  });
});

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
  removeEnvBindings,
  WORKERS_TEST_ENV,
  withEnvBindings,
  withoutEnvBindings,
  writeEnvBindings,
} from "./workersTestEnv";

const TEMPLATE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../../templates/starter", "apps/api", WORKERS_TEST_ENV),
  "utf8",
);

const SECRETS: TestBinding[] = [
  { kind: "d1", name: "SECRETS" },
  {
    kind: "value",
    name: "SECRETS_ENCRYPTION_KEYS",
    module: "@pithy-sh/secrets/src/test-utils/devEncryptionKeys",
    export: "devEncryptionKeys",
  },
];

describe("withEnvBindings", () => {
  test("declares each stated binding on the scaffolded Env, typed by its kind", () => {
    const source = withEnvBindings(TEMPLATE, [
      ...SECRETS,
      { kind: "kv", name: "MATCHMAKING" },
      { kind: "r2", name: "MEDIA_BUCKET" },
      { kind: "ratelimit", name: "AUTH_RATE_LIMITER", limit: 100, period: 60 },
      { kind: "unbound", name: "PRESENCE_ROOMS" },
    ]);
    expect(source).toContain(
      [
        "  interface Env {",
        "    DB: D1Database;",
        "    SESSIONS: KVNamespace;",
        "    SECRETS: D1Database;",
        "    SECRETS_ENCRYPTION_KEYS: string;",
        "    MATCHMAKING: KVNamespace;",
        "    MEDIA_BUCKET: R2Bucket;",
        "    AUTH_RATE_LIMITER: RateLimit;",
        "  }",
      ].join("\n"),
    );
    expect(source).not.toContain("PRESENCE_ROOMS");
  });

  test("changes nothing on a second run, or for a binding already declared", () => {
    const once = withEnvBindings(TEMPLATE, SECRETS);
    expect(withEnvBindings(once, SECRETS)).toBe(once);
    expect(withEnvBindings(TEMPLATE, [{ kind: "d1", name: "DB" }])).toBe(TEMPLATE);
  });

  test("reads past a commented-out member, and fills an empty interface", () => {
    const commented = TEMPLATE.replace("    DB: D1Database;", "    // SECRETS: D1Database;\n    DB: D1Database;");
    expect(withEnvBindings(commented, SECRETS)).toContain("    SECRETS: D1Database;\n    SECRETS_ENCRYPTION_KEYS");
    expect(withEnvBindings("declare namespace Cloudflare {\n  interface Env {}\n}\n", SECRETS)).toBe(
      "declare namespace Cloudflare {\n  interface Env {\n    SECRETS: D1Database;\n    SECRETS_ENCRYPTION_KEYS: string;\n  }\n}\n",
    );
  });

  test("leaves a file with no Env interface alone", () => {
    expect(withEnvBindings("export {};\n", SECRETS)).toBe("export {};\n");
  });
});

describe("withoutEnvBindings", () => {
  test("undoes withEnvBindings and keeps the starter's own members", () => {
    expect(withoutEnvBindings(withEnvBindings(TEMPLATE, SECRETS), SECRETS)).toBe(TEMPLATE);
    expect(withoutEnvBindings(TEMPLATE, [{ kind: "d1", name: "DB" }])).toBe(TEMPLATE);
  });
});

describe("writeEnvBindings and removeEnvBindings", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-test-env-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("rewrite the Worker's declaration, and leave a Worker with none alone", async () => {
    await writeEnvBindings(dir, SECRETS);
    await removeEnvBindings(dir, SECRETS);
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, WORKERS_TEST_ENV), TEMPLATE);
    await writeEnvBindings(dir, SECRETS);
    expect(await readFile(join(dir, WORKERS_TEST_ENV), "utf8")).toContain("    SECRETS: D1Database;\n");
    await removeEnvBindings(dir, SECRETS);
    expect(await readFile(join(dir, WORKERS_TEST_ENV), "utf8")).toBe(TEMPLATE);
  });
});

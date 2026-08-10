// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SecretRegistry } from "@pithy-sh/secrets/src/registry";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { DevSecretsTarget } from "../devSecrets/targets";
import { checkSecretBindings, describeSecretBindings } from "./secretBindings";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-secret-bindings-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A registry with one bindable secret, one D1 secret, and one keyspace. */
const REGISTRY: SecretRegistry = {
  SECRETS_ENCRYPTION_KEYS: {
    backend: "cf-secrets-store",
    scope: "environment",
    rotatable: true,
    valueType: "text",
    bootstrap: true,
  },
  CONNECTION_KEY_ENCRYPTION_KEY: {
    backend: "cf-secrets-store",
    scope: "environment",
    rotatable: true,
    valueType: "text",
  },
  // Lives as a row in the environment's secrets database — never a binding.
  WEBHOOK_SIGNING_KEY: { backend: "d1", scope: "environment", rotatable: true, valueType: "text" },
  // A keyspace has no single value, so no single entry to bind.
  TENANT_CREDENTIALS: {
    backend: "cf-secrets-store",
    scope: "environment",
    rotatable: false,
    valueType: "text",
    keyed: true,
  },
};

/** One Worker under `apps/<name>`, with the env stanzas its `wrangler.jsonc` declares. */
async function worker(name: string, env: Record<string, unknown>): Promise<DevSecretsTarget> {
  const workerDir = join(dir, "apps", name);
  await mkdir(workerDir, { recursive: true });
  await writeFile(join(workerDir, "wrangler.jsonc"), JSON.stringify({ name: `replay-${name}`, env }, null, 2));
  return { name, dir: workerDir, registry: REGISTRY };
}

const ENTRY = (binding: string) => ({ binding, store_id: "store-1", secret_name: `replay-prod-${binding}` });

describe("checkSecretBindings", () => {
  test("names every cf-secrets-store secret a deployed stanza has no binding for", async () => {
    const target = await worker("board", {
      staging: {},
      prod: { secrets_store_secrets: [ENTRY("SECRETS_ENCRYPTION_KEYS")] },
    });
    const check = await checkSecretBindings({ projectDir: dir, targets: [target], environments: ["staging", "prod"] });
    expect(check?.state).toBe("unbound");
    expect(check?.missing).toEqual([
      { worker: "board", env: "staging", binding: "CONNECTION_KEY_ENCRYPTION_KEY" },
      { worker: "board", env: "staging", binding: "SECRETS_ENCRYPTION_KEYS" },
      { worker: "board", env: "prod", binding: "CONNECTION_KEY_ENCRYPTION_KEY" },
    ]);
  });

  test("a stanza binding everything it declares is ok", async () => {
    const bound = { secrets_store_secrets: [ENTRY("SECRETS_ENCRYPTION_KEYS"), ENTRY("CONNECTION_KEY_ENCRYPTION_KEY")] };
    const target = await worker("board", { prod: bound });
    expect(await checkSecretBindings({ projectDir: dir, targets: [target], environments: ["prod"] })).toEqual({
      state: "ok",
      missing: [],
    });
  });

  /** A `d1` secret is a row and a keyspace has no single entry. Neither is ever a binding. */
  test("a d1 secret and a keyspace are never reported as unbound", async () => {
    const bound = { secrets_store_secrets: [ENTRY("SECRETS_ENCRYPTION_KEYS"), ENTRY("CONNECTION_KEY_ENCRYPTION_KEY")] };
    const target = await worker("board", { prod: bound });
    const check = await checkSecretBindings({ projectDir: dir, targets: [target], environments: ["prod"] });
    expect(check?.missing.map((entry) => entry.binding)).toEqual([]);
  });

  /**
   * `dev` is not among the environments a project declares, and that is the point: local dev
   * materialises every `cf-secrets-store` secret into the generated `.dev.vars` (#179), so a stanza
   * there would name entries a local run never reads.
   */
  test("only the environments the project declares, which never include dev", async () => {
    const target = await worker("board", {
      prod: { secrets_store_secrets: [ENTRY("SECRETS_ENCRYPTION_KEYS"), ENTRY("CONNECTION_KEY_ENCRYPTION_KEY")] },
    });
    const check = await checkSecretBindings({ projectDir: dir, targets: [target], environments: ["prod"] });
    expect(check?.state).toBe("ok");
  });

  test("a Worker with no stanza for a declared environment is missing every binding there", async () => {
    const target = await worker("board", {});
    const check = await checkSecretBindings({ projectDir: dir, targets: [target], environments: ["prod"] });
    expect(check?.missing.map((entry) => entry.binding)).toEqual([
      "CONNECTION_KEY_ENCRYPTION_KEY",
      "SECRETS_ENCRYPTION_KEYS",
    ]);
  });

  test("a project where no Worker composes secrets has no answer to give", async () => {
    expect(await checkSecretBindings({ projectDir: dir, targets: [], environments: ["prod"] })).toBeNull();
  });

  /**
   * A Worker whose `pithy.config.ts` would not import is exactly the one that might have declared the
   * secret this would otherwise report as unbound. "Binds no X" is a negative claim about a registry
   * nobody read, so the whole check declines rather than answering confidently (#199).
   */
  test("a config nobody could import makes this decline rather than claim ok", async () => {
    const target = await worker("board", {
      prod: { secrets_store_secrets: [ENTRY("SECRETS_ENCRYPTION_KEYS"), ENTRY("CONNECTION_KEY_ENCRYPTION_KEY")] },
    });
    expect(
      await checkSecretBindings({
        projectDir: dir,
        targets: [target],
        unresolvable: [{ name: "web", dir: "apps/web", reason: "cannot import" }],
        environments: ["prod"],
      }),
    ).toEqual({ state: "could-not-check", missing: [] });
  });

  test("a wrangler.jsonc nobody could read establishes nothing", async () => {
    const workerDir = join(dir, "apps", "board");
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "wrangler.jsonc"), "{ not json");
    const check = await checkSecretBindings({
      projectDir: dir,
      targets: [{ name: "board", dir: workerDir, registry: REGISTRY }],
      environments: ["prod"],
    });
    expect(check).toEqual({ state: "could-not-check", missing: [] });
  });

  test("the line names the binding, the environment, and the command that writes it", async () => {
    const lines = describeSecretBindings({
      state: "unbound",
      missing: [{ worker: "board", env: "prod", binding: "SECRETS_ENCRYPTION_KEYS" }],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("SECRETS_ENCRYPTION_KEYS");
    expect(lines[0]).toContain("env.prod");
    expect(lines[0]).toContain("pithy secrets provision");
  });
});

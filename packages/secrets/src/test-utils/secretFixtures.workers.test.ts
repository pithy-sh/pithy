// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import type { SecretsStoreEnv } from "../env/bindings";
import { SecretNotFoundError } from "../error/errors";
import { defineSecretRegistry } from "../registry";
import { secretsStore } from "../secretsStore";
import { resetSharedSecrets, sharedSecretsStore } from "../sharedSecretsStore";
import { seedSecrets, stubSecrets } from "./secretFixtures";

/**
 * The harness four capability packages supply their secrets through, tested against the reader it
 * feeds — because a fixture that quietly diverges from production is worse than no fixture. What is
 * asserted here is that a seeded value comes back through `secretsStore` unchanged and correctly
 * typed, that a stubbed one is indistinguishable from it at the accessor, and that the three author
 * mistakes fail loudly instead of resolving something plausible.
 */

const Credentials = z
  .strictObject({
    clientId: z.string().min(1).describe("The client id half of the pair."),
    clientSecret: z.string().min(1).describe("The client secret half of the pair."),
  })
  .describe("A credential pair, standing in for any json secret a capability declares.");

const registry = defineSecretRegistry({
  "session-key": { backend: "d1", scope: "environment", rotatable: true, valueType: "text" },
  credentials: { backend: "d1", scope: "environment", rotatable: false, valueType: "json", schema: Credentials },
});

/** The same text entry alone, for cases that assert a read — `secretsStore` resolves a registry whole. */
const textOnly = defineSecretRegistry({
  "session-key": { backend: "d1", scope: "environment", rotatable: true, valueType: "text" },
});

/** The env a worker reads through: its `SECRETS` D1 and the master key the pool bound. */
const workerEnv = env as unknown as SecretsStoreEnv;

beforeEach(async () => {
  await env.SECRETS.prepare("drop table if exists pithy_secrets_system_secrets").run();
  await env.SECRETS.prepare("drop table if exists pithy_secrets_rotations").run();
});

afterEach(() => resetSharedSecrets());

describe("seedSecrets", () => {
  test("a seeded value is what the reader resolves, typed by its entry", async () => {
    await seedSecrets(workerEnv, registry, {
      "session-key": "seeded-session-key",
      credentials: { clientId: "id", clientSecret: "shh" },
    });

    const secrets = await secretsStore(workerEnv, registry);

    expect(secrets.get("session-key")).toBe("seeded-session-key");
    expect(secrets.get("credentials")).toEqual({ clientId: "id", clientSecret: "shh" });
  });

  test("the value lands as version 1 of a fresh envelope — the kid a test's own token carries", async () => {
    await seedSecrets(workerEnv, textOnly, { "session-key": "k" });

    const secrets = await secretsStore(workerEnv, textOnly);

    expect(secrets.getVersions("session-key")).toEqual({ currentVersion: "1", versions: { "1": "k" } });
  });

  test("it creates the tables on first use, so a suite needs no migration step of its own", async () => {
    // The `beforeEach` above dropped both. Nothing between there and here ran a migration.
    await expect(seedSecrets(workerEnv, textOnly, { "session-key": "k" })).resolves.toBeUndefined();
  });

  test("seeding the same name again overwrites, which is how a case gets its own value", async () => {
    await seedSecrets(workerEnv, textOnly, { "session-key": "first" });
    await seedSecrets(workerEnv, textOnly, { "session-key": "second" });

    expect((await secretsStore(workerEnv, textOnly)).get("session-key")).toBe("second");
  });

  test("a name the fixture omits stays unprovisioned, and reading it says so", async () => {
    await seedSecrets(workerEnv, registry, { "session-key": "k" });

    await expect(secretsStore(workerEnv, registry)).rejects.toBeInstanceOf(SecretNotFoundError);
  });
});

describe("stubSecrets", () => {
  test("resolves the same shapes the seeded reader does — the object for json, the string for text", async () => {
    stubSecrets(registry, { "session-key": "stubbed", credentials: { clientId: "id", clientSecret: "shh" } });

    const secrets = await sharedSecretsStore(workerEnv, registry);

    expect(secrets.get("session-key")).toBe("stubbed");
    expect(secrets.get("credentials")).toEqual({ clientId: "id", clientSecret: "shh" });
    expect(secrets.getVersions("session-key")).toEqual({ currentVersion: "1", versions: { "1": "stubbed" } });
  });

  test("an omitted name is unresolved rather than undefined, so a read fails instead of lying", async () => {
    stubSecrets(registry, { "session-key": "stubbed" });

    const secrets = await sharedSecretsStore(workerEnv, registry);

    expect(() => secrets.get("credentials")).toThrow(SecretNotFoundError);
  });

  test("it needs no D1 at all — the accessor is built, not read", async () => {
    stubSecrets(registry, { "session-key": "stubbed" });

    const secrets = await sharedSecretsStore({} as unknown as SecretsStoreEnv, registry);

    expect(secrets.get("session-key")).toBe("stubbed");
  });
});

describe("a fixture that would not survive production fails at the fixture", () => {
  test("a json value the registry schema rejects names the secret, and never echoes the value", async () => {
    const thrown = await seedSecrets(workerEnv, registry, {
      // Deliberately wrong: `clientSecret` is required, and a stray field is refused by `strictObject`.
      credentials: { clientId: "id", tenant: "REDACT_ME" } as unknown as z.infer<typeof Credentials>,
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(InternalError);
    expect((thrown as InternalError).payload.message).toContain("credentials");
    expect(JSON.stringify((thrown as InternalError).payload)).not.toContain("REDACT_ME");
  });

  test("a name the registry does not declare is a typo, not a secret", async () => {
    const fixture = { "sesion-key": "k" } as unknown as { "session-key": string };

    await expect(seedSecrets(workerEnv, registry, fixture)).rejects.toBeInstanceOf(InternalError);
  });

  test("a keyspace has no one value to seed, and says so rather than writing a member", async () => {
    const keyed = defineSecretRegistry({
      "connection-keys": { backend: "d1", scope: "environment", rotatable: true, valueType: "text", keyed: true },
    });
    const fixture = { "connection-keys": "k" } as unknown as Record<string, never>;

    await expect(seedSecrets(workerEnv, keyed, fixture)).rejects.toBeInstanceOf(InternalError);
  });
});

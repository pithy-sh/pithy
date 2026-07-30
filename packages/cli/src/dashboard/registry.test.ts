// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import type { ControlPlaneConnection, RegisteredKey } from "@pithy-sh/core/src/controlPlane/data/connection";
import { activeKeys, findVerifyingKey } from "@pithy-sh/core/src/controlPlane/data/keyLifecycle";
import { controlPlaneDatabase } from "@pithy-sh/core/src/controlPlane/data/tables";
import { controlplane_0001_connections } from "@pithy-sh/core/src/controlPlane/migrations/0001_connections";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { Kysely } from "kysely";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { SeedDriver } from "../seed/drivers";
import { connectionRegistry, openConnectionRegistry } from "./registry";

const JWK = { kty: "OKP", crv: "Ed25519", x: "kHo4iZ3rG3Jm2m7L9pQwXyZ0aBcDeFgHiJkLmNoPqRs" } as const;

let miniflare: Miniflare;
let d1: D1Database;

beforeEach(async () => {
  miniflare = new Miniflare({ modules: true, script: "export default {};", d1Databases: { DB: "DB" } });
  d1 = (await miniflare.getD1Database("DB")) as unknown as D1Database;
  await controlplane_0001_connections.up(controlPlaneDatabase(d1) as unknown as Kysely<unknown>);
});

afterEach(async () => {
  await miniflare.dispose();
});

/** A registered key with an open-ended window — what registration always produces. */
function key(keyId: string, validFrom: Date): RegisteredKey {
  return { keyId, publicKey: JWK, validFrom, validUntil: null, revokedAt: null };
}

/** One connection, minimal and valid. */
function connection(overrides: Partial<ControlPlaneConnection> = {}): ControlPlaneConnection {
  const at = new Date("2026-07-01T00:00:00.000Z");
  return {
    id: "5f1f1c3e-6b2a-4d9f-8f2a-1c9d0e5b7a31",
    environment: "production",
    issuer: "https://app.pithy.sh",
    workerUrl: "https://api.example.com",
    scopes: ["manifest:read", "keys:rotate"],
    keys: [key("key_1", at)],
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

describe("connectionRegistry", () => {
  test("nothing registered reads as null — the shipped state of a Worker never connected", async () => {
    const registry = connectionRegistry(controlPlaneDatabase(d1), "production");
    expect(await registry.read()).toBeNull();
  });

  test("a saved connection round-trips through the codecs — dates, scopes, and keys", async () => {
    const registry = connectionRegistry(controlPlaneDatabase(d1), "production");
    const saved = connection();
    await registry.save(saved);

    const read = await registry.read();
    expect(read).toEqual(saved);
    expect(read?.createdAt).toBeInstanceOf(Date);
    expect(read?.keys[0]?.validFrom).toBeInstanceOf(Date);
    expect(read?.scopes).toEqual(["manifest:read", "keys:rotate"]);
  });

  test("one connection per environment — saving again replaces rather than accumulates", async () => {
    const registry = connectionRegistry(controlPlaneDatabase(d1), "production");
    await registry.save(connection());
    await registry.save(
      connection({ id: "9a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", workerUrl: "https://new.example.com" }),
    );

    const read = await registry.read();
    expect(read?.workerUrl).toBe("https://new.example.com");
    expect(read?.id).toBe("9a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d");
  });

  test("environments are isolated — a production save leaves staging alone", async () => {
    const production = connectionRegistry(controlPlaneDatabase(d1), "production");
    const staging = connectionRegistry(controlPlaneDatabase(d1), "staging");
    await staging.save(connection({ id: "1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9", environment: "staging" }));
    await production.save(connection());

    expect((await staging.read())?.id).toBe("1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9");
    expect((await production.read())?.id).toBe("5f1f1c3e-6b2a-4d9f-8f2a-1c9d0e5b7a31");
  });

  test("appendKey appends and leaves the existing key's window open — a rotation never locks anyone out", async () => {
    const registry = connectionRegistry(controlPlaneDatabase(d1), "production");
    await registry.save(connection());

    const at = new Date("2026-08-01T00:00:00.000Z");
    const updated = await registry.appendKey(key("key_2", at), at);

    expect(updated.keys.map((k) => k.keyId)).toEqual(["key_1", "key_2"]);
    expect(updated.keys[0]?.validUntil).toBeNull();
    expect(updated.updatedAt).toEqual(at);
    expect((await registry.read())?.keys).toHaveLength(2);
  });

  test("appendKey refuses a duplicate key id — the safety property lives in core, not here", async () => {
    const registry = connectionRegistry(controlPlaneDatabase(d1), "production");
    await registry.save(connection());

    const error = await registry
      .appendKey(key("key_1", new Date("2026-08-01T00:00:00.000Z")), new Date("2026-08-01T00:00:00.000Z"))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.code).toBe("controlplane/key_conflict");
  });

  test("appendKey with nothing connected raises controlplane/not_connected", async () => {
    const registry = connectionRegistry(controlPlaneDatabase(d1), "production");
    const at = new Date();
    const error = await registry.appendKey(key("key_1", at), at).catch((caught: unknown) => caught);
    expect((error as PithyError).payload.code).toBe("controlplane/not_connected");
  });

  test("revokeKey stamps revokedAt and core stops accepting that key immediately", async () => {
    // `revokedAt` is honoured by `findVerifyingKey` on every request, so this asserts the whole path:
    // the CLI writes it, the codecs round-trip it through D1, and core's lifecycle refuses the key.
    const registry = connectionRegistry(controlPlaneDatabase(d1), "production");
    const at = new Date("2026-08-01T00:00:00.000Z");
    await registry.save(connection());
    await registry.appendKey(key("key_2", at), at);

    const updated = await registry.revokeKey("key_1", at);

    expect(updated?.keys.find((k) => k.keyId === "key_1")?.revokedAt).toEqual(at);
    // Read back from D1, not from the return value — the codec is the thing being trusted here.
    const persisted = await registry.read();
    expect(findVerifyingKey(persisted?.keys ?? [], "key_1", at)).toBeNull();
    expect(findVerifyingKey(persisted?.keys ?? [], "key_2", at)?.keyId).toBe("key_2");
  });

  test("revokeKey may take the last live key — a leaked key comes out even when it is the only one", async () => {
    // Deliberately not refused. Expiry is the orderly path and core blocks it when it would empty the
    // live set; revocation is the disorderly one, and an adopter holding a leaked key must never be
    // told they have to keep trusting it. It leaves the connection denying everything, which is right.
    const registry = connectionRegistry(controlPlaneDatabase(d1), "production");
    const at = new Date("2026-08-01T00:00:00.000Z");
    await registry.save(connection());

    const updated = await registry.revokeKey("key_1", at);

    expect(updated?.keys).toHaveLength(1);
    expect(activeKeys(updated?.keys ?? [], at)).toEqual([]);
  });

  test("revokeKey returns null for a key that was never registered, and changes nothing", async () => {
    const registry = connectionRegistry(controlPlaneDatabase(d1), "production");
    await registry.save(connection());

    expect(await registry.revokeKey("key_nope", new Date("2026-08-01T00:00:00.000Z"))).toBeNull();
    expect((await registry.read())?.keys[0]?.revokedAt).toBeNull();
  });

  test("remove deletes the row, and is idempotent — revocation is safe to re-run", async () => {
    const registry = connectionRegistry(controlPlaneDatabase(d1), "production");
    await registry.save(connection());

    expect(await registry.remove()).toBe(true);
    expect(await registry.read()).toBeNull();
    expect(await registry.remove()).toBe(false);
  });
});

describe("openConnectionRegistry", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "pithy-dashboard-"));
    await mkdir(join(projectDir, "apps", "api"), { recursive: true });
    await writeFile(
      join(projectDir, "apps", "api", "wrangler.jsonc"),
      JSON.stringify({ name: "api", d1_databases: [{ binding: "DB", database_id: "local-dev" }] }),
    );
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  test("opens against the project root's state, never a per-worker one", async () => {
    const seen: { workerDir: string; persistRoot: string; env: string }[] = [];
    const driver = {
      d1: () => d1,
      dispose: async () => {},
    } as unknown as SeedDriver;

    const registry = await openConnectionRegistry({
      projectDir,
      env: "dev",
      openDriver: async (options) => {
        seen.push(options);
        return driver;
      },
    });
    await registry.save(connection({ environment: "dev" }));
    await registry.dispose();

    // Two Workers that both declare `DB` share one database. A per-Worker persist dir would silently
    // split it, so the registry must persist where `pithy dev`, `migrate`, and `seed` do: the root.
    expect(seen[0]?.persistRoot).toBe(projectDir);
    expect(seen[0]?.workerDir).toBe(join(projectDir, "apps", "api"));
    expect(seen[0]?.env).toBe("dev");
  });

  test("no worker declares DB — an actionable error, not a crash", async () => {
    await writeFile(join(projectDir, "apps", "api", "wrangler.jsonc"), JSON.stringify({ name: "api" }));
    const error = await openConnectionRegistry({ projectDir, env: "dev" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.action).toBeTruthy();
  });
});

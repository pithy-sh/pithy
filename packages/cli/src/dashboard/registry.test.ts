// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { auditDatabase } from "@pithy-sh/audit/src/data/tables";
import { audit_0001_init } from "@pithy-sh/audit/src/migrations/0001_init";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import type { ControlPlaneConnection, RegisteredKey } from "@pithy-sh/core/src/controlPlane/data/connection";
import { activeKeys, findVerifyingKey } from "@pithy-sh/core/src/controlPlane/data/keyLifecycle";
import { controlPlaneDatabase } from "@pithy-sh/core/src/controlPlane/data/tables";
import { controlplane_0001_init } from "@pithy-sh/core/src/controlPlane/migrations/0001_init";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { Kysely } from "kysely";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type CliAuditEmit, type CliAuditEvent, createCliAudit } from "../audit/cliAudit";
import { sourceFiles } from "../ci/sourceFiles";
import type { SeedDriver } from "../seed/drivers";
import { connectionRegistry, openConnectionRegistry } from "./registry";

const JWK = { kty: "OKP", crv: "Ed25519", x: "kHo4iZ3rG3Jm2m7L9pQwXyZ0aBcDeFgHiJkLmNoPqRs" } as const;

let miniflare: Miniflare;
let d1: D1Database;

beforeEach(async () => {
  miniflare = new Miniflare({ modules: true, script: "export default {};", d1Databases: { DB: "DB" } });
  d1 = (await miniflare.getD1Database("DB")) as unknown as D1Database;
  await controlplane_0001_init.up(controlPlaneDatabase(d1) as unknown as Kysely<unknown>);
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
    environment: "prod",
    issuer: "https://app.pithy.sh",
    workerUrl: "https://api.example.com",
    basePath: "/control-plane",
    scopes: ["manifest:read", "keys:rotate"],
    keys: [key("key_1", at)],
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

describe("connectionRegistry", () => {
  test("nothing registered reads as null — the shipped state of a Worker never connected", async () => {
    const registry = connectionRegistry(controlPlaneDatabase(d1), "prod");
    expect(await registry.read()).toBeNull();
  });

  test("a saved connection round-trips through the codecs — dates, scopes, and keys", async () => {
    const registry = connectionRegistry(controlPlaneDatabase(d1), "prod");
    const saved = connection();
    await registry.save(saved);

    const read = await registry.read();
    expect(read).toEqual(saved);
    expect(read?.createdAt).toBeInstanceOf(Date);
    expect(read?.keys[0]?.validFrom).toBeInstanceOf(Date);
    expect(read?.scopes).toEqual(["manifest:read", "keys:rotate"]);
  });

  test("one connection per environment — saving again replaces rather than accumulates", async () => {
    const registry = connectionRegistry(controlPlaneDatabase(d1), "prod");
    await registry.save(connection());
    await registry.save(
      connection({ id: "9a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", workerUrl: "https://new.example.com" }),
    );

    const read = await registry.read();
    expect(read?.workerUrl).toBe("https://new.example.com");
    expect(read?.id).toBe("9a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d");
  });

  test("environments are isolated — a production save leaves staging alone", async () => {
    const production = connectionRegistry(controlPlaneDatabase(d1), "prod");
    const staging = connectionRegistry(controlPlaneDatabase(d1), "staging");
    await staging.save(connection({ id: "1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9", environment: "staging" }));
    await production.save(connection());

    expect((await staging.read())?.id).toBe("1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9");
    expect((await production.read())?.id).toBe("5f1f1c3e-6b2a-4d9f-8f2a-1c9d0e5b7a31");
  });

  test("appendKey appends and leaves the existing key's window open — a rotation never locks anyone out", async () => {
    const registry = connectionRegistry(controlPlaneDatabase(d1), "prod");
    const at = new Date("2026-08-01T00:00:00.000Z");
    // Nothing live, so nothing could have signed a registration at the seam and the CLI is the only
    // thing that can put a key back. The append is still an append: no existing window moves.
    await registry.save(
      connection({ keys: [{ ...key("key_1", new Date("2026-07-01T00:00:00.000Z")), revokedAt: at }] }),
    );

    const updated = await registry.appendKey(key("key_2", at), at);

    expect(updated.keys.map((k) => k.keyId)).toEqual(["key_1", "key_2"]);
    expect(updated.keys[0]?.validUntil).toBeNull();
    expect(updated.updatedAt).toEqual(at);
    expect((await registry.read())?.keys).toHaveLength(2);
  });

  test("appendKey refuses a duplicate key id — the safety property lives in core, not here", async () => {
    const registry = connectionRegistry(controlPlaneDatabase(d1), "prod");
    const at = new Date("2026-08-01T00:00:00.000Z");
    await registry.save(
      connection({ keys: [{ ...key("key_1", new Date("2026-07-01T00:00:00.000Z")), revokedAt: at }] }),
    );

    const error = await registry.appendKey(key("key_1", at), at).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.code).toBe("controlplane/key_conflict");
    expect((error as PithyError).payload.detail).toContain("duplicate keyId");
  });

  test("appendKey with nothing connected raises controlplane/not_connected", async () => {
    const registry = connectionRegistry(controlPlaneDatabase(d1), "prod");
    const at = new Date();
    const error = await registry.appendKey(key("key_1", at), at).catch((caught: unknown) => caught);
    expect((error as PithyError).payload.code).toBe("controlplane/not_connected");
  });

  test("revokeKey stamps revokedAt and core stops accepting that key immediately", async () => {
    // `revokedAt` is honored by `findVerifyingKey` on every request, so this asserts the whole path:
    // the CLI writes it, the codecs round-trip it through D1, and core's lifecycle refuses the key.
    const registry = connectionRegistry(controlPlaneDatabase(d1), "prod");
    const at = new Date("2026-08-01T00:00:00.000Z");
    // Two live keys: the state a rotation leaves behind, written here as the seam's route would.
    await registry.save(connection({ keys: [key("key_1", new Date("2026-07-01T00:00:00.000Z")), key("key_2", at)] }));

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
    const registry = connectionRegistry(controlPlaneDatabase(d1), "prod");
    const at = new Date("2026-08-01T00:00:00.000Z");
    await registry.save(connection());

    const updated = await registry.revokeKey("key_1", at);

    expect(updated?.keys).toHaveLength(1);
    expect(activeKeys(updated?.keys ?? [], at)).toEqual([]);
  });

  test("revokeKey returns null for a key that was never registered, and changes nothing", async () => {
    const registry = connectionRegistry(controlPlaneDatabase(d1), "prod");
    await registry.save(connection());

    expect(await registry.revokeKey("key_nope", new Date("2026-08-01T00:00:00.000Z"))).toBeNull();
    expect((await registry.read())?.keys[0]?.revokedAt).toBeNull();
  });

  test("appendKey is refused while a key is live, whoever is asking", async () => {
    const registry = connectionRegistry(controlPlaneDatabase(d1), "prod");
    const at = new Date("2026-08-01T00:00:00.000Z");
    await registry.save(connection());

    const error = await registry.appendKey(key("key_2", at), at).catch((caught: unknown) => caught);

    expect((error as PithyError).payload.code).toBe("controlplane/key_conflict");
    // The refusal names the call to make instead, mount point and signing key included.
    expect((error as PithyError).payload.action).toContain("https://api.example.com/control-plane/keys");
    expect((error as PithyError).payload.action).toContain("key_1");
    expect((await registry.read())?.keys).toHaveLength(1);
  });

  test("save may not rewrite the keys of a connection it is keeping", async () => {
    const registry = connectionRegistry(controlPlaneDatabase(d1), "prod");
    const at = new Date("2026-08-01T00:00:00.000Z");
    await registry.save(connection());

    // A rotation wearing a create's clothes: same connection, new key set, straight into D1.
    const error = await registry
      .save(connection({ keys: [key("key_1", new Date("2026-07-01T00:00:00.000Z")), key("key_2", at)], updatedAt: at }))
      .catch((caught: unknown) => caught);

    expect((error as PithyError).payload.code).toBe("controlplane/key_conflict");
    expect((await registry.read())?.keys).toHaveLength(1);
  });

  test("save still re-points the address and the grant, because neither adds a key", async () => {
    const registry = connectionRegistry(controlPlaneDatabase(d1), "prod");
    const at = new Date("2026-08-01T00:00:00.000Z");
    await registry.save(connection());

    await registry.save(
      connection({ workerUrl: "https://moved.example.com", scopes: ["manifest:read"], updatedAt: at }),
    );

    const read = await registry.read();
    expect(read?.workerUrl).toBe("https://moved.example.com");
    expect(read?.scopes).toEqual(["manifest:read"]);
  });

  test("save still replaces a whole connection, because a new one has nothing live to sign for it", async () => {
    const registry = connectionRegistry(controlPlaneDatabase(d1), "prod");
    const at = new Date("2026-08-01T00:00:00.000Z");
    await registry.save(connection());

    // Starting over: a new id, a new keypair, nothing carried forward. That is first connect, and it
    // has to keep working when the worker is unreachable — it is the way back from a lost credential.
    await registry.save(
      connection({ id: "9a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", keys: [key("key_9", at)], updatedAt: at }),
    );

    expect((await registry.read())?.keys.map((k) => k.keyId)).toEqual(["key_9"]);
  });

  test("remove deletes the row, and is idempotent — revocation is safe to re-run", async () => {
    const registry = connectionRegistry(controlPlaneDatabase(d1), "prod");
    await registry.save(connection());

    expect(await registry.remove()).toBe(true);
    expect(await registry.read()).toBeNull();
    expect(await registry.remove()).toBe(false);
  });
});

/**
 * #294 — a write to the connections table records itself in the adopter's own trail.
 *
 * The three connection-lifecycle codes were declared from the day the seam shipped and emitted by
 * nothing, because those writes never reach the adopter's Worker and no route is in a position to
 * record them. These assert the registry does it instead, at the write, so no call site can forget.
 */
describe("a write records itself", () => {
  /** Collect what the registry recorded, in order. */
  function recorder(): { events: CliAuditEvent[]; record: CliAuditEmit } {
    const events: CliAuditEvent[] = [];
    return {
      events,
      record: async (event) => {
        events.push(event);
      },
    };
  }

  /** The metadata of the one event recorded, as a plain bag. */
  function metadata(events: readonly CliAuditEvent[], index = 0): Record<string, unknown> {
    return (events[index]?.metadata ?? {}) as Record<string, unknown>;
  }

  test("a first connect is a registration, naming the client's reach into this environment", async () => {
    const { events, record } = recorder();
    const registry = connectionRegistry(controlPlaneDatabase(d1), "prod", undefined, record);
    await registry.save(connection());

    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("controlplane/connection_registered");
    expect(events[0]?.outcome).toBe("success");
    // The same fields the seam's own key routes use, so one filter gets both halves of a connection's
    // history rather than two writers naming the same thing two ways.
    expect(events[0]?.resourceType).toBe("controlplane_connection");
    expect(events[0]?.resourceId).toBe("5f1f1c3e-6b2a-4d9f-8f2a-1c9d0e5b7a31");
    expect(events[0]?.environment).toBe("prod");
    expect(metadata(events)).toMatchObject({
      connectionId: "5f1f1c3e-6b2a-4d9f-8f2a-1c9d0e5b7a31",
      connectionEnvironment: "prod",
      issuer: "https://app.pithy.sh",
      workerUrl: "https://api.example.com",
      scopes: ["manifest:read", "keys:rotate"],
      registeredKeyIds: ["key_1"],
    });
  });

  test("the event names no actor — a CLI write does not get to claim a verified caller", () => {
    // `CliAuditEvent` omits `actorType`/`actorId` outright; the emitter resolves them. A route records
    // `control-plane`, meaning the client called in and proved it, and nothing here may say that.
    const event: CliAuditEvent = { action: "controlplane/connection_registered", outcome: "success" };
    expect(Object.keys(event)).not.toContain("actorType");
  });

  test("no key material ever reaches the trail — ids only", async () => {
    const { events, record } = recorder();
    const registry = connectionRegistry(controlPlaneDatabase(d1), "prod", undefined, record);
    await registry.save(connection());
    await registry.remove();

    // The trail is queryable and long-lived. A public key is not a secret, but a row nobody needs is a
    // row that grows, and `x` is the one field that would make these events carry key material at all.
    for (const event of events) expect(JSON.stringify(event)).not.toContain(JWK.x);
  });

  test("re-pointing the same connection is an update, and says what moved", async () => {
    const { events, record } = recorder();
    const registry = connectionRegistry(controlPlaneDatabase(d1), "prod", undefined, record);
    const original = connection();
    await registry.save(original);
    await registry.save({ ...original, workerUrl: "https://moved.example.com", scopes: ["manifest:read"] });

    expect(events).toHaveLength(2);
    expect(events[1]?.action).toBe("controlplane/connection_updated");
    expect(metadata(events, 1)).toMatchObject({
      changed: ["workerUrl", "scopes"],
      workerUrl: { from: "https://api.example.com", to: "https://moved.example.com" },
      scopes: { from: ["keys:rotate", "manifest:read"], to: ["manifest:read"] },
    });
  });

  test("a reordered grant is not a change — a grant is what it contains", async () => {
    const { events, record } = recorder();
    const registry = connectionRegistry(controlPlaneDatabase(d1), "prod", undefined, record);
    const original = connection();
    await registry.save(original);
    await registry.save({ ...original, scopes: ["keys:rotate", "manifest:read"] });

    // Reporting a reordering as a change is how the one that matters gets buried.
    expect(metadata(events, 1).changed).toEqual([]);
  });

  test("starting over is a registration, and names the connection that stopped working", async () => {
    const { events, record } = recorder();
    const registry = connectionRegistry(controlPlaneDatabase(d1), "prod", undefined, record);
    await registry.save(connection());
    await registry.save(connection({ id: "9a0b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d" }));

    expect(events[1]?.action).toBe("controlplane/connection_registered");
    expect(metadata(events, 1).replacedConnectionId).toBe("5f1f1c3e-6b2a-4d9f-8f2a-1c9d0e5b7a31");
  });

  test("a recovered key is a change to the connection, not a registration of one", async () => {
    const { events, record } = recorder();
    const registry = connectionRegistry(controlPlaneDatabase(d1), "prod", undefined, record);
    const at = new Date("2026-07-01T00:00:00.000Z");
    await registry.save(connection({ keys: [{ ...key("key_1", at), revokedAt: at }] }));
    await registry.appendKey(key("key_2", at), at);

    // The connection existed and now trusts a key it did not. `keyRegistered` is the seam's code for a
    // registration the Worker accepted through the route, and nothing here went near the Worker.
    expect(events[1]?.action).toBe("controlplane/connection_updated");
    expect(metadata(events, 1)).toMatchObject({ changed: ["keys"], registeredKeyId: "key_2" });
  });

  test("a revocation is recorded, and says what is still live after it", async () => {
    const { events, record } = recorder();
    const registry = connectionRegistry(controlPlaneDatabase(d1), "prod", undefined, record);
    const at = new Date("2026-07-01T00:00:00.000Z");
    await registry.save(connection({ keys: [key("key_1", at), key("key_2", at)] }));
    await registry.revokeKey("key_1", new Date("2026-07-02T00:00:00.000Z"));

    expect(events[1]?.action).toBe("controlplane/connection_updated");
    // Revoking the last one leaves the connection denying everything, which is the fact a reader asking
    // "when did this stop working" is looking for.
    expect(metadata(events, 1)).toMatchObject({ revokedKeyId: "key_1", liveKeyIdsAfter: ["key_2"] });
  });

  test("a revocation that matched no key records nothing", async () => {
    const { events, record } = recorder();
    const registry = connectionRegistry(controlPlaneDatabase(d1), "prod", undefined, record);
    await registry.save(connection());
    expect(await registry.revokeKey("key_absent", new Date())).toBeNull();
    expect(events).toHaveLength(1);
  });

  test("a disconnect is recorded from the connection as it was — after the delete there is nothing left", async () => {
    const { events, record } = recorder();
    const registry = connectionRegistry(controlPlaneDatabase(d1), "prod", undefined, record);
    await registry.save(connection());
    await registry.remove();

    expect(events[1]?.action).toBe("controlplane/connection_removed");
    expect(events[1]?.resourceId).toBe("5f1f1c3e-6b2a-4d9f-8f2a-1c9d0e5b7a31");
    expect(metadata(events, 1)).toMatchObject({
      issuer: "https://app.pithy.sh",
      workerUrl: "https://api.example.com",
      removedKeyIds: ["key_1"],
    });
  });

  test("a re-run of disconnect deletes nothing and records nothing", async () => {
    const { events, record } = recorder();
    const registry = connectionRegistry(controlPlaneDatabase(d1), "prod", undefined, record);
    expect(await registry.remove()).toBe(false);
    expect(events).toEqual([]);
  });

  test("a write that was refused records nothing", async () => {
    const { events, record } = recorder();
    const registry = connectionRegistry(controlPlaneDatabase(d1), "prod", undefined, record);
    const at = new Date("2026-07-01T00:00:00.000Z");
    await registry.save(connection());
    // #287's gate: a key cannot be added while something live could sign for one at the seam.
    await expect(registry.appendKey(key("key_2", at), at)).rejects.toBeInstanceOf(PithyError);

    // The row is written first and the event follows. A connect that recorded a registration it did not
    // make is worse than one that recorded nothing.
    expect(events).toHaveLength(1);
  });

  test("a trail that cannot be written does not fail the write it was recording", async () => {
    const registry = connectionRegistry(controlPlaneDatabase(d1), "prod", undefined, async () => {
      throw new Error("the audit database is unreachable");
    });

    // The emitter is non-fatal by contract, and this is the belt: a connect must not fail because the
    // adopter's trail was unavailable. The record is evidence of the change, never part of making it.
    await expect(registry.save(connection())).resolves.toBeUndefined();
    expect(await registry.read()).not.toBeNull();
  });

  test("a project not composing audit writes exactly as it did — no recorder, no change", async () => {
    const registry = connectionRegistry(controlPlaneDatabase(d1), "prod");
    await registry.save(connection());
    await registry.revokeKey("key_1", new Date());
    expect(await registry.remove()).toBe(true);
    expect(await registry.read()).toBeNull();
  });
});

describe("the one door onto the connections table", () => {
  /**
   * The other half of #287's gate. {@link connectionRegistry} refuses a key write while something live
   * could have signed for one at the seam — which is worth exactly as much as the guarantee that
   * nothing else in the CLI opens that table.
   *
   * Stated as a property over the tree rather than as a list of blessed callers: any module that names
   * the connections table or builds a control-plane database has a second route to the column, and a
   * second route is how the duplicated authority regrows.
   */
  const CLI_SOURCE = join(import.meta.dirname, "..");
  const DOOR = join(CLI_SOURCE, "dashboard", "registry.ts");

  test("only registry.ts reaches the control-plane connections table", () => {
    const scanned = sourceFiles(CLI_SOURCE);
    // A silent walk finding nothing would pass the assertion below without proving anything.
    expect(scanned.length).toBeGreaterThan(100);

    const reaching = scanned
      .filter(
        (source) =>
          source.text.includes("CONTROL_PLANE_CONNECTIONS_TABLE") || source.text.includes("controlPlaneDatabase("),
      )
      .map((source) => source.path);

    expect(reaching, "route the write through connectionRegistry — the invariant is enforced there").toEqual([DOOR]);
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
      account: null,
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

  test("the recorder is built over the database the row was written through", async () => {
    // #294, end to end and against real D1: the audit table lives in the adopter's app database, the same
    // one the connection row does, and `openConnectionRegistry` is what resolves it. So the recorder is a
    // factory taking that handle rather than an emitter passed in ready-made — a database id looked up a
    // second time is a different store on `dev`, and the record of a change would land where the change
    // did not.
    await audit_0001_init.up(auditDatabase(d1) as unknown as Kysely<unknown>);

    const registry = await openConnectionRegistry({
      account: null,
      projectDir,
      env: "dev",
      openDriver: async () => ({ d1: () => d1, dispose: async () => {} }) as unknown as SeedDriver,
      openAudit: async (database) =>
        createCliAudit({
          projectDir,
          env: "dev",
          actedOn: "dev",
          capabilities: [defineCapability({ name: "audit", requiredBindings: [] })],
          database,
        }),
    });
    await registry.save(connection({ environment: "dev" }));
    await registry.remove();
    await registry.dispose();

    const rows = await auditDatabase(d1)
      .selectFrom("pithyAuditEvents")
      .select(["action", "outcome", "severity", "actorType", "resourceId", "environment"])
      .orderBy("id")
      .execute();

    expect(rows.map((row) => row.action)).toEqual([
      "controlplane/connection_registered",
      "controlplane/connection_removed",
    ]);
    // Not `control-plane`: that is the actor a route records, meaning the management client called in and
    // proved it. This came from a person at a terminal with no Cloudflare token to name them by.
    expect(rows.every((row) => row.actorType === "system")).toBe(true);
    expect(rows.every((row) => row.severity === "warning")).toBe(true);
    expect(rows.every((row) => row.environment === "dev")).toBe(true);
    expect(rows.every((row) => row.resourceId === "5f1f1c3e-6b2a-4d9f-8f2a-1c9d0e5b7a31")).toBe(true);
  });

  test("a project not composing audit connects, with no error and no partial write", async () => {
    // The audit table is not even created here. An adopter need not compose `audit`, and a connect must
    // not fail — or half-happen — because there was nowhere to record it.
    const registry = await openConnectionRegistry({
      account: null,
      projectDir,
      env: "dev",
      openDriver: async () => ({ d1: () => d1, dispose: async () => {} }) as unknown as SeedDriver,
      openAudit: async (database) =>
        createCliAudit({
          projectDir,
          env: "dev",
          capabilities: [defineCapability({ name: "app", requiredBindings: [] })],
          database,
        }),
    });
    await expect(registry.save(connection({ environment: "dev" }))).resolves.toBeUndefined();
    expect(await registry.read()).not.toBeNull();
    await registry.dispose();
  });

  /**
   * #236's two whole-project failures, each proven to arrive as one.
   *
   * A per-item collector will swallow a whole-run refusal, because the whole-run failure arrives wearing a
   * per-item costume: the account is settled before any Worker is considered, but it was only *consulted*
   * inside the loop, so the mismatch landed in `refusals` and the adopter read "No worker resolves the DB
   * binding for this environment" — a sentence about their `wrangler.jsonc`, which was fine.
   *
   * The credentials are supplied from the environment rather than a file, which is both the CI shape and
   * the shape that produced the report: `PITHY_CONFIG_DIR` at a scratch directory, `CLOUDFLARE_*` exported
   * in the shell hours earlier.
   */
  describe("a whole-project failure is reported as one, not as a per-worker skip (#236)", () => {
    let configDir: string;
    const restore = new Map<string, string | undefined>();

    /** Set the process-wide credential resolution this suite needs, remembering what to put back. */
    function setEnvironment(values: Record<string, string | undefined>): void {
      for (const [key, value] of Object.entries(values)) {
        if (!restore.has(key)) restore.set(key, process.env[key]);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    beforeEach(async () => {
      configDir = await mkdtemp(join(tmpdir(), "pithy-dashboard-config-"));
      // A `database_id` for the target environment, so nothing per-Worker is wrong. Without it the
      // Worker's own refusal fires first and the whole-project one is never reached.
      await writeFile(
        join(projectDir, "apps", "api", "wrangler.jsonc"),
        JSON.stringify({
          name: "api",
          d1_databases: [{ binding: "DB", database_id: "local-dev" }],
          env: { staging: { d1_databases: [{ binding: "DB", database_id: "staging-db" }] } },
        }),
      );
    });

    afterEach(async () => {
      for (const [key, value] of restore) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      restore.clear();
      await rm(configDir, { recursive: true, force: true });
    });

    test("an account mismatch names both accounts, in doctor's own sentence", async () => {
      setEnvironment({
        PITHY_CONFIG_DIR: configDir,
        PITHY_OFFLINE: undefined,
        CLOUDFLARE_ACCOUNT_ID: "e7526284f9ee484875c61723e78af4ae",
        CLOUDFLARE_API_TOKEN: "token-for-the-other-account",
      });

      const error = await openConnectionRegistry({
        account: { accountId: "602df2e6ce74e98b4c7ac5e90a3af5c8" },
        projectDir,
        env: "staging",
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(PithyError);
      const { message } = (error as PithyError).payload;
      // Both ids, because the whole failure is that two of them exist. And not a word about bindings.
      expect(message).toContain("602df2e6ce74e98b4c7ac5e90a3af5c8");
      expect(message).toContain("e7526284f9ee484875c61723e78af4ae");
      expect(message).not.toContain("DB binding");
    });

    test("no credentials at all is refused as one fact, not as every worker's fault", async () => {
      setEnvironment({
        PITHY_CONFIG_DIR: configDir,
        PITHY_OFFLINE: undefined,
        CLOUDFLARE_ACCOUNT_ID: undefined,
        CLOUDFLARE_API_TOKEN: undefined,
      });

      const error = await openConnectionRegistry({ account: null, projectDir, env: "staging" }).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(PithyError);
      expect((error as PithyError).payload.message).toContain("Cloudflare credentials are missing.");
      expect((error as PithyError).payload.message).not.toContain("DB binding");
    });

    test("dev consults no account at all — a mismatch there stops nothing", async () => {
      // Local Miniflare, no credentials read, so a pin disagreeing with the shell is not this run's
      // problem. Refusing here would make the mismatch block work that never leaves the machine.
      setEnvironment({
        PITHY_CONFIG_DIR: configDir,
        PITHY_OFFLINE: undefined,
        CLOUDFLARE_ACCOUNT_ID: "e7526284f9ee484875c61723e78af4ae",
        CLOUDFLARE_API_TOKEN: "token-for-the-other-account",
      });

      const registry = await openConnectionRegistry({
        account: { accountId: "602df2e6ce74e98b4c7ac5e90a3af5c8" },
        projectDir,
        env: "dev",
        openDriver: async () => ({ d1: () => d1, dispose: async () => {} }) as unknown as SeedDriver,
      });
      expect(await registry.read()).toBeNull();
      await registry.dispose();
    });
  });

  test("no worker declares DB — an actionable error, not a crash", async () => {
    await writeFile(join(projectDir, "apps", "api", "wrangler.jsonc"), JSON.stringify({ name: "api" }));
    const error = await openConnectionRegistry({ account: null, projectDir, env: "dev" }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.action).toBeTruthy();
  });
});

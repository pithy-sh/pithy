// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { KyselyPlugin } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { SecretsAuditActions } from "../audit/actions";
import { decryptValue, type EncryptionConfig } from "../crypto/envelope";
import { decodeVersionedValue } from "../crypto/versionedValue";
import { secretsTables } from "../data/tables";
import type { SecretsStoreEnv } from "../env/bindings";
import {
  SecretAlreadyExistsError,
  SecretCryptoError,
  SecretInvalidValueError,
  SecretNotFoundError,
} from "../error/errors";
import { secrets_0001_init } from "../migrations/0001_init";
import { secrets_0002_tables } from "../migrations/0002_tables";
import { defineSecretRegistry } from "../registry";
import { secretsStore } from "../secretsStore";
import { defineSecretTable, secretTableContext } from "./defineSecretTable";
import { secretTableMigration } from "./migration";
import { SecretTableAccessor } from "./tableAccessor";
import { anyTableDb, TableSecretsStore } from "./tableStore";

/**
 * A declared table against a real D1 and the real envelope. A node test can prove which owner a query was
 * built for; only this one can prove the row is sealed under the master key the system table uses, opens for
 * its owner and nobody else, and is gone after an offboarding.
 */

function keyB64(): string {
  const key = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of key) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const config: EncryptionConfig = {
  currentVersion: "3",
  versions: { "3": keyB64() },
  lastRotatedAt: "2026-01-01T00:00:00.000Z",
};

const envFor = (): SecretsStoreEnv =>
  ({ SECRETS: env.SECRETS, SECRETS_ENCRYPTION_KEYS: JSON.stringify(config) }) as unknown as SecretsStoreEnv;

const Webhook = z
  .object({ secret: z.string().min(8).meta({ multiline: false }).describe("The signing secret.") })
  .describe("A webhook signing bundle.");

const CustomerSecrets = defineSecretTable({
  name: "customer",
  keys: {
    userId: z.string().describe("The user the secret belongs to."),
    organizationId: z.string().describe("The organization the user belongs to."),
  },
  secrets: {
    STRIPE_KEY: { valueType: "text", rotatable: true, rotateEveryDays: 90 },
    WEBHOOK_SIG: { valueType: "json", schema: Webhook, rotatable: false },
  },
});

/** A system secret beside the table, to prove both live in one D1 under one master key. */
const registry = defineSecretRegistry({
  "app-signing-key": { backend: "d1", scope: "environment", rotatable: false, valueType: "text" },
});

async function table() {
  return (await secretsStore(envFor(), registry)).table(CustomerSecrets);
}

const alice = { userId: "u_alice", organizationId: "org_acme" };
const bob = { userId: "u_bob", organizationId: "org_acme" };
const carol = { userId: "u_carol", organizationId: "org_other" };

/** One row straight from SQL — for the facts the accessor deliberately cannot expose. */
async function rows(): Promise<
  { name: string; userId: string; organizationId: string; encryptedValue: string; iv: string; keyVersion: number }[]
> {
  return (
    await env.SECRETS.prepare(
      "select name, user_id as userId, organization_id as organizationId, encrypted_value as encryptedValue, iv, key_version as keyVersion from pithy_secrets_customer_secrets order by id",
    ).all<{
      name: string;
      userId: string;
      organizationId: string;
      encryptedValue: string;
      iv: string;
      keyVersion: number;
    }>()
  ).results;
}

/** A recorder that keeps what it is handed. */
function recorder() {
  const events: AuditEventInput[] = [];
  return {
    events,
    audit: {
      emit: async (event: AuditEventInput) => {
        events.push(event);
      },
      actorType: "user" as const,
      actorId: "u_admin",
    },
  };
}

beforeEach(async () => {
  for (const name of [
    "pithy_secrets_customer_secrets",
    "pithy_secrets_tables",
    "pithy_secrets_rotations",
    "pithy_secrets_system_secrets",
  ]) {
    await env.SECRETS.prepare(`drop table if exists ${name}`).run();
  }
  const db = createDatabase(env.SECRETS, secretsTables);
  await secrets_0001_init.up(db);
  await secrets_0002_tables.up(db);
  await secretTableMigration({
    from: null,
    to: { table: "customer", keys: ["userId", "organizationId"], secrets: ["STRIPE_KEY", "WEBHOOK_SIG"] },
  }).up(db);
});

describe("get / put", () => {
  test("round-trip a value through the system table's envelope, under the same master key, in the same D1", async () => {
    const t = await table();
    expect(await t.put(alice, "STRIPE_KEY", "sk_live_alice")).toEqual({ currentVersion: "1" });
    expect(await (await table()).get(alice, "STRIPE_KEY")).toBe("sk_live_alice");

    const [row] = await rows();
    expect(row).toMatchObject({ name: "STRIPE_KEY", userId: "u_alice", organizationId: "org_acme", keyVersion: 3 });
    expect(row?.encryptedValue).not.toContain("sk_live_alice");
    // The same envelope a system secret has: AES-GCM over a `{ currentVersion, versions }` value envelope,
    // bound to the row's identity.
    const plaintext = await decryptValue(config, secretTableContext("customer", alice, "STRIPE_KEY"), row as never);
    expect(decodeVersionedValue(plaintext)).toEqual({ currentVersion: "1", versions: { "1": "sk_live_alice" } });
  });

  test("a json value is validated against its schema on the way in, and parsed on the way out", async () => {
    const t = await table();
    await expect(t.put(alice, "WEBHOOK_SIG", { secret: "short" })).rejects.toBeInstanceOf(SecretInvalidValueError);
    await t.put(alice, "WEBHOOK_SIG", { secret: "whsec_long_enough", extra: "stripped" } as never);
    expect(await t.get(alice, "WEBHOOK_SIG")).toEqual({ secret: "whsec_long_enough" });
  });

  test("each owner gets its own row, and one owner's value never answers another's", async () => {
    const t = await table();
    await t.put(alice, "STRIPE_KEY", "sk_alice");
    await t.put(bob, "STRIPE_KEY", "sk_bob");
    expect(await t.get(alice, "STRIPE_KEY")).toBe("sk_alice");
    expect(await t.get(bob, "STRIPE_KEY")).toBe("sk_bob");
    await expect(t.get(carol, "STRIPE_KEY")).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  test("a ciphertext moved into another owner's row does not open there", async () => {
    const t = await table();
    await t.put(alice, "STRIPE_KEY", "sk_alice");
    await t.put(bob, "STRIPE_KEY", "sk_bob");
    await env.SECRETS.prepare(
      "update pithy_secrets_customer_secrets set encrypted_value = (select encrypted_value from pithy_secrets_customer_secrets where user_id = 'u_alice'), iv = (select iv from pithy_secrets_customer_secrets where user_id = 'u_alice') where user_id = 'u_bob'",
    ).run();
    await expect(t.get(bob, "STRIPE_KEY")).rejects.toBeInstanceOf(SecretCryptoError);
  });

  test("put is create-only by default, and replace discards what was stored", async () => {
    const t = await table();
    await t.put(alice, "STRIPE_KEY", "sk_first");
    await expect(t.put(alice, "STRIPE_KEY", "sk_second")).rejects.toBeInstanceOf(SecretAlreadyExistsError);
    expect(await t.get(alice, "STRIPE_KEY")).toBe("sk_first");
    await t.put(alice, "STRIPE_KEY", "sk_clean", { replace: true });
    expect(await t.getVersions(alice, "STRIPE_KEY")).toEqual({ currentVersion: "1", versions: { "1": "sk_clean" } });
  });

  test("a refusal names the table and the secret, never the owner", async () => {
    const t = await table();
    await t.put(alice, "STRIPE_KEY", "sk_first");
    const error = await t.put(alice, "STRIPE_KEY", "sk_second").catch((e: unknown) => e);
    const missing = await t.get(carol, "STRIPE_KEY").catch((e: unknown) => e);
    for (const refusal of [error, missing]) {
      const serialized = JSON.stringify((refusal as SecretNotFoundError).payload);
      expect(serialized).toContain("customer");
      expect(serialized).not.toContain("u_alice");
      expect(serialized).not.toContain("u_carol");
    }
  });

  test("an undeclared secret name and a partial owner are refused before the store is touched", async () => {
    const t = await table();
    await expect(t.put(alice, "NOPE" as never, "x")).rejects.toBeInstanceOf(SecretNotFoundError);
    await expect(t.put({ userId: "u_alice" } as never, "STRIPE_KEY", "x")).rejects.toBeInstanceOf(ValidationError);
    expect(await rows()).toEqual([]);
  });
});

describe("rotate", () => {
  test("appends a version and keeps the prior one valid", async () => {
    const t = await table();
    await t.put(alice, "STRIPE_KEY", "sk_one");
    expect(await t.rotate(alice, "STRIPE_KEY", "sk_two")).toEqual({ currentVersion: "2" });
    expect(await t.get(alice, "STRIPE_KEY")).toBe("sk_two");
    expect(await t.getVersions(alice, "STRIPE_KEY")).toEqual({
      currentVersion: "2",
      versions: { "1": "sk_one", "2": "sk_two" },
    });
  });

  test("refuses a secret declared rotatable: false, and an owner with nothing stored", async () => {
    const t = await table();
    await t.put(alice, "WEBHOOK_SIG", { secret: "whsec_long_enough" });
    await expect(t.rotate(alice, "WEBHOOK_SIG", { secret: "whsec_second_one" })).rejects.toBeInstanceOf(InternalError);
    await expect(t.rotate(carol, "STRIPE_KEY", "sk_new")).rejects.toBeInstanceOf(SecretNotFoundError);
  });
});

/**
 * A Kysely plugin that runs `between` once, after the first query's rows come back and before the caller
 * sees them — the window between a read and the write built from it, made deterministic.
 */
function interleave(between: () => Promise<unknown>): KyselyPlugin {
  let fired = false;
  return {
    transformQuery: (args) => args.node,
    transformResult: async (args) => {
      if (!fired) {
        fired = true;
        await between();
      }
      return args.result;
    },
  };
}

/** The accessor over a store whose first read is followed by `between`, on a separate connection. */
function racing(between: () => Promise<unknown>) {
  const db = anyTableDb(env.SECRETS).withPlugin(interleave(between));
  return new SecretTableAccessor(CustomerSecrets, async (declared) => new TableSecretsStore(db, config, declared));
}

describe("rotate against a concurrent write", () => {
  test("an owner deleted between the read and the write stays deleted — rotate never re-inserts", async () => {
    await (await table()).put(alice, "STRIPE_KEY", "sk_one");
    const offboarded = racing(async () => (await table()).deleteWhere({ organizationId: "org_acme" }));
    await expect(offboarded.rotate(alice, "STRIPE_KEY", "sk_two")).rejects.toBeInstanceOf(SecretNotFoundError);
    expect(await rows()).toEqual([]);
  });

  test("a value replaced between the read and the write is rotated from, never overwritten", async () => {
    await (await table()).put(alice, "STRIPE_KEY", "sk_one");
    const replaced = racing(async () => (await table()).put(alice, "STRIPE_KEY", "sk_fresh", { replace: true }));
    expect(await replaced.rotate(alice, "STRIPE_KEY", "sk_two")).toEqual({ currentVersion: "2" });
    expect(await (await table()).getVersions(alice, "STRIPE_KEY")).toEqual({
      currentVersion: "2",
      versions: { "1": "sk_fresh", "2": "sk_two" },
    });
  });
});

describe("put holds a new row's owner to the declared schema", () => {
  test("an empty key the schema forbids is refused, and nothing is written", async () => {
    const Strict = defineSecretTable({
      name: "customer",
      keys: {
        userId: z.string().describe("The user."),
        organizationId: z.string().min(1).describe("The organization."),
      },
      secrets: { STRIPE_KEY: { valueType: "text", rotatable: true } },
    });
    const t = (await secretsStore(envFor(), registry)).table(Strict);
    const orphan = { userId: "u_alice", organizationId: "" };
    await expect(t.put(orphan, "STRIPE_KEY", "sk_unreachable")).rejects.toBeInstanceOf(ValidationError);
    await expect(t.put(orphan, "STRIPE_KEY", "sk_unreachable", { replace: true })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await rows()).toEqual([]);
  });
});

describe("delete / list / deleteWhere", () => {
  test("delete removes one owner's secret and is idempotent", async () => {
    const t = await table();
    await t.put(alice, "STRIPE_KEY", "sk_alice");
    await t.put(alice, "WEBHOOK_SIG", { secret: "whsec_long_enough" });
    await t.delete(alice, "STRIPE_KEY");
    await t.delete(alice, "STRIPE_KEY");
    await expect(t.get(alice, "STRIPE_KEY")).rejects.toBeInstanceOf(SecretNotFoundError);
    expect(await t.get(alice, "WEBHOOK_SIG")).toEqual({ secret: "whsec_long_enough" });
  });

  test("list on a partial key spans users; list on a full key is that owner's alone — and carries no value", async () => {
    const t = await table();
    await t.put(alice, "STRIPE_KEY", "sk_alice");
    await t.put(alice, "WEBHOOK_SIG", { secret: "whsec_long_enough" });
    await t.put(bob, "STRIPE_KEY", "sk_bob");
    await t.put(carol, "STRIPE_KEY", "sk_carol");

    const acme = await t.list({ organizationId: "org_acme" });
    expect(acme.map((row) => [row.owner.userId, row.name])).toEqual([
      ["u_alice", "STRIPE_KEY"],
      ["u_alice", "WEBHOOK_SIG"],
      ["u_bob", "STRIPE_KEY"],
    ]);
    const mine = await t.list(alice);
    expect(mine.map((row) => row.name)).toEqual(["STRIPE_KEY", "WEBHOOK_SIG"]);
    expect(mine[0]).toMatchObject({ owner: alice, name: "STRIPE_KEY", keyVersion: 3 });
    expect(mine[0]?.createdAt).toBeInstanceOf(Date);
    expect(JSON.stringify(acme)).not.toContain("sk_");
  });

  test("deleteWhere removes every matching row and returns the count", async () => {
    const t = await table();
    await t.put(alice, "STRIPE_KEY", "sk_alice");
    await t.put(alice, "WEBHOOK_SIG", { secret: "whsec_long_enough" });
    await t.put(bob, "STRIPE_KEY", "sk_bob");
    await t.put(carol, "STRIPE_KEY", "sk_carol");

    expect(await t.deleteWhere({ organizationId: "org_acme" })).toBe(3);
    expect((await rows()).map((row) => row.userId)).toEqual(["u_carol"]);
    expect(await t.deleteWhere({ userId: "u_carol" })).toBe(1);
    expect(await t.deleteWhere({ userId: "u_nobody" })).toBe(0);
  });

  test("deleteWhere({}) and list({}) throw — no owner is not an owner", async () => {
    const t = await table();
    await t.put(alice, "STRIPE_KEY", "sk_alice");
    await expect(t.deleteWhere({})).rejects.toBeInstanceOf(ValidationError);
    await expect(t.list({})).rejects.toBeInstanceOf(ValidationError);
    expect(await rows()).toHaveLength(1);
  });
});

describe("audit", () => {
  test("put, rotate, delete and deleteWhere emit events carrying the owner keys and the secret name", async () => {
    const t = await table();
    const { events, audit } = recorder();
    await t.put(alice, "STRIPE_KEY", "sk_live_PLAINTEXT_ONE", { audit });
    await t.rotate(alice, "STRIPE_KEY", "sk_live_PLAINTEXT_TWO", { audit });
    await t.put(bob, "WEBHOOK_SIG", { secret: "whsec_PLAINTEXT_THREE" }, { audit });
    await t.delete(alice, "STRIPE_KEY", { audit });
    await t.deleteWhere({ organizationId: "org_acme" }, { audit });

    expect(events.map((event) => [event.action, event.outcome])).toEqual([
      [SecretsAuditActions.tableSecretWritten, "success"],
      [SecretsAuditActions.tableSecretRotated, "success"],
      [SecretsAuditActions.tableSecretWritten, "success"],
      [SecretsAuditActions.tableSecretRemoved, "success"],
      [SecretsAuditActions.tableOwnerRemoved, "success"],
    ]);
    expect(events[0]).toMatchObject({
      actorType: "user",
      actorId: "u_admin",
      resourceType: "secret",
      resourceId: "customer/STRIPE_KEY",
      metadata: { table: "customer", secret: "STRIPE_KEY", owner: alice, mode: "create" },
    });
    expect(events[4]).toMatchObject({
      resourceId: "customer",
      metadata: { table: "customer", owner: { organizationId: "org_acme" }, removed: 1 },
    });
    expect(JSON.stringify(events)).not.toContain("PLAINTEXT");
  });

  test("a refused write is audited as a failure, and still carries no value", async () => {
    const t = await table();
    const { events, audit } = recorder();
    await t.put(alice, "STRIPE_KEY", "sk_live_PLAINTEXT_ONE", { audit });
    await t.put(alice, "STRIPE_KEY", "sk_live_PLAINTEXT_TWO", { audit }).catch(() => undefined);
    expect(events.map((event) => [event.action, event.outcome, event.severity])).toEqual([
      [SecretsAuditActions.tableSecretWritten, "success", "info"],
      [SecretsAuditActions.tableSecretWritten, "failure", "warning"],
    ]);
    expect(JSON.stringify(events)).not.toContain("PLAINTEXT");
  });
});

describe("a key added by an alter", () => {
  test("a row written before it still opens, addressed with that key empty, and new rows carry it", async () => {
    await (await table()).put(alice, "STRIPE_KEY", "sk_before_the_alter");
    await secretTableMigration({
      from: { table: "customer", keys: ["userId", "organizationId"], secrets: ["STRIPE_KEY", "WEBHOOK_SIG"] },
      to: { table: "customer", keys: ["userId", "organizationId", "teamId"], secrets: ["STRIPE_KEY", "WEBHOOK_SIG"] },
    }).up(createDatabase(env.SECRETS, secretsTables));
    const Grown = defineSecretTable({
      name: "customer",
      keys: {
        userId: z.string().describe("The user."),
        organizationId: z.string().describe("The organization."),
        teamId: z.string().describe("The team."),
      },
      secrets: { STRIPE_KEY: { valueType: "text", rotatable: true } },
    });
    const t = (await secretsStore(envFor(), registry)).table(Grown);
    expect(await t.get({ ...alice, teamId: "" }, "STRIPE_KEY")).toBe("sk_before_the_alter");
    await t.put({ ...alice, teamId: "team_1" }, "STRIPE_KEY", "sk_team");
    expect(await t.get({ ...alice, teamId: "team_1" }, "STRIPE_KEY")).toBe("sk_team");
    expect((await t.list({ organizationId: "org_acme" })).map((row) => row.owner.teamId)).toEqual(["", "team_1"]);
  });
});

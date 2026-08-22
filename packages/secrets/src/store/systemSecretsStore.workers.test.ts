// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { MAX_BOUND_PARAMETERS, recordBoundParameters } from "@pithy-sh/core/src/data/boundParameters";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type EncryptionConfig, encryptValue } from "../crypto/envelope";
import { appendVersion, currentValue, initialVersionedValue, type VersionedValue } from "../crypto/versionedValue";
import { secretsTables } from "../data/tables";
import { secrets_0001_init } from "../migrations/0001_init";
import { type StoredSecretValue, SystemSecretsStore } from "./systemSecretsStore";

function randomKeyB64(): string {
  const key = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of key) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const k1 = randomKeyB64();
const config: EncryptionConfig = {
  currentVersion: "1",
  versions: { "1": k1 },
  lastRotatedAt: "2026-01-01T00:00:00.000Z",
};

function newStore(cfg: EncryptionConfig = config): SystemSecretsStore {
  return new SystemSecretsStore(createDatabase(env.SECRETS, secretsTables), cfg);
}

/**
 * The envelope behind a `readable` value, or a failure naming what came back instead.
 *
 * Every assertion that reaches through this is one the union makes unreachable without narrowing — which
 * is the whole reason the state rides on the value rather than beside it (#384).
 */
function readable(stored: StoredSecretValue | undefined): VersionedValue {
  if (stored?.state !== "readable") throw new Error(`expected a readable value, got ${stored?.state ?? "nothing"}`);
  return stored.value;
}

beforeEach(async () => {
  await env.SECRETS.prepare("drop table if exists pithy_secrets_system_secrets").run();
  await env.SECRETS.prepare("drop table if exists pithy_secrets_rotations").run();
  await secrets_0001_init.up(createDatabase(env.SECRETS, secretsTables));
});

describe("SystemSecretsStore", () => {
  test("put then getValue round-trips the value envelope", async () => {
    const store = newStore();
    await store.put("api-token", initialVersionedValue("t0p-s3cret"));

    expect(await store.getValue("api-token")).toEqual({ currentVersion: "1", versions: { "1": "t0p-s3cret" } });
  });

  test("the value is encrypted at rest — the ciphertext is not the plaintext", async () => {
    await newStore().put("api-token", initialVersionedValue("t0p-s3cret"));

    const row = await env.SECRETS.prepare(
      "select encrypted_value, value_type from pithy_secrets_system_secrets where name = ?",
    )
      .bind("api-token")
      .first<{ encrypted_value: string; value_type: string }>();
    expect(row?.encrypted_value).toBeTruthy();
    expect(row?.encrypted_value).not.toContain("t0p-s3cret");
    expect(row?.value_type).toBe("text");
  });

  test("a second put updates in place — one row, new value", async () => {
    const store = newStore();
    await store.put("k", initialVersionedValue("old"));
    await store.put("k", initialVersionedValue("new"));

    expect(await store.getValue("k")).toEqual({ currentVersion: "1", versions: { "1": "new" } });
    expect(await store.listNames()).toEqual(["k"]);
  });

  test("a multi-version envelope persists every valid version with an explicit current pointer", async () => {
    const store = newStore();
    await store.put("signing-key", appendVersion(initialVersionedValue("kid-1"), "kid-2"));

    const value = await store.getValue("signing-key");
    expect(value).toEqual({ currentVersion: "2", versions: { "1": "kid-1", "2": "kid-2" } });
    expect(value && currentValue(value)).toBe("kid-2");
  });

  test("delete removes the secret; has reflects it", async () => {
    const store = newStore();
    await store.put("k", initialVersionedValue("v"));
    expect(await store.has("k")).toBe(true);

    await store.delete("k");

    expect(await store.has("k")).toBe(false);
    expect(await store.getValue("k")).toBeUndefined();
  });

  test("getValues batch-decrypts only the requested names", async () => {
    const store = newStore();
    await store.put("a", initialVersionedValue("1"));
    await store.put("b", initialVersionedValue("2"));
    await store.put("c", initialVersionedValue("3"));

    expect(await store.getValues(["a", "b"])).toEqual({
      a: { state: "readable", value: { currentVersion: "1", versions: { "1": "1" } } },
      b: { state: "readable", value: { currentVersion: "1", versions: { "1": "2" } } },
    });
  });

  test("decrypts across an at-rest key-rotation overlap window", async () => {
    await newStore(config).put("k", initialVersionedValue("written-under-v1"));

    // The at-rest job rotates: v2 becomes current, v1 stays available to decrypt old rows.
    const rotated: EncryptionConfig = {
      currentVersion: "2",
      versions: { "1": k1, "2": randomKeyB64() },
      lastRotatedAt: "2026-02-01T00:00:00.000Z",
    };
    expect(await newStore(rotated).getValue("k")).toEqual({
      currentVersion: "1",
      versions: { "1": "written-under-v1" },
    });
  });
});

/**
 * The moved row, in the storage the envelope actually protects.
 *
 * The unit test proves the primitive refuses a foreign context; this proves the store hands it the
 * row's own name, so the refusal survives a real D1 write nothing in the store performed.
 */
describe("SystemSecretsStore and a ciphertext moved between rows", () => {
  test("a ciphertext copied into another secret's row does not decrypt", async () => {
    const store = newStore();
    await store.put("billing-webhook-secret", initialVersionedValue("the-real-value"));
    await store.put("analytics-webhook-secret", initialVersionedValue("harmless"));

    // The database-write attacker, or an ordinary row mix-up: same key, same store, wrong row.
    await env.SECRETS.prepare(
      `update pithy_secrets_system_secrets
         set encrypted_value = (select encrypted_value from pithy_secrets_system_secrets where name = ?),
             iv = (select iv from pithy_secrets_system_secrets where name = ?),
             key_version = (select key_version from pithy_secrets_system_secrets where name = ?)
       where name = ?`,
    )
      .bind("billing-webhook-secret", "billing-webhook-secret", "billing-webhook-secret", "analytics-webhook-secret")
      .run();

    await expect(store.getValue("analytics-webhook-secret")).rejects.toThrowError(
      expect.objectContaining({ payload: expect.objectContaining({ code: "secrets/crypto_failed" }) }),
    );
    // The row it was lifted from is untouched and still opens.
    expect(await store.getValue("billing-webhook-secret")).toEqual({
      currentVersion: "1",
      versions: { "1": "the-real-value" },
    });
  });

  test("renaming a row in SQL leaves a secret nothing can open — the rename goes through put", async () => {
    const store = newStore();
    await store.put("old-name", initialVersionedValue("v"));

    await env.SECRETS.prepare("update pithy_secrets_system_secrets set name = ? where name = ?")
      .bind("new-name", "old-name")
      .run();

    await expect(store.getValue("new-name")).rejects.toThrowError(
      expect.objectContaining({ payload: expect.objectContaining({ code: "secrets/crypto_failed" }) }),
    );
  });
});

/**
 * The boot read, at the size a registry can actually reach.
 *
 * `getValues` is handed **every D1-backed secret the registry declares**, so its parameter count is the
 * size of the application, not of a query. Unchunked, an app with 101 such secrets could read none of
 * them — and since every capability's secrets resolve through this one call, that is the whole Worker
 * failing to boot over a limit nothing in the registry mentions (#250).
 */
describe("SystemSecretsStore and D1's bound-parameter ceiling", () => {
  test("a registry of 200 D1-backed secrets reads at boot", { timeout: 30_000 }, async () => {
    const store = newStore();
    const names = Array.from({ length: 200 }, (_, index) => `secret-${String(index).padStart(3, "0")}`);
    for (const name of names) await store.put(name, initialVersionedValue(`value-of-${name}`));

    const values = await store.getValues(names);

    expect(Object.keys(values)).toHaveLength(200);
    expect(currentValue(readable(values["secret-137"]))).toBe("value-of-secret-137");
  });

  test("no statement binds more than D1 accepts, at any registry size", async () => {
    // Sizes spanning the cap: under it, exactly on it, one past it, and well past.
    for (const size of [1, 99, 100, 101, 250]) {
      const names = Array.from({ length: size }, (_, index) => `s${index}`);
      const { counts, error } = await recordBoundParameters(env.SECRETS, async (d1) => {
        await new SystemSecretsStore(createDatabase(d1, secretsTables), config).getValues(names);
      });

      const worst = Math.max(...counts, 0);
      expect(worst, `${size} secrets: nothing was bound`).toBeGreaterThan(0);
      expect(
        worst,
        `${size} secrets: one statement bound ${worst} parameters, over D1's cap of ${MAX_BOUND_PARAMETERS}`,
      ).toBeLessThanOrEqual(MAX_BOUND_PARAMETERS);
      if (error) throw error;
    }
  });

  test("an absent name in a big batch is still simply absent, not an error", { timeout: 30_000 }, async () => {
    const store = newStore();
    const stored = Array.from({ length: 150 }, (_, index) => `have-${index}`);
    for (const name of stored) await store.put(name, initialVersionedValue("v"));

    const values = await store.getValues([...stored, "missing-one", "missing-two"]);

    expect(Object.keys(values)).toHaveLength(150);
    expect(values["missing-one"]).toBeUndefined();
  });
});

/**
 * **The batch that must not fail as a batch (#384).**
 *
 * `getValues` is handed every `d1` secret the registry declares, in one call, at boot. It used to decrypt
 * them in a bare loop, so one row that would not open threw out of the whole read and the accessor above
 * held that failure against *every* `d1` name — including the session secret, which had opened fine. That
 * is how one unreadable OAuth credential ended email/password and magic-link sign-in for everybody (#381):
 * the precondition genuinely could not be read, because the batch carrying it had already died.
 *
 * Both causes below are ordinary. A corrupt ciphertext is a bad write or a bad restore. An orphaned
 * `keyVersion` is a master-key rotation that pruned a version some row still referenced — the one operation
 * this package runs on a cron.
 *
 * The plants go in through raw SQL on purpose. Nothing in the store can produce a row it cannot read, so a
 * gate built from the store's own writer would be a gate that cannot fail — and it would be derived from
 * the very reader it polices.
 */
describe("SystemSecretsStore and a row that will not open (#384)", () => {
  /** One stored row's sealed parts, straight out of D1 — the material that must never appear anywhere else. */
  async function sealed(name: string): Promise<{ ciphertext: string; iv: string }> {
    const row = await env.SECRETS.prepare("select encrypted_value, iv from pithy_secrets_system_secrets where name = ?")
      .bind(name)
      .first<{ encrypted_value: string; iv: string }>();
    if (!row) throw new Error(`no row stored for '${name}'`);
    return { ciphertext: row.encrypted_value, iv: row.iv };
  }

  /** Corrupt the ciphertext in place: same length, same alphabet, one byte no key will authenticate. */
  async function corruptCiphertext(name: string): Promise<void> {
    const { ciphertext } = await sealed(name);
    const head = ciphertext.startsWith("A") ? "B" : "A";
    await env.SECRETS.prepare("update pithy_secrets_system_secrets set encrypted_value = ? where name = ?")
      .bind(`${head}${ciphertext.slice(1)}`, name)
      .run();
  }

  /** Orphan the row's key version — a master-key rotation that pruned a version this row still names. */
  async function orphanKeyVersion(name: string): Promise<void> {
    await env.SECRETS.prepare("update pithy_secrets_system_secrets set key_version = 99 where name = ?")
      .bind(name)
      .run();
  }

  /** Seal something that is not a value envelope under this row's own name — it opens, and does not parse. */
  async function sealNonEnvelope(name: string): Promise<void> {
    const envelope = await encryptValue(config, name, "a plaintext that was never a versioned value");
    await env.SECRETS.prepare(
      "update pithy_secrets_system_secrets set encrypted_value = ?, iv = ?, key_version = ? where name = ?",
    )
      .bind(envelope.encryptedValue, envelope.iv, envelope.keyVersion, name)
      .run();
  }

  /** Everything reachable from a thrown value: its message, its stack, its payload, and its whole cause chain. */
  function everything(error: unknown): string {
    const parts: string[] = [];
    let cursor: unknown = error;
    while (cursor instanceof Error) {
      parts.push(cursor.message, cursor.stack ?? "", JSON.stringify((cursor as { payload?: unknown }).payload) ?? "");
      cursor = cursor.cause;
    }
    if (cursor !== undefined && cursor !== null) parts.push(String(cursor), JSON.stringify(cursor) ?? "");
    return parts.join("\n");
  }

  /** The thrown value, for assertions about it. Fails if the call resolved. */
  async function thrownBy(read: () => Promise<unknown>): Promise<unknown> {
    try {
      await read();
    } catch (error) {
      return error;
    }
    throw new Error("expected the read to throw");
  }

  test("the healthy row beside it still resolves, and the planted one refuses by name", async () => {
    const store = newStore();
    await store.put("auth-session-secret", initialVersionedValue("the-session-key"));
    await store.put("auth-github-credentials", initialVersionedValue("the-github-secret"));
    await corruptCiphertext("auth-github-credentials");

    const values = await store.getValues(["auth-session-secret", "auth-github-credentials"]);

    // The whole of #384: the bad row is one entry, filed under its own name.
    expect(values["auth-github-credentials"]).toEqual({ state: "unreadable" });
    expect(currentValue(readable(values["auth-session-secret"]))).toBe("the-session-key");
  });

  test("a key version the master key no longer holds is one unreadable row, not a dead batch", async () => {
    const store = newStore();
    await store.put("healthy", initialVersionedValue("still-here"));
    await store.put("orphaned", initialVersionedValue("sealed-under-a-pruned-key"));
    await orphanKeyVersion("orphaned");

    const values = await store.getValues(["healthy", "orphaned"]);

    expect(values.orphaned).toEqual({ state: "unreadable" });
    expect(currentValue(readable(values.healthy))).toBe("still-here");
  });

  test("a ciphertext that opens to something that is not an envelope is unreadable too", async () => {
    const store = newStore();
    await store.put("healthy", initialVersionedValue("still-here"));
    await store.put("not-an-envelope", initialVersionedValue("was-fine"));
    await sealNonEnvelope("not-an-envelope");

    const values = await store.getValues(["healthy", "not-an-envelope"]);

    // The decode is inside the same guard as the decrypt: a row that opens to a shape nothing can read is
    // as unreadable as one that does not open, and it arrives by the same routes.
    expect(values["not-an-envelope"]).toEqual({ state: "unreadable" });
    expect(currentValue(readable(values.healthy))).toBe("still-here");
  });

  test("one bad row among many costs exactly one name", async () => {
    const store = newStore();
    const names = Array.from({ length: 12 }, (_, index) => `secret-${index}`);
    for (const name of names) await store.put(name, initialVersionedValue(`value-of-${name}`));
    await corruptCiphertext("secret-7");

    const values = await store.getValues(names);

    const unreadable = names.filter((name) => values[name]?.state === "unreadable");
    expect(unreadable).toEqual(["secret-7"]);
    for (const name of names.filter((n) => n !== "secret-7")) {
      expect(currentValue(readable(values[name]))).toBe(`value-of-${name}`);
    }
  });

  /**
   * **Missing and unreadable are different facts, and the remedies do not overlap.** One says provision it;
   * the other says the value is already there and something is wrong with the row or the key. Asserted on
   * the values themselves rather than through anything that renders them.
   */
  test("a missing row and an unreadable row stay distinguishable", async () => {
    const store = newStore();
    await store.put("unreadable-one", initialVersionedValue("v"));
    await corruptCiphertext("unreadable-one");

    const values = await store.getValues(["unreadable-one", "missing-one"]);

    expect(values["unreadable-one"]).toEqual({ state: "unreadable" });
    // Absent is not a member of the union. A name with no row is simply not a key.
    expect(Object.hasOwn(values, "missing-one")).toBe(false);
    expect(values["missing-one"]).toBeUndefined();
  });

  test("getValue names the secret rather than answering undefined — a stored row is not a missing one", async () => {
    const store = newStore();
    await store.put("k", initialVersionedValue("v"));
    await corruptCiphertext("k");

    const error = await thrownBy(() => store.getValue("k"));

    expect(error).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ code: "secrets/crypto_failed", detail: expect.stringContaining("'k'") }),
      }),
    );
    // The other half of the same distinction, one call away.
    expect(await store.getValue("never-stored")).toBeUndefined();
  });

  /**
   * **A stored name is not a registry name, and one of them is caller input.** `getValue` is handed the
   * whole `<keyspace>/<key>` for a member read, so a sentence naming "the secret" names a tenant. `message`
   * crosses the HTTP boundary and `detail` is stripped there, so the key goes in the half that stays.
   */
  test("a keyspace member that will not open keeps the tenant key out of the client-visible message", async () => {
    const store = newStore();
    await store.put("connection-signing-key/conn_acme", initialVersionedValue("their-private-key"));
    await corruptCiphertext("connection-signing-key/conn_acme");

    const error = (await thrownBy(() => store.getValue("connection-signing-key/conn_acme"))) as Error & {
      payload: { code: string; message: string; detail?: string };
    };

    expect(error.payload.code).toBe("secrets/crypto_failed");
    expect(error.payload.message).not.toContain("conn_acme");
    expect(error.message).not.toContain("conn_acme");
    // The operator still gets it, in the half the HTTP codec strips.
    expect(error.payload.detail).toContain("conn_acme");
  });

  /**
   * **Nothing derived from the decryption failure travels, and the absence is shown rather than asserted.**
   *
   * The guard's `catch` takes no binding (#350), so there is no error object in scope to attach, log, or
   * fold into a `detail`. What that buys is checked here against the row's real ciphertext and IV, read
   * straight out of D1: neither appears in the serialized batch, in the serialized error, or on any console
   * channel — and the error carries no `cause`, because there was nothing to carry.
   */
  test("no ciphertext, no IV, and no decryption error text reaches the value, the error, or a console", async () => {
    const store = newStore();
    await store.put("k", initialVersionedValue("the-plaintext-nobody-may-see"));
    const { ciphertext, iv } = await sealed("k");
    await corruptCiphertext("k");
    const { ciphertext: corrupted } = await sealed("k");

    const spies = (["log", "info", "warn", "error", "debug", "trace"] as const).map((channel) =>
      vi.spyOn(console, channel).mockImplementation(() => {}),
    );

    const values = await store.getValues(["k"]);
    const error = await thrownBy(() => store.getValue("k"));

    const said = [
      JSON.stringify(values),
      everything(error),
      ...spies.flatMap((spy) => spy.mock.calls.flat().map(String)),
    ].join("\n");

    for (const forbidden of [ciphertext, corrupted, iv, "the-plaintext-nobody-may-see"]) {
      expect(said).not.toContain(forbidden);
    }
    // The three sentences the guarded call can raise: the decrypt's, `importKey`'s, and the decoder's.
    // None of them reaches here, because none of them was bound. (The remediation line names the
    // `SECRETS_ENCRYPTION_KEYS` *binding*, which is a wrangler config key and not material.)
    expect(said).not.toContain("AES-GCM decrypt failed");
    expect(said).not.toContain("tampered ciphertext");
    expect(said).not.toContain("not present in SECRETS_ENCRYPTION_KEYS");
    expect(said).not.toContain("decrypted secret plaintext");
    // Nothing was bound, so nothing was attached.
    expect((error as Error).cause).toBeUndefined();
    // And nothing was said at all.
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});

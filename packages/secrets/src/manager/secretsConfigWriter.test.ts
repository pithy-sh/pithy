// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type {
  CfSecretEntry,
  CloudflareSecretsStoreManager,
} from "@pithy-sh/cloudflare/src/secrets/secretsStoreManager";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test, vi } from "vitest";
import type { EncryptionConfig } from "../crypto/envelope";
import { masterKeySecretName } from "../provision/provisionSecrets";
import { decodeConfigStamp, MASTER_KEY_STAMP_KIND } from "./configStamp";
import { rotationConfigWriter, SecretsStoreConfigWriter } from "./secretsConfigWriter";

const PLANTED_KEY = "PLANTEDsk0000000000000000000000000000000000+/=";

const config: EncryptionConfig = {
  currentVersion: "2",
  versions: { "1": PLANTED_KEY, "2": `${PLANTED_KEY}2` },
  lastRotatedAt: "2026-02-01T00:00:00.000Z",
};

const pass = { rotationId: 7, at: new Date("2026-02-01T03:00:00.000Z") };

/** A fake Secrets Store manager exposing only what this writer reaches, with spies. */
function fakeManager(entries: CfSecretEntry[] = []) {
  const updateExistingSecret = vi.fn(async (_name: string, _value: string, _comment?: string) => "entry-id");
  const entriesNamed = vi.fn(async (name: string) => entries.filter((entry) => entry.name === name));
  return {
    manager: { updateExistingSecret, entriesNamed } as unknown as CloudflareSecretsStoreManager,
    updateExistingSecret,
    entriesNamed,
  };
}

function entry(overrides: Partial<CfSecretEntry> & { name: string }): CfSecretEntry {
  return {
    id: "id-1",
    status: "active",
    created: new Date("2026-01-01T00:00:00.000Z"),
    modified: new Date("2026-02-01T03:00:00.000Z"),
    ...overrides,
  };
}

describe("SecretsStoreConfigWriter.write", () => {
  /**
   * **The one verb, and the reason it is that verb.** `putSecret` upserts: a misnamed write-back found no
   * entry, created one, and answered 200, so the rotation believed it had persisted the new key set while
   * the binding went on serving the old one. `updateExistingSecret` cannot create, by construction.
   *
   * Fails if the writer goes back to `putSecret`, or addresses the entry by id rather than by the
   * composed name the binding resolves.
   */
  test("edits the entry the binding names, and cannot create one", async () => {
    const { manager, updateExistingSecret } = fakeManager();
    await rotationConfigWriter(manager, "acme", "staging").write(config, pass);

    expect(updateExistingSecret).toHaveBeenCalledTimes(1);
    expect(updateExistingSecret.mock.calls[0]?.[0]).toBe(masterKeySecretName("acme", "staging"));
    expect(updateExistingSecret.mock.calls[0]?.[0]).toBe("acme-staging-secrets-encryption-keys");
    expect(JSON.parse(updateExistingSecret.mock.calls[0]?.[1] ?? "{}")).toEqual(config);
  });

  test("prod targets its own entry, not staging's", async () => {
    const { manager, updateExistingSecret } = fakeManager();
    await rotationConfigWriter(manager, "acme", "prod").write(config, pass);
    expect(updateExistingSecret.mock.calls[0]?.[0]).toBe("acme-prod-secrets-encryption-keys");
  });

  test("one project's rotation can never land on another project's key entry", async () => {
    const acme = fakeManager();
    const globex = fakeManager();
    await rotationConfigWriter(acme.manager, "acme", "prod").write(config, pass);
    await rotationConfigWriter(globex.manager, "globex", "prod").write(config, pass);
    expect(acme.updateExistingSecret.mock.calls[0]?.[0]).not.toBe(globex.updateExistingSecret.mock.calls[0]?.[0]);
  });

  /**
   * The provenance the entry carries, and the rule it is under (`#386`). Fails if the comment stops being
   * sent, or if any part of it is ever derived from the key set's values.
   */
  test("stamps the pass in the entry's comment, and no key byte reaches it", async () => {
    const { manager, updateExistingSecret } = fakeManager();
    await rotationConfigWriter(manager, "acme", "staging").write(config, pass);

    const comment = updateExistingSecret.mock.calls[0]?.[2];
    expect(comment).toBeTypeOf("string");
    expect(comment).not.toContain("PLANTED");
    expect(decodeConfigStamp(comment)).toEqual({
      kind: MASTER_KEY_STAMP_KIND,
      currentVersion: "2",
      versions: ["1", "2"],
      rotationId: 7,
      at: "2026-02-01T03:00:00.000Z",
    });
  });

  /**
   * **Nothing serializes an unvalidated config into the one entry whose corruption is total outage.**
   * Fails if `EncryptionConfig.parse` is dropped from in front of the REST call — the write would go out
   * carrying a config the binding's own reader will later refuse, leaving the environment unable to
   * decrypt anything.
   */
  test("a config that would not parse is refused before any REST call", async () => {
    const { manager, updateExistingSecret } = fakeManager();
    const broken = { currentVersion: "1", versions: { "1": "k" } } as unknown as EncryptionConfig;

    await expect(rotationConfigWriter(manager, "acme", "staging").write(broken, pass)).rejects.toBeInstanceOf(
      PithyError,
    );
    expect(updateExistingSecret).not.toHaveBeenCalled();
  });

  /**
   * The comment is a verification aid; the value beside it is the key that decrypts an environment. Fails
   * if a stamp that will not compose is allowed to veto persisting the key.
   */
  test("a config the stamp cannot describe is still written, without one", async () => {
    const { manager, updateExistingSecret } = fakeManager();
    // A pointer the key set does not hold: `configStamp` declines, `EncryptionConfig` does not.
    const odd: EncryptionConfig = { ...config, currentVersion: "9", versions: { "9": PLANTED_KEY } };

    await rotationConfigWriter(manager, "acme", "staging").write({ ...odd, currentVersion: "8" }, pass);

    expect(updateExistingSecret).toHaveBeenCalledTimes(1);
    expect(updateExistingSecret.mock.calls[0]?.[2]).toBeUndefined();
  });
});

describe("SecretsStoreConfigWriter.inspect", () => {
  test("reports the entry's facts and decodes the last pass's stamp", async () => {
    const comment = JSON.stringify({
      kind: MASTER_KEY_STAMP_KIND,
      currentVersion: "2",
      versions: ["1", "2"],
      rotationId: 7,
      at: "2026-02-01T03:00:00.000Z",
    });
    const { manager } = fakeManager([entry({ name: "acme-staging-secrets-encryption-keys", comment })]);

    expect(await rotationConfigWriter(manager, "acme", "staging").inspect()).toEqual({
      name: "acme-staging-secrets-encryption-keys",
      id: "id-1",
      modifiedAt: new Date("2026-02-01T03:00:00.000Z"),
      stamp: {
        kind: MASTER_KEY_STAMP_KIND,
        currentVersion: "2",
        versions: ["1", "2"],
        rotationId: 7,
        at: "2026-02-01T03:00:00.000Z",
      },
    });
  });

  test("an operator's own note on the entry reads as no stamp, not as a failure", async () => {
    const { manager } = fakeManager([
      entry({ name: "acme-staging-secrets-encryption-keys", comment: "rotated by hand during the incident" }),
    ]);
    expect((await rotationConfigWriter(manager, "acme", "staging").inspect())?.stamp).toBeNull();
  });

  test("an entry that is not there is null, not a throw", async () => {
    const { manager } = fakeManager();
    expect(await rotationConfigWriter(manager, "acme", "staging").inspect()).toBeNull();
  });

  /**
   * **Several entries of one name is a refusal, not a choice.** Which entry a *binding* resolves is a fact
   * REST does not carry, so picking one would be a guess made on the entry that decides whether an
   * environment can read its secrets. Fails if `inspect` falls back to the oldest.
   */
  test("a duplicate beside the real entry is a conflict, including a pending one", async () => {
    const { manager } = fakeManager([
      entry({ name: "acme-staging-secrets-encryption-keys", id: "old" }),
      entry({ name: "acme-staging-secrets-encryption-keys", id: "new", status: "pending" }),
    ]);
    await expect(rotationConfigWriter(manager, "acme", "staging").inspect()).rejects.toThrow("2 entries named");
  });
});

describe("rotationConfigWriter", () => {
  test("rejects an unknown environment — the wrangler ENVIRONMENT var is validated", () => {
    const { manager } = fakeManager();
    expect(() => rotationConfigWriter(manager, "acme", "staging-typo")).toThrow(PithyError);
  });

  test("rejects a missing project — an unstamped PROJECT var must fail, not write an unscoped entry", () => {
    const { manager } = fakeManager();
    expect(() => rotationConfigWriter(manager, "", "staging")).toThrow(PithyError);
  });

  /**
   * **A feature's manager never writes back (#643).** It holds no Cloudflare API token and rotates
   * nothing, so branch code never holds write access to the account's one Secrets Store — production's
   * master key included. Composed as an environment, it would name `<project>-feature-…`, an entry every
   * branch would write.
   */
  test("refuses a feature's manager outright", () => {
    const { manager, updateExistingSecret } = fakeManager();
    expect(() => rotationConfigWriter(manager, "acme", "feature")).toThrow("does not rotate its key");
    expect(updateExistingSecret).not.toHaveBeenCalled();
  });

  test("names the entry it addresses, so a refusal can quote it", () => {
    const { manager } = fakeManager();
    expect(new SecretsStoreConfigWriter(manager, "acme-prod-secrets-encryption-keys").entryName).toBe(
      "acme-prod-secrets-encryption-keys",
    );
  });
});

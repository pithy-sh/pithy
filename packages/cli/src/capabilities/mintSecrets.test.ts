// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { decodeVersionedValue } from "@pithy-sh/secrets/src/crypto/versionedValue";
import type { SecretRegistryEntry } from "@pithy-sh/secrets/src/registry";
import { describe, expect, test } from "vitest";
import type { CliAuditEvent } from "../audit/cliAudit";
import { storeSecretMinter } from "./mintSecrets";

const entry: SecretRegistryEntry = {
  backend: "cf-secrets-store",
  scope: "environment",
  rotatable: true,
  valueType: "text",
  devValue: "random",
};

/** A store that records what it was told to write, so a test can read the envelope back. */
function recordingStore() {
  const written = new Map<string, string>();
  return { written, put: async (name: string, value: string) => void written.set(name, value) };
}

describe("storeSecretMinter", () => {
  test("writes a versioned envelope holding one fresh value", async () => {
    const store = recordingStore();
    const mint = storeSecretMinter({ store, environment: "staging" });

    await mint({ binding: "RELEASE_INGEST_SECRET", secretName: "replay-staging-release-ingest-secret", entry });

    const stored = store.written.get("replay-staging-release-ingest-secret");
    expect(stored).toBeDefined();
    const envelope = decodeVersionedValue(stored as string);
    expect(envelope.currentVersion).toBe("1");
    // 32 bytes of CSPRNG entropy, base64url and unpadded.
    expect(envelope.versions["1"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("mints a different value every time — nothing is derived from the name", async () => {
    const store = recordingStore();
    const mint = storeSecretMinter({ store, environment: "staging" });

    await mint({ binding: "A", secretName: "a", entry });
    await mint({ binding: "B", secretName: "b", entry });

    expect(store.written.get("a")).not.toEqual(store.written.get("b"));
  });

  /**
   * The one hard rule of a secrets trail: the event records that a value was written and where, and
   * nothing that could reconstruct it. This asserts against the serialized event, so a value smuggled
   * into any field at any depth fails.
   */
  test("audits the creation and never the value", async () => {
    const store = recordingStore();
    const events: CliAuditEvent[] = [];
    const mint = storeSecretMinter({
      store,
      environment: "staging",
      audit: async (event) => void events.push(event),
    });

    await mint({ binding: "RELEASE_INGEST_SECRET", secretName: "replay-staging-release-ingest-secret", entry });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      environment: "staging",
      action: "secrets/set",
      outcome: "success",
      severity: "warning",
      resourceType: "secret",
      resourceId: "replay-staging-release-ingest-secret",
    });
    const value = decodeVersionedValue(store.written.get("replay-staging-release-ingest-secret") as string).versions[
      "1"
    ];
    expect(JSON.stringify(events[0])).not.toContain(value);
  });

  /**
   * Defence in depth. The caller already asks {@link isMintableSecret} first, so reaching this is a bug —
   * and a bug that would put a random string where a real credential was meant, authenticating against
   * nothing. It refuses rather than inventing.
   */
  test("refuses an entry that declares no value of its own", async () => {
    const store = recordingStore();
    const mint = storeSecretMinter({ store, environment: "staging" });
    const supplied: SecretRegistryEntry = {
      backend: "cf-secrets-store",
      scope: "global",
      rotatable: false,
      valueType: "text",
    };

    await expect(
      mint({ binding: "STRIPE_SECRET_KEY", secretName: "replay-global-stripe", entry: supplied }),
    ).rejects.toThrow(InternalError);
    expect(store.written.size).toBe(0);
  });
});

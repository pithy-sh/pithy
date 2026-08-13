// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { SecretWriteRequest } from "@pithy-sh/secrets/src/cli/dispatch";
import { decodeVersionedValue } from "@pithy-sh/secrets/src/crypto/versionedValue";
import type { SecretRegistryEntry } from "@pithy-sh/secrets/src/registry";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { CliAuditEvent } from "../audit/cliAudit";
import { mintDeclaredSecrets, storeSecretMinter } from "./mintSecrets";

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
   * **The rule `bindingValue()` owns, at a second producer.**
   *
   * A `bootstrap` secret is read straight off its binding by code that runs before the envelope decoder
   * exists — `resolveEncryptionConfig` parses `SECRETS_ENCRYPTION_KEYS` directly — so its store entry
   * carries the current value verbatim, not the `{ currentVersion, versions }` envelope every other
   * secret is stored as. The minter wrote an envelope unconditionally. A Worker bound to that entry
   * fails at its first read, with the binding plainly present.
   *
   * `defineSecretRegistry` admits this exact entry: bootstrap must be `cf-secrets-store`, which is the
   * only backend this minter handles.
   */
  test("a bootstrap secret's entry carries the value, not the envelope", async () => {
    const store = recordingStore();
    const mint = storeSecretMinter({ store, environment: "staging" });
    const bootstrap: SecretRegistryEntry = { ...entry, scope: "global", bootstrap: true };

    await mint({ binding: "BOOTSTRAP_KEY", secretName: "replay-global-bootstrap-key", entry: bootstrap });

    const stored = store.written.get("replay-global-bootstrap-key");
    // The bare minted value: 32 bytes of CSPRNG entropy, base64url and unpadded. Not JSON, not encoded.
    expect(stored).toMatch(/^[A-Za-z0-9_-]{43}$/);
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

/** A dispatcher that records every request, so a test can read what the manager was asked to do. */
function recordingDispatcher() {
  const sent: SecretWriteRequest[] = [];
  return { sent, dispatch: async (request: SecretWriteRequest) => void sent.push(request) };
}

/** The two shapes the kit ships: a per-environment session secret, and a global link-signing key. */
const sessionSecret: SecretRegistryEntry = {
  backend: "d1",
  scope: "environment",
  rotatable: true,
  valueType: "text",
  devValue: "random",
};
const linkKey: SecretRegistryEntry = {
  backend: "d1",
  scope: "global",
  rotatable: true,
  valueType: "text",
  devValue: "random",
};

describe("mintDeclaredSecrets", () => {
  test("dispatches ensure, never create or update — a minted value is made once", async () => {
    const dispatcher = recordingDispatcher();

    await mintDeclaredSecrets({
      registry: { "auth-session-secret": sessionSecret },
      dispatcher,
      environments: ["staging"],
    });

    expect(dispatcher.sent).toHaveLength(1);
    expect(dispatcher.sent[0]).toMatchObject({
      env: "staging",
      mode: "ensure",
      name: "auth-session-secret",
      valueType: "text",
      rotatable: true,
    });
  });

  /**
   * `global` is a promise that every environment holds the same value. Email signs a link in one
   * environment and verifies it in whichever one the recipient's click reaches; a value minted per
   * environment would make every such link fail, and only for real users.
   */
  test("a global secret is minted once and reaches every environment carrying that one value", async () => {
    const dispatcher = recordingDispatcher();

    await mintDeclaredSecrets({
      registry: { "email-link-signing-key": linkKey },
      dispatcher,
      environments: ["staging", "prod"],
    });

    expect(dispatcher.sent.map((request) => request.env)).toEqual(["staging", "prod"]);
    expect(new Set(dispatcher.sent.map((request) => request.value)).size).toBe(1);
  });

  /**
   * The mirror of the rule above, and the reason this owns the environment loop rather than a caller.
   * A staging session secret that also signs prod sessions makes the environment boundary decorative.
   */
  test("an environment secret is minted afresh for each environment", async () => {
    const dispatcher = recordingDispatcher();

    await mintDeclaredSecrets({
      registry: { "auth-session-secret": sessionSecret },
      dispatcher,
      environments: ["staging", "prod"],
    });

    expect(dispatcher.sent.map((request) => request.env)).toEqual(["staging", "prod"]);
    expect(new Set(dispatcher.sent.map((request) => request.value)).size).toBe(2);
  });

  test("mints a fresh value per secret and reports the names, never the values", async () => {
    const dispatcher = recordingDispatcher();

    const minted = await mintDeclaredSecrets({
      registry: { "auth-session-secret": sessionSecret, "email-link-signing-key": linkKey },
      dispatcher,
      environments: ["staging"],
    });

    expect(minted).toEqual([
      { name: "auth-session-secret", environments: ["staging"] },
      { name: "email-link-signing-key", environments: ["staging"] },
    ]);
    const values = dispatcher.sent.map((request) => request.value);
    expect(new Set(values).size).toBe(2);
    for (const value of values) expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("leaves a supplied secret alone — a random string authenticates against nothing", async () => {
    const dispatcher = recordingDispatcher();
    const supplied: SecretRegistryEntry = {
      backend: "d1",
      scope: "environment",
      rotatable: false,
      valueType: "json",
      schema: z.object({ clientSecret: z.string().describe("The OAuth app's client secret.") }),
    };

    await mintDeclaredSecrets({
      registry: { "auth-google-credentials": supplied },
      dispatcher,
      environments: ["staging"],
    });

    expect(dispatcher.sent).toEqual([]);
  });

  test("leaves a Secrets Store secret alone — provisioning binds and creates those in one pass", async () => {
    const dispatcher = recordingDispatcher();

    await mintDeclaredSecrets({
      registry: { CONNECTION_KEY_ENCRYPTION_KEY: { ...entry } },
      dispatcher,
      environments: ["staging"],
    });

    expect(dispatcher.sent).toEqual([]);
  });

  test("leaves a keyspace alone — its members exist only at runtime", async () => {
    const dispatcher = recordingDispatcher();
    const keyspace: SecretRegistryEntry = {
      backend: "d1",
      scope: "environment",
      rotatable: true,
      valueType: "text",
      keyed: true,
    };

    await mintDeclaredSecrets({
      registry: { CONNECTION_SIGNING_KEY: keyspace },
      dispatcher,
      environments: ["staging"],
    });

    expect(dispatcher.sent).toEqual([]);
  });

  test("audits each creation by name, and never carries a value", async () => {
    const dispatcher = recordingDispatcher();
    const events: CliAuditEvent[] = [];

    await mintDeclaredSecrets({
      registry: { "auth-session-secret": sessionSecret },
      dispatcher,
      environments: ["staging"],
      audit: async (event) => void events.push(event),
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      environment: "staging",
      action: "secrets/set",
      outcome: "success",
      severity: "warning",
      resourceType: "secret",
      resourceId: "auth-session-secret",
    });
    expect(JSON.stringify(events[0])).not.toContain(dispatcher.sent[0]?.value);
  });
});

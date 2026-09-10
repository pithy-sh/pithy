// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { EncryptionConfig } from "../crypto/envelope";
import { decodeVersionedValue } from "../crypto/versionedValue";
import { initialDevSecret } from "../dev/devSecretsFile";
import { devSecretPayload } from "../dev/seedDevSecrets";
import { defineSecretRegistry, type SecretRegistryEntry } from "../registry";
import { storeEntryText } from "./entryText";

/**
 * # What a destination receives, asked of both producers (#517)
 *
 * There are two things in the kit that turn a fresh value into the string a `cf-secrets-store` entry
 * holds: `devSecretPayload(...).text`, which `storeSecretMinter` writes through because the same
 * decision governs the `.dev.vars` line beside it, and {@link storeEntryText}, which the operator-value
 * write path uses. Two producers of one answer is exactly how `#323` happened in the dev secrets file
 * and how #517 happened again at the store: the second one enveloped a `bootstrap` value the boot reader
 * parses directly, and reported success over something no Worker can read.
 *
 * So every case below asks **both**, and every case covers both shapes.
 */

/** A supplied `text` secret, and its `bootstrap` twin — the only axis that changes the answer. */
const REGISTRY = defineSecretRegistry({
  ORDINARY: { backend: "cf-secrets-store", scope: "environment", rotatable: false, valueType: "text" },
  BOOTSTRAP: {
    backend: "cf-secrets-store",
    scope: "environment",
    rotatable: false,
    valueType: "text",
    bootstrap: true,
  },
});

/** What the minter writes for the same fresh value: the dev file's payload, materialized. */
function minterText(entry: SecretRegistryEntry, name: string, value: string): string {
  return devSecretPayload(entry, name, initialDevSecret(entry, value)).text;
}

describe("storeEntryText", () => {
  test("an ordinary secret is the envelope every reader of this backend decodes", () => {
    const entry = REGISTRY.ORDINARY as SecretRegistryEntry;
    const text = storeEntryText(entry, "the-value-the-operator-holds");
    expect(decodeVersionedValue(text)).toEqual({
      currentVersion: "1",
      versions: { "1": "the-value-the-operator-holds" },
    });
    expect(text).toBe(minterText(entry, "ORDINARY", "the-value-the-operator-holds"));
  });

  /**
   * **The value, with nothing around it.** A `bootstrap` secret is read before the store its decoder
   * needs is open, so an envelope here is a value its reader cannot parse — and the reader has no way to
   * say so beyond `is not a valid EncryptionConfig`.
   */
  test("a bootstrap secret is the value itself", () => {
    const entry = REGISTRY.BOOTSTRAP as SecretRegistryEntry;
    const config = JSON.stringify({
      currentVersion: "1",
      versions: { "1": "a2V5" },
      lastRotatedAt: "2026-09-04T00:00:00.000Z",
    });
    const text = storeEntryText(entry, config);
    expect(text).toBe(config);
    expect(EncryptionConfig.safeParse(JSON.parse(text)).success).toBe(true);
    expect(text).toBe(minterText(entry, "BOOTSTRAP", config));
  });

  /**
   * The bug in one line: an envelope around a `bootstrap` payload parses as JSON and is not the thing.
   * A test that only checked "the value is in there somewhere" passed for four rounds of this issue.
   */
  test("the two shapes are not interchangeable", () => {
    const config = JSON.stringify({
      currentVersion: "1",
      versions: { "1": "a2V5" },
      lastRotatedAt: "2026-09-04T00:00:00.000Z",
    });
    const enveloped = storeEntryText(REGISTRY.ORDINARY as SecretRegistryEntry, config);
    expect(enveloped).not.toBe(config);
    expect(EncryptionConfig.safeParse(JSON.parse(enveloped)).success).toBe(false);
  });
});

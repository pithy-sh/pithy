// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import {
  encodeVersionedValue,
  initialVersionedValue,
  type VersionedValue,
} from "@pithy-sh/secrets/src/crypto/versionedValue";
import type { RotationLedger } from "@pithy-sh/secrets/src/rotation/rotationLedger";
import { runValueRotation, type ValueRotationSteps } from "@pithy-sh/secrets/src/rotation/valueRotation";
import { secretsStoreVersionStore } from "@pithy-sh/secrets/src/rotation/versionStore";
import { describe, expect, test } from "vitest";
import { EMAIL_LINK_SIGNING_KEY, emailSigningRegistry } from "./signingKey";
import { mintToken, verifyToken } from "./token";

/**
 * **A link signed before a rotation verifies inside the overlap, and is rejected after it (#602).**
 *
 * The link-signing key is the kit's secret whose loss outlives the system: a link is already in somebody's
 * inbox. So it is rotated the way the secrets manager rotates it — through the real `runValueRotation`,
 * against its real registry entry, over a Secrets Store entry held in memory — and a link minted under the
 * old key is presented at three moments: before, during the overlap, and after retirement.
 */

const AUD = "https://acme.test";
const NOW = new Date("2026-10-18T03:00:00.000Z");
const ninetyDaysOn = new Date(NOW.getTime() + 120 * 86_400_000);

const claims = {
  kind: "unsubscribe" as const,
  jobId: "job-1",
  recipient: "u@example.com",
};

/** The entry's plaintext, as the binding would serve it. */
let entry: string;

function keys(): { currentVersion: string; versions: Record<string, string> } {
  return JSON.parse(entry) as VersionedValue;
}

const ledger: RotationLedger = { open: async () => ({ close: async () => undefined }) };

describe("the link-signing key, rotated unattended", () => {
  test("declares an overlap as long as a link lives", () => {
    expect(emailSigningRegistry[EMAIL_LINK_SIGNING_KEY].overlap).toEqual({ days: 90, minimumDays: 90 });
  });

  test("a link signed before the rotation still verifies inside the overlap and is rejected after it", async () => {
    entry = encodeVersionedValue(initialVersionedValue("link-key-version-one"));
    const link = await mintToken(claims, {
      key: "link-key-version-one",
      kid: "1",
      expiresAt: ninetyDaysOn,
      audience: AUD,
    });
    expect(await verifyToken(link, keys(), NOW, AUD)).toMatchObject(claims);

    let duringOverlap: Promise<unknown> | undefined;
    const steps: ValueRotationSteps = {
      do: (_name, fn) => fn(),
      sleep: async (name) => {
        if (name === "overlap") {
          // The rotation has landed: a new key is current and new links are signed with it...
          expect(keys().currentVersion).toBe("2");
          // ...and the link already in the inbox still verifies.
          duringOverlap = verifyToken(link, keys(), NOW, AUD);
        }
      },
    };
    const result = await runValueRotation(
      {
        name: EMAIL_LINK_SIGNING_KEY,
        entry: { ...emailSigningRegistry[EMAIL_LINK_SIGNING_KEY], rotateEveryDays: 365 },
        environment: "prod",
        store: secretsStoreVersionStore({
          read: async () => entry,
          write: async (_name, text) => {
            entry = text;
          },
        }),
        ledger,
        holdRetirement: async () => undefined,
        pending: async () => [],
        emit: async () => undefined,
        rotatedBy: "value-email-link-signing-key-2026-10-18",
      },
      steps,
    );

    expect(result).toEqual({ status: "rotated", version: "2", retired: ["1"], held: [] });
    await expect(duringOverlap).resolves.toMatchObject(claims);
    // Retired: the key it was signed with is gone, so it no longer verifies, however long its own expiry.
    await expect(verifyToken(link, keys(), NOW, AUD)).rejects.toThrow();
  });
});

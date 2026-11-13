// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/** The App Attest environment a key was attested in, as its AAGUID names it. */
export const AppAttestEnvironment = z
  .enum(["production", "development"])
  .describe(
    "The App Attest environment a key was attested in: `production` for TestFlight and App Store builds, `development` for a build carrying the development App Attest entitlement.",
  );
export type AppAttestEnvironment = z.output<typeof AppAttestEnvironment>;

/**
 * `pithy_auth_app_attest_keys`: an App Attest key an iOS app registered with an attestation Apple signed.
 *
 * One row per key, written once by the key route and then only its counter and last use, by each assertion that
 * verifies (`../attestation/appAttest/keys.ts`). A key belongs to one install of the app, not to a person: it is
 * registered before anybody signs in, and names no user.
 */
export const AppAttestKey = z
  .object({
    id: z
      .string()
      .describe("Primary key: the App Attest key id, unpadded base64url of its 32 bytes, SHA-256 of `publicKey`."),
    publicKey: z
      .string()
      .describe(
        "The key's P-256 public key, an X9.62 uncompressed point, unpadded base64url. Assertions verify with it.",
      ),
    appId: z.string().describe("The App ID the key was attested for: `<TeamID>.<bundleId>`."),
    environment: AppAttestEnvironment,
    counter: z
      .number()
      .int()
      .nonnegative()
      .describe("The counter of the last assertion accepted, 0 at registration. Each assertion must exceed it."),
    createdAt: SQLiteDate.describe("When the key was registered. Ms-epoch in SQLite."),
    lastUsedAt: SQLiteDate.nullable().describe(
      "When an assertion by this key last verified, or null before the first. Ms-epoch in SQLite.",
    ),
  })
  .describe("A registered App Attest key in `pithy_auth_app_attest_keys`.");
export type AppAttestKey = z.output<typeof AppAttestKey>;

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { CarriesNoValue } from "../admin/status";
import { RotationStatus, RotationTrigger } from "../data/secretRotations";
import { SecretBackend, SecretValueType } from "../registry";

/**
 * What the secrets management routes return, as Zod objects a client can validate against.
 *
 * `schemas.ts` bounds what a caller may send; this file states what it gets back. Both halves are
 * runtime values rather than interfaces because a management client reading a customer's Worker is
 * crossing a trust boundary and must validate what comes back — and a TypeScript interface is erased
 * before it can help, so every client that had only an interface hand-wrote a mirror and the mirror
 * drifted the first time a field landed here.
 *
 * **No codecs and no transforms.** These describe JSON on the wire, so parsing one hands back exactly
 * what went in. Dates render as ISO-8601 strings: they are ms-epoch integers in SQLite and `Date`s in
 * TypeScript, and a JSON number would leave every client guessing the unit.
 *
 * **Nothing here can carry a value.** The field lists are the same argument `admin/status.ts` makes
 * about its reader shapes, restated at the wire, and {@link SECRET_RESPONSES_CARRY_NO_VALUE} is the
 * compile-time tripwire that keeps it true. A ciphertext, an IV, a metadata snapshot and a rotation's
 * error message are all absent from the type rather than omitted by a projection.
 */

/** One rotation attempt on the wire. */
export const SecretRotationView = z
  .object({
    startedAt: z.iso.datetime().describe("When the rotation attempt began, ISO-8601."),
    completedAt: z.iso.datetime().nullable().describe("When it finished, ISO-8601; null while it is still running."),
    status: RotationStatus.describe("How it ended: `in_progress`, `success`, or `failed`."),
    trigger: RotationTrigger.describe("What caused it: `cron`, `manual`, or the `baseline` marker on first write."),
    rotatedBy: z.string().describe("Who or what initiated it — a workflow instance id, an operator id, or `baseline`."),
  })
  .describe("One rotation attempt as a client reads it. A failure is a status, never a message.");
export type SecretRotationView = z.output<typeof SecretRotationView>;

/** One secret's status on the wire. */
export const SecretStatusView = z
  .object({
    name: z.string().describe("The secret's registry name."),
    backend: SecretBackend.describe("Where the value lives. Decides what a null `createdAt` means."),
    valueType: SecretValueType.describe("How the value is interpreted: `text` or `json`."),
    rotatable: z.boolean().describe("Whether a value-rotator may manage it. Never changes what is reported."),
    keyVersion: z
      .number()
      .int()
      .nullable()
      .describe("Which master-key version the stored envelope sits under, or null when nothing is stored here."),
    createdAt: z.iso
      .datetime()
      .nullable()
      .describe("When it was first written to this store, ISO-8601; null when it is not stored here."),
    updatedAt: z.iso
      .datetime()
      .nullable()
      .describe("When its value was last written, ISO-8601; null when it is not stored here."),
    lastRotatedAt: z.iso
      .datetime()
      .nullable()
      .describe(
        "The newest successful rotation, ISO-8601, or **null for never rotated** — not zero, and not the epoch.",
      ),
    rotationCount: z
      .number()
      .int()
      .nonnegative()
      .describe("How many rotation attempts are recorded, successful or not."),
    rotateEveryDays: z
      .number()
      .int()
      .positive()
      .nullable()
      .describe("The cadence the registry declares for this secret, or null when it declares none."),
    overdue: z
      .boolean()
      .nullable()
      .describe("Whether it is past that cadence. Null when the question has no answer, which is not the same as no."),
  })
  .describe("One secret's status as a client reads it. Metadata only — this shape cannot express a value.");
export type SecretStatusView = z.output<typeof SecretStatusView>;

/** `GET {base}/admin/status` — every declared secret. */
export const SecretsStatusResponse = z
  .object({
    secrets: z
      .array(SecretStatusView)
      .describe("Every named secret the composed Worker declares, by name. Keyed entries are excluded."),
  })
  .describe("The status of every declared secret.");
export type SecretsStatusResponse = z.output<typeof SecretsStatusResponse>;

/** `GET {base}/admin/status/:name/rotations` — one secret's history. */
export const SecretRotationsResponse = z
  .object({
    name: z.string().describe("The secret this history belongs to, echoed so a client can label it."),
    rotations: z.array(SecretRotationView).describe("Its rotation attempts, newest first, capped by `limit`."),
  })
  .describe("One secret's rotation history.");
export type SecretRotationsResponse = z.output<typeof SecretRotationsResponse>;

/**
 * The wire half of the constraint. `true` only while no response shape names a value-bearing field; add
 * one and this assignment stops compiling.
 */
export const SECRET_RESPONSES_CARRY_NO_VALUE: CarriesNoValue<SecretStatusView> & CarriesNoValue<SecretRotationView> =
  true;

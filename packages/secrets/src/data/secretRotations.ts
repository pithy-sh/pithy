// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

export const RotationStatus = z
  .enum(["in_progress", "success", "failed"])
  .describe("Lifecycle state of a rotation attempt: `in_progress` while running, then `success` or `failed`.");
export type RotationStatus = z.output<typeof RotationStatus>;

export const RotationTrigger = z
  .enum(["cron", "manual", "baseline"])
  .describe(
    "What caused the rotation: a scheduled `cron` run, a `manual` operator action, or a `baseline` marker recorded when a secret is first established.",
  );
export type RotationTrigger = z.output<typeof RotationTrigger>;

/**
 * The `pithy_secrets_rotations` table — an append-only audit row per rotation attempt, in
 * the per-environment secrets D1. Records both at-rest encryption-key rotations and (later)
 * value rotations. Ported from the CMS `secret_rotations` model.
 */
export const SecretRotation = z
  .object({
    id: z.number().int().describe("Auto-incrementing primary key for this rotation event."),
    name: z
      .string()
      .describe(
        "Secret being rotated (matches a registry entry / `pithy_secrets_system_secrets.name`), or a sentinel for whole-store key rotation.",
      ),
    startedAt: SQLiteDate.describe("When the rotation attempt began. Ms-epoch in SQLite, a `Date` in app code."),
    completedAt: SQLiteDate.nullable().describe("When the rotation finished; null while in progress."),
    status: RotationStatus.describe("Lifecycle state of the rotation event."),
    trigger: RotationTrigger.describe("What caused this rotation."),
    rotatedBy: z
      .string()
      .describe("Identifier of the agent that initiated the rotation (workflow instance id, operator id, etc.)."),
    errorMessage: z
      .string()
      .nullable()
      .describe("Human-readable failure reason; populated when status is `failed`, otherwise null."),
    metadataSnapshot: z
      .string()
      .nullable()
      .describe("Opaque JSON snapshot captured at rotation time (per-secret, heterogeneous). Null when none."),
  })
  .describe("One append-only rotation audit row in the per-environment secrets D1 (`pithy_secrets_rotations`).");
export type SecretRotation = z.output<typeof SecretRotation>;

/**
 * The sentinel name a whole-store at-rest key rotation is recorded under in `pithy_secrets_rotations`.
 *
 * **A ledger fact, and so it lives with the ledger (#647).** It used to sit in
 * `rotation/atRestKeyRotation.ts`, beside the one function that writes rows under it, which read as the
 * obvious home for exactly as long as writing was the only thing anyone did with it. Three readers now
 * ask about it and none of them rotates anything: the status listing hides the sentinel from a per-secret
 * view, the health key reports the last pass's outcome, and `pithy secrets verify` names it. A name three
 * readers resolve through the module that performs the write is a dependency on the writer for a fact
 * about the table, which is what puts the admin surface one import away from the rotation body.
 *
 * It is not a secret name and no registry declares it. The `__` fences it off from any name an adopter
 * could choose, so a per-secret query that filters it out cannot be filtering out somebody's real secret.
 */
export const AT_REST_ROTATION_NAME = "__at_rest_key_rotation__";

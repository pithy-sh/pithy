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

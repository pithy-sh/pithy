// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import type { EncryptionConfig } from "@pithy-sh/core/src/crypto/envelope";
import {
  FIELD_KEY_ROTATION_DAYS,
  type FieldKeys,
  liveVersions,
  resolveFieldKeys,
} from "@pithy-sh/core/src/crypto/fieldKeys";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { EncryptedColumnStamp } from "@pithy-sh/core/src/privacy/encryptedColumns";
import { versionsDue } from "@pithy-sh/core/src/privacy/retirement";
import type { SecretsStoreEnv } from "../env/bindings";
import type { StepRunner } from "../rotation/atRestKeyRotation";
import { type FieldKeyCommand, type FieldKeyReport, runFieldKeyCommand } from "../rotation/fieldKeyRotation";
import { isRotationDue } from "../rotation/keyRotation";
import { RotationTracker } from "../store/rotationTracker";
import type { ConfigReader } from "./configReader";
import type { ConfigWriter } from "./configWriter";

/**
 * **The field-key Workflow's body, and the cron half that starts it** (#390).
 *
 * Built from the manager's env: its `PITHY_FIELD_KEYS` binding, the `ENCRYPTED_COLUMNS` stamp `pithy secrets
 * provision` and `pithy deploy` write, and the D1 each stamped column lives in, bound under the app's own binding
 * name. The config writer is injected, as the at-rest rotation's is, because the write-back is the one step that
 * needs a live Secrets Store.
 */

/** The manager env the field-key rotation reads. */
export interface FieldKeyEnv extends SecretsStoreEnv {
  /** The field key, a Secrets Store binding deployed and a string locally. Absent on a manager from before #390. */
  PITHY_FIELD_KEYS?: FieldKeys;
  /** The encrypted columns, as JSON. Absent: none were stamped. */
  ENCRYPTED_COLUMNS?: string;
  /** The field-key rotation Workflow binding, started by the cron. */
  FIELD_KEY_ROTATION?: { create(options?: { id?: string; params?: FieldKeyCommand }): Promise<unknown> };
}

/**
 * The stamp the manager was deployed with. Absent is no columns; anything that does not parse is refused, naming the
 * var and nothing in it, because a stamp nobody can read is a set of columns the guard can never count.
 */
export function encryptedColumnStamp(env: FieldKeyEnv): EncryptedColumnStamp {
  if (env.ENCRYPTED_COLUMNS === undefined) return { columns: [], unread: [], unrotatable: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(env.ENCRYPTED_COLUMNS);
  } catch {
    throw new InternalError({ detail: "ENCRYPTED_COLUMNS is not valid JSON" });
  }
  const parsed = EncryptedColumnStamp.safeParse(raw);
  if (!parsed.success) throw new InternalError({ detail: "ENCRYPTED_COLUMNS is not a valid encrypted-column stamp" });
  return parsed.data;
}

/** The read-back seam over this Worker's own `PITHY_FIELD_KEYS` binding. */
export function fieldKeysConfigReader(env: FieldKeyEnv): ConfigReader {
  return { read: () => resolveFieldKeys(env.PITHY_FIELD_KEYS) };
}

/** A D1 binding from the env by name, or `undefined`. */
function d1Of(env: FieldKeyEnv, binding: string): D1Database | undefined {
  const value = (env as unknown as Record<string, unknown>)[binding];
  return typeof value === "object" && value !== null && typeof (value as { prepare?: unknown }).prepare === "function"
    ? (value as D1Database)
    : undefined;
}

/** Run one field-key command against this manager's own bindings. */
export async function runFieldKeyWorkflow(
  env: FieldKeyEnv,
  writer: () => Promise<Pick<ConfigWriter, "write">>,
  step: StepRunner,
  command: FieldKeyCommand,
  options: { instanceId?: string; emit: AuditEmit; reader?: ConfigReader },
): Promise<FieldKeyReport> {
  const config: EncryptionConfig = await resolveFieldKeys(env.PITHY_FIELD_KEYS);
  return runFieldKeyCommand(
    {
      config,
      stamp: encryptedColumnStamp(env),
      database: (binding) => d1Of(env, binding),
      // Built on the first write, so a guard read — which writes nothing — reads no token and builds no client.
      writer: { write: async (next, pass) => (await writer()).write(next, pass) },
      reader: options.reader ?? fieldKeysConfigReader(env),
      tracker: RotationTracker.fromD1(env.SECRETS),
      emit: options.emit,
    },
    step,
    command,
    options.instanceId === undefined ? {} : { rotatedBy: options.instanceId },
  );
}

/** The instance id for one night's field-key pass: one per mode, pointer and UTC day, so a redelivered tick is one. */
export function fieldKeyInstanceId(mode: "rotate" | "backfill", pointer: string, at: Date): string {
  return `field-keys-${mode}-${pointer}-${at.toISOString().slice(0, 10)}`;
}

/**
 * The cron half: start a rotation when the field key's period has passed, and otherwise a backfill when a version
 * is past the window, so a table too large for one night is cleared across several. A manager deployed before
 * #390 binds no field key and starts nothing.
 */
export async function scheduleFieldKeyRotation(
  env: FieldKeyEnv,
  now: Date,
  start: (id: string, command: FieldKeyCommand) => Promise<void>,
): Promise<void> {
  if (env.PITHY_FIELD_KEYS === undefined) return;
  const config = await resolveFieldKeys(env.PITHY_FIELD_KEYS);
  if (isRotationDue(config.lastRotatedAt, FIELD_KEY_ROTATION_DAYS, now)) {
    await start(fieldKeyInstanceId("rotate", config.currentVersion, now), { mode: "rotate" });
    return;
  }
  if (versionsDue(liveVersions(config), Number(config.currentVersion)).length > 0) {
    await start(fieldKeyInstanceId("backfill", config.currentVersion, now), { mode: "backfill" });
  }
}

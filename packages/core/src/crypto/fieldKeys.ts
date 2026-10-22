// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { remedy } from "../cli/command";
import { InternalError } from "../error/pithyError";
import { EncryptionConfig } from "./envelope";

/**
 * **The field key: what an app Worker seals its encrypted fields with** (#390).
 *
 * `PITHY_FIELD_KEYS` is an {@link EncryptionConfig}, the same versioned shape as secrets' master key, and it is a
 * **different key on purpose**. Field encryption seals and opens inside the adopter's own Workers, so every Worker that
 * holds an encrypted field must hold the key it uses. Were that the master key `SECRETS_ENCRYPTION_KEYS`, every such
 * Worker would hold the key to the whole secrets vault, and one compromised would open it. A key of its own limits
 * that to the fields: a Worker that holds an encrypted field and composes no `secrets` is bound this key and never
 * the master key.
 *
 * It is not a second mechanism: `pithy secrets provision` mints it beside the master key, in the same format, binds
 * it to every Worker that holds an encrypted field, and the manager's at-rest cron rotates it every
 * {@link FIELD_KEY_ROTATION_DAYS} days.
 */

/** The binding an app Worker reads its field key through. Fixed across environments; only the store entry is scoped. */
export const FIELD_KEYS_BINDING = "PITHY_FIELD_KEYS";

/** How often the manager rotates the field key, in days. */
export const FIELD_KEY_ROTATION_DAYS = 30;

/** A Secrets Store binding: `.get()` resolves the plaintext inside the Worker. */
export interface FieldKeyBinding {
  get(): Promise<string>;
}

/**
 * Where a field key comes from: the Worker's `env.PITHY_FIELD_KEYS` binding (a Secrets Store binding deployed, a JSON
 * string from `.dev.vars` locally), or a config a caller already resolved.
 */
export type FieldKeys = FieldKeyBinding | string | EncryptionConfig;

/**
 * Resolve a field key to its config. A missing binding, text that is not JSON, and JSON that is not a key set are each
 * refused, and **nothing read is ever echoed**: what failed to parse is the key set.
 */
export async function resolveFieldKeys(keys: FieldKeys | undefined): Promise<EncryptionConfig> {
  let raw: unknown = keys;
  if (keys === undefined || keys === null) {
    throw new InternalError({
      message: "This Worker holds an encrypted field and no field key.",
      action: `Bind ${FIELD_KEYS_BINDING}. ${remedy("secrets provision").say((command) => `${command} binds it to every Worker with an encrypted field.`)}`,
      detail: `${FIELD_KEYS_BINDING} binding is not configured`,
    });
  }
  if (typeof keys === "object" && "get" in keys && typeof keys.get === "function") raw = await keys.get();
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new InternalError({ detail: `${FIELD_KEYS_BINDING} is not valid JSON` });
    }
  }
  const parsed = EncryptionConfig.safeParse(raw);
  if (!parsed.success) throw new InternalError({ detail: `${FIELD_KEYS_BINDING} is not a valid EncryptionConfig` });
  return parsed.data;
}

/**
 * Every live version in a key set, newest first, as numbers. A version key that is not an integer is refused rather
 * than sorted as text, where `"10"` sorts before `"9"`.
 */
export function liveVersions(config: EncryptionConfig): number[] {
  const versions = Object.keys(config.versions).map(Number);
  if (!versions.every((version) => Number.isInteger(version))) {
    throw new InternalError({ detail: `${FIELD_KEYS_BINDING}: a version key is not a stringified integer` });
  }
  return versions.sort((left, right) => right - left);
}

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError, UpstreamError } from "@pithy-sh/core/src/error/pithyError";
import { EncryptionConfig } from "../crypto/envelope";
import { resolveBinding, type SecretsStoreEnv } from "../env/bindings";
import { MASTER_KEY_BINDING } from "../env/masterKeyBinding";
import { SecretCryptoError } from "../error/errors";

/**
 * **The read-back seam for the master-key config — the half `#647` was missing.**
 *
 * The rotation writes the key set to Cloudflare Secrets Store **over REST, addressed by composed entry
 * name**, and every consumer reads it back **through the `SECRETS_ENCRYPTION_KEYS` binding**. Nothing
 * reconciled the two, and nothing could: the write upserted, so a write to an entry name the binding
 * does not point at returned 200 and quietly created an orphan. A pass that then re-encrypted the store
 * under the new key left every row unreadable, silently, at the next read.
 *
 * **It has to be the binding, and REST cannot substitute for it.** Cloudflare does not serve a Secrets
 * Store secret's plaintext over the API — bind-only, by design. REST can confirm a name, a comment and a
 * timestamp (`configStamp.ts`); only the binding can confirm that the bytes a Worker will decrypt with
 * are the bytes that were written.
 *
 * It is a seam rather than a call because it must be wired from a different source than the writer. An
 * implementation holding both ends could satisfy a write and then answer its own read-back from memory,
 * and every stub would pass — which is the exact reconciliation the defect is about.
 */
export interface ConfigReader {
  /**
   * Re-resolve the master-key config through the binding.
   *
   * Called once per read-back attempt, each attempt its own durable step, because a Worker isolate may
   * hold a binding's value for the life of that isolate. A loop inside one step re-reads one cached
   * answer; a Workflow resume may land in a fresh isolate, which is the only wait that can change it.
   */
  read(): Promise<EncryptionConfig>;
}

/**
 * The real {@link ConfigReader}: this Worker's own `SECRETS_ENCRYPTION_KEYS` binding.
 *
 * ## Why it does not simply call `resolveEncryptionConfig`
 *
 * Because the two failures it can have are not the same fact, and the rotation's bounded poll is built
 * on telling them apart. `resolveEncryptionConfig` answers `secrets/crypto_failed` to a binding that
 * would not answer *and* to a payload that will not parse, and `secretsWorkflowRetry` lists that code as
 * terminal by name — so a momentary store fault during the read-back would have ended the rotation
 * instance on its first attempt, at the one step the whole sequence hangs on.
 *
 * So the split is stated here, where the cause is still in hand:
 *
 *   - a binding that is not wired is `secrets/not_found` — structural, and the next attempt finds the
 *     same nothing;
 *   - a binding that **would not answer** is `core/upstream_failed` — the platform's business, re-driven
 *     with backoff, and it costs the read-back's budget nothing, because that budget counts only reads
 *     that succeeded and did not show the write;
 *   - a payload that parsed as far as it could and is wrong is `secrets/crypto_failed` — terminal, which
 *     is right: a malformed master-key entry is an incident for an operator, and the rotation aborts
 *     before re-encrypting anything rather than polling a config that will never become valid.
 *
 * Validation itself goes through `EncryptionConfig`, the same schema every consumer uses. A read-back
 * that validated more loosely would confirm a config the Worker will later refuse; one that validated
 * differently would be a second opinion about what a valid key set is.
 */
export function bindingConfigReader(env: SecretsStoreEnv): ConfigReader {
  return {
    async read(): Promise<EncryptionConfig> {
      let raw: string;
      try {
        raw = await resolveBinding(env.SECRETS_ENCRYPTION_KEYS, MASTER_KEY_BINDING);
      } catch (cause) {
        // A `PithyError` from here is `resolveBinding`'s own refusal — the binding is not configured,
        // which is a deployment fact and not a blip. Anything else came out of Cloudflare's `.get()`.
        if (cause instanceof PithyError) throw cause;
        throw new UpstreamError(
          {
            message: "The Secrets Store did not answer for this environment's master key.",
            action: `Nothing to change. The read is retried; if it keeps failing, check the ${MASTER_KEY_BINDING} binding on this Worker.`,
            detail: `${MASTER_KEY_BINDING} binding read failed`,
          },
          { cause },
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (cause) {
        // No `cause.message` and no slice of `raw`: what failed to parse is the key set (`#386`).
        throw new SecretCryptoError({ detail: `${MASTER_KEY_BINDING} is not valid JSON` }, { cause });
      }
      const result = EncryptionConfig.safeParse(parsed);
      if (!result.success) {
        // Not `fromZodError`, deliberately: Zod's rendering carries the input it refused, and the input
        // here is the key set. The binding name is the whole of what an operator needs.
        throw new SecretCryptoError({ detail: `${MASTER_KEY_BINDING} is not a valid EncryptionConfig` });
      }
      return result.data;
    },
  };
}

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { appendVersion, initialVersionedValue } from "./crypto/versionedValue";
import { SecretAlreadyExistsError, SecretNotFoundError } from "./error/errors";
import type { SecretValueType } from "./registry";
import type { RotationTracker } from "./store/rotationTracker";
import type { SystemSecretsStore } from "./store/systemSecretsStore";

/**
 * The **request-path** write for one keyspace member — the counterpart to `management/writeSecret.ts`,
 * and a different operation rather than a nicer API for the same one.
 *
 * Sealing can only happen in a Worker: the master key is a binding, and the CLI does not have it. The
 * management path respects that by dispatching a Workflow, which runs in the Worker — correct for a
 * secret an operator provisions, because nobody is waiting on the response. It does not fit a
 * credential an application mints *during* a request. A connect flow generates a keypair, must seal the
 * private half, and must return the public half in the same response; it cannot dispatch a Workflow and
 * wait. Returning a public key whose private half is not yet stored hands out a credential that cannot
 * be used, and discovers it later, at the customer.
 *
 * So this runs inline, on the request, through the same {@link SystemSecretsStore} and therefore the
 * same AES-256-GCM envelope, the same bound name (`<entry>/<key>`, so one tenant's ciphertext does not
 * open under another's), and the same `pithy_secrets_system_secrets` row every other secret uses. That
 * last part is not a detail: the at-rest key rotation re-encrypts *rows*, keyed on nothing but
 * `keyVersion`, so a member written here is picked up by it. A second storage path would have been a
 * set of rows the cron never visits — the ones that quietly cannot be opened after a rotation.
 *
 * The promise resolving **is** the persistence guarantee. Nothing is queued and nothing is deferred, so
 * a caller that awaits this before returning a credential knows the sealed half is stored.
 */

/**
 * What a write is allowed to do to a member that already exists.
 *
 * `create` refuses one — the default, because the failure worth designing against is a signing key
 * silently overwritten mid-rotation, and a create-or-replace default makes that a typo away.
 * `replace` is the explicit form: every prior version is discarded, which is what a compromised
 * credential needs and what a retained one must never get by accident. `rotate` appends the value as
 * the next version and keeps the old ones valid — the two-keys-during-rotation window `getKeyedVersions`
 * exists to serve.
 */
export type KeyedWriteMode = "create" | "replace" | "rotate";

/** One member write, as the accessor hands it to the store. */
export interface KeyedMemberWrite {
  /**
   * The keyspace the member belongs to. Carried beside {@link storedName} because a refusal names the
   * keyspace and never the key: `detail` reaches logs verbatim, and the key identifies one tenant.
   */
  keyspace: string;
  /** The member's stored name, `<entry>/<key>`, composed by `keyedSecretName` and never by hand. */
  storedName: string;
  /** What the write may do to an existing member. */
  mode: KeyedWriteMode;
  /** The serialized value — a `text` value as it stands, a `json` value already stringified. */
  value: string;
  /** The keyspace's value type, persisted on the row so a read knows how to interpret it. */
  valueType: SecretValueType;
  /** Whether the keyspace is rotatable — drives the rotation baseline on a create. */
  rotatable: boolean;
}

/** What a member write needs: the encrypted store, and the tracker that owns rotation history. */
export interface KeyedWriteDeps {
  store: SystemSecretsStore;
  tracker: RotationTracker;
}

/**
 * Write one member and return its current version key.
 *
 * The existence check and the write are two statements, as they are in `runWriteSecret` — D1 has no
 * transaction to put around them. The window is real and it is the narrowest one available; what it
 * cannot do is turn a `create` into a silent overwrite, because the write that follows a passed check
 * still refuses nothing and *overwrites* nothing a concurrent create could have put there. Two
 * simultaneous creates for one tenant is a shape the caller already has to make impossible, since it
 * would mint two credentials whatever this did.
 */
export async function runKeyedWrite(deps: KeyedWriteDeps, params: KeyedMemberWrite): Promise<string> {
  if (params.mode === "rotate") {
    // The only mode that reads the plaintext: appending a version needs the versions already there.
    const existing = await deps.store.getValue(params.storedName);
    if (!existing) {
      throw new SecretNotFoundError({
        message: `Secret '${params.keyspace}' has no value for that key.`,
        action: "Create the member before rotating it.",
        detail: `keyspace '${params.keyspace}': rotate found no member stored under the requested key`,
      });
    }
    const next = appendVersion(existing, params.value);
    await deps.store.put(params.storedName, next, params.valueType);
    return next.currentVersion;
  }

  const exists = await deps.store.has(params.storedName);
  if (params.mode === "create" && exists) {
    throw new SecretAlreadyExistsError({
      message: `Secret '${params.keyspace}' already has a value for that key.`,
      action: "Rotate the member to add a version, or pass replace to discard the stored one.",
      detail: `keyspace '${params.keyspace}': create found a member already stored under the requested key`,
    });
  }

  const next = initialVersionedValue(params.value);
  await deps.store.put(params.storedName, next, params.valueType);

  // Same rule the management write follows: a brand-new rotatable secret gets a baseline, so nothing
  // that measures rotation age reports a member as overdue purely for having no history. It is when
  // this tenant's credential was established, which is a question with an answer that does not touch
  // the value.
  //
  // Unlike the management write there is no "has it any history" probe first, because a member that
  // does not exist cannot have any: {@link runKeyedRemove} purges the history with the row, and so
  // does the management delete. Paying a query per create to re-establish that on a request path is
  // the wrong trade.
  if (params.rotatable && !exists) await deps.tracker.recordBaseline(params.storedName);
  return next.currentVersion;
}

/**
 * Remove one member — every version of it, and its rotation history, as one operation.
 *
 * Every version goes because they are one row: a member's `{ currentVersion, versions }` envelope is a
 * single sealed value, so there is no loop for a caller to write and no version that can survive the
 * tenant it belonged to. The history goes for the reason the management delete purges it — rows naming
 * a secret that no longer exists are rows nothing will ever explain.
 *
 * Idempotent. Removing a tenant twice is a normal shape (a retry, a redelivered webhook), and the
 * second call must not be an error the caller has to special-case.
 */
export async function runKeyedRemove(deps: KeyedWriteDeps, storedName: string): Promise<void> {
  await deps.store.delete(storedName);
  await deps.tracker.purgeHistory(storedName);
}

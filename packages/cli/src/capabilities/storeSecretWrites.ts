// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { ProvisionScope } from "@pithy-sh/core/src/naming/provisionScope";
import type { PreflightSecretDispatcher, SecretWriteRequest } from "@pithy-sh/secrets/src/cli/dispatch";
import { SecretAlreadyExistsError, SecretNotFoundError } from "@pithy-sh/secrets/src/error/errors";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { storeEntryText } from "@pithy-sh/secrets/src/store/entryText";
import type { SecretsStore } from "../provision/store";

/**
 * **The writer for a `cf-secrets-store` secret — the one the kit did not have** (#517).
 *
 * Every Secrets Store write site in the CLI composed its own value: `ensureMasterKey` mints a master key,
 * `storeSecretMinter` mints a random string, `pithy token mint` mints a Cloudflare API token. Not one of
 * them accepted a value a human already holds, and nothing in `docs/` named a manual path — so an OAuth
 * client secret, a payment rail's key, or a shared HMAC secret had no route into the entry its Worker
 * binds. `pithy secrets create` looked like the route and was not: the dispatched request carried no
 * backend, so it reached the manager Workflow and became a D1 row that nothing reads.
 *
 * This is that route, and it is a {@link PreflightSecretDispatcher} rather than a new command surface on
 * purpose. `pithy secrets create/update/rm` already resolve the registry, already validate the value,
 * already ask `secretWriteTargets` which environments a write reaches, and already audit what they did.
 * All of that is right for both backends; only the destination differed, and a destination is what a
 * dispatcher is. So `backendRoutedDispatcher` selects this for a request whose backend is
 * `cf-secrets-store`, and every rule above the seam stays in one place.
 *
 * ## What it writes, and why it is not a second serialization
 *
 * `storeEntryText` decides, and it is the only thing that does. For nearly every secret the entry holds
 * the `{ currentVersion, versions }` envelope `decodeVersionedValue` reads — byte-identical to what
 * `storeSecretMinter` writes, what the seeder puts in `.dev.vars`, and what `runWriteSecret` seals into
 * a D1 row. For a `bootstrap` secret it holds the **value**, because a `bootstrap` secret is read before
 * the store that decoder needs is open: `resolveEncryptionConfig` parses its binding's plaintext
 * directly, and there is no decode step an envelope could survive.
 *
 * This composed the envelope inline and unconditionally, which is the same defect `#323` removed from the
 * dev secrets file arriving at a second destination: `pithy secrets create` on an adopter's `bootstrap`
 * entry reported success over a value the Worker's boot answers `is not a valid EncryptionConfig` to.
 * The request carries the flag (`SecretWriteRequest.bootstrap`) for exactly the reason it carries
 * `backend` — a writer downstream of the routing seam cannot re-derive a registry fact.
 *
 * A value rotation (append a version) is still a deferred feature, exactly as it is for `d1`: an `update`
 * replaces the envelope with a fresh version 1. See `management/writeSecret.ts`, which says the same.
 *
 * ## The master key is not written here, and not because of this module
 *
 * `runSecretWrite` refuses `SECRETS_ENCRYPTION_KEYS` for every mode before anything is dispatched, so no
 * request for it reaches this. That refusal belongs there — it is a rule about a command, not about a
 * destination — and this module holds no name of its own. See `capabilities/secrets.ts`.
 */
export interface StoreSecretWriterOptions {
  /**
   * The account's one Secrets Store, resolved lazily.
   *
   * Lazy because `SECRETS_STORE_ID` is required to reach one and a project may write nothing but `d1`
   * secrets. Demanding the id up front would refuse `pithy secrets create auth-session-secret` in a
   * project that has no store and needs none — a refusal earned by a value that was never going there.
   */
  store: () => Promise<SecretsStore>;
  /**
   * The naming scope for one environment — `environmentScope(project, env)`, the same object
   * `pithy secrets provision` composes entry names with.
   *
   * A function of the environment rather than one scope, because a fan-out reaches several. It is the
   * *provisioning* namer and not a local one: an operator's value has to land at the address
   * `secretsStoreBindings` will later ask the store for, or the write succeeds and the binding stays
   * missing — which is the shape of dead end this whole issue is about, arriving through the name.
   */
  scope: (env: ManagedEnvironment) => ProvisionScope;
}

/**
 * Build the dispatcher that performs `cf-secrets-store` writes.
 *
 * **It records nothing, and that is deliberate.** `runSecretWrite` audits every value-touching command —
 * once, on success and on failure, with the backend in the metadata — and a second emitter here would put
 * two `secrets/set` events in the trail for one act. A destination is not an audience.
 *
 * `create` refuses an entry that is already there and `update` refuses one that is not — {@link
 * assertEntryWritable}, asked of the account's store rather than of a manager, which is what the CLI can
 * do here and cannot do there. `preflight` asks the same function with nothing written, so a rotation's
 * refusals land in front of the issuer rather than behind it.
 *
 * `delete` removes the entry and is idempotent — an entry that was already gone is not an error, exactly
 * as a missing D1 row is not. What it is *not* is silent about the half it cannot do: the Worker's
 * `wrangler.jsonc` still binds the name it just deleted, and `pithy secrets rm` prints that. See
 * `provision/secretEntryRemedy.ts`.
 */
export function storeSecretWriter(options: StoreSecretWriterOptions): PreflightSecretDispatcher {
  return {
    async dispatch(request: SecretWriteRequest): Promise<void> {
      const { store, entry } = await open(options, request);

      if (request.mode === "delete") {
        // The entry, which is the value a Worker actually reads. Nothing else was ever the secret: the
        // D1 row this used to delete was a shadow of a value no reader looks for.
        await store.remove(entry);
        return;
      }

      await assertEntryWritable(store, request, entry);
      if (request.value === undefined) {
        throw new ValidationError({
          message: `A value is required to ${request.mode} '${request.name}'.`,
          detail: `${request.mode} '${request.name}': dispatched to the store with no value`,
        });
      }

      // What this backend's reader expects for **this** secret — an envelope, or the value itself for a
      // `bootstrap` entry. One decision, in `storeEntryText`, shared with the minter and the seeder. The
      // value is already validated and canonicalized by `validateSecretValue`.
      await store.put(entry, storeEntryText(request, request.value));
    },

    /**
     * The two refusals above, asked with nothing written — for a rotation, which calls a third party's
     * API before it stores anything (#517).
     *
     * `options.store()` is the first of them and is why this is not merely a nicety: the account's
     * Secrets Store is resolved lazily, so a project with no `SECRETS_STORE_ID` discovers that at the
     * *write*, which for `pithy secrets rotate` is after the issuer has already rolled the credential.
     * The value then exists only in the process that is about to throw. Asked here, the same failure is
     * an ordinary refusal with the previous credential still live.
     *
     * It never checks `delete`, which refuses nothing and is idempotent, and it never looks at the value
     * — a preflight that could fail on a value would be a validation, and validation belongs to
     * `validateSecretValue`, before a prompt was even answered.
     */
    async preflight(request: SecretWriteRequest): Promise<void> {
      if (request.mode === "delete") {
        await open(options, request);
        return;
      }
      const { store, entry } = await open(options, request);
      await assertEntryWritable(store, request, entry);
    },
  };
}

/**
 * Resolve the account's store and compose the entry name this request addresses — the pair every branch
 * above needs, and the pair a preflight has to reach in order to be the same question.
 *
 * The backend check rides here rather than in `dispatch` alone because both entry points are reachable:
 * the router chooses this writer by backend, so arriving with anything else is a bug — and one that
 * would write a `d1` secret's value into an account-level entry no reader opens.
 */
async function open(
  options: StoreSecretWriterOptions,
  request: SecretWriteRequest,
): Promise<{ store: SecretsStore; entry: string }> {
  if (request.backend !== "cf-secrets-store") {
    throw new InternalError({
      message: `Secret '${request.name}' is not held in the Secrets Store.`,
      detail: `store secret writer: ${request.mode} '${request.name}' arrived with backend '${request.backend}'`,
    });
  }
  const store = await options.store();
  return { store, entry: options.scope(request.env).secretEntry(request.name, request.scope) };
}

/**
 * `create` refuses an entry that is already there and `update` refuses one that is not — the same guard
 * `runWriteSecret` enforces for `d1`, in the same words, because it is the same rule: a typo must not
 * create a second secret or silently overwrite a live one.
 *
 * One function, so the preflight and the write cannot come to two answers. It is asked twice on a
 * rotation and that is deliberate rather than wasteful: the early ask is what keeps a refusal in front
 * of the issuer, and the late one is what keeps it a guarantee — nothing reaches `put` without passing
 * it. Between the two the answer can legitimately change (somebody else wrote the entry), and the late
 * ask is the one that decides.
 */
async function assertEntryWritable(store: SecretsStore, request: SecretWriteRequest, entry: string): Promise<void> {
  const present = await store.exists(entry);
  if (request.mode === "create" && present) {
    throw new SecretAlreadyExistsError({
      message: `Secret '${request.name}' already exists.`,
      action: `Use pithy secrets update ${request.name} to replace it.`,
      detail: `create '${request.name}': store entry '${entry}' is already present`,
    });
  }
  if (request.mode === "update" && !present) {
    throw new SecretNotFoundError({
      message: `Secret '${request.name}' does not exist.`,
      action: "Use create to add a new secret.",
      detail: `update '${request.name}': store entry '${entry}' is not present`,
    });
  }
}

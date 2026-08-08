// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { CfSecretsStore } from "@pithy-sh/cloudflare/src/secrets/secretsStores";
import {
  type CloudflareConfigOptions,
  cloudflareConfigPath,
  describeCloudflareAccountMismatch,
  resolveCloudflare,
  writeCloudflareConfig,
} from "./config";

/**
 * Resolve the account's Secrets Store id **once, at provisioning time**, and record it in
 * `<config>/cloudflare.json` (#182).
 *
 * **This is the one network call in the store id's whole life.** Discovery at read time was considered
 * and rejected: avoiding an API call per invocation would mean caching the resolved id in a file, which
 * is the config key again with a staleness question and a network failure mode added on top. So the key
 * stays, and what this buys is that nobody has to find it in the dashboard and paste it. `pithy init`
 * writes the credential pair at the one moment the operator is holding both; this completes the file.
 *
 * **One store per account, so the answer is a lookup rather than a choice.** Cloudflare permits one, and
 * that is what makes an automatic write defensible at all. Two is therefore a state this refuses rather
 * than resolves — guessing which store holds an adopter's production secrets is not a choice a tool gets
 * to make silently — and zero is a state it explains.
 *
 * **Nothing here can fail `pithy add secrets`.** Every outcome is a sentence, never a throw. The command's
 * job is to wire the capability; recording the store id is a convenience on top of it, and an adopter
 * whose network is down, whose token lacks `secrets:read`, or who has no store yet can still export
 * `SECRETS_STORE_ID` and carry on. A convenience that can fail the command it rides on is not one.
 *
 * **It never overwrites a recorded id.** A file that already names a store is an answer somebody gave;
 * if the account disagrees, that is worth a sentence and is not worth acting on — the recorded id may be
 * the deliberate one, and replacing it would point every later `pithy secrets set` at another store.
 */

/** What {@link ensureSecretsStoreId} needs. Both seams default to the real account and the real config. */
export interface EnsureSecretsStoreIdOptions {
  /**
   * Where the Pithy config directory is, and **which account's file inside it**.
   *
   * Required, because the account is: one store per account means the store id belongs to whichever
   * account the project uses, and a default would be a guess about the most consequential part.
   */
  paths: CloudflareConfigOptions;
  /**
   * Seam: list the account's Secrets Stores. Defaults to the real REST call. A test passing this never
   * reaches Cloudflare — and the default is what makes "no credentials" a decision this module owns
   * rather than one every caller repeats.
   */
  listStores?: (credentials: { accountId: string; apiToken: string }) => Promise<CfSecretsStore[]>;
}

/** The lines `pithy add secrets` prints for the store id. Empty when there was nothing worth saying. */
export async function ensureSecretsStoreId(options: EnsureSecretsStoreIdOptions): Promise<string[]> {
  const paths = options.paths;
  // Resolved rather than read: a project that pins `cloudflare.accountId` and finds credentials for a
  // different account must get a sentence here, not the throw `cloudflareEnv` raises. Recording the store
  // id is a convenience riding on `pithy add secrets`, and a convenience that fails its command is not
  // one — while writing another account's store id into this project's file would be worse than either.
  const resolution = resolveCloudflare(paths);
  if (resolution.mismatch) {
    return [
      `${describeCloudflareAccountMismatch(resolution.mismatch)} SECRETS_STORE_ID was not recorded — a store id belongs to the account the project claims.`,
    ];
  }
  const vars = resolution.vars;
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  const recorded = vars.SECRETS_STORE_ID ?? "";

  // No credentials is not a fault here. `pithy add secrets` on a project that has not been pointed at an
  // account yet is an ordinary thing to do, and `pithy doctor` says the credentials are absent every run.
  if (!accountId || !apiToken) {
    if (recorded) return [];
    return [
      `SECRETS_STORE_ID is not recorded, and there are no Cloudflare credentials to resolve it with. Run pithy init, then pithy add secrets again.`,
    ];
  }

  const stores = await listStoresOrNull(options, { accountId, apiToken });
  if (stores === null) {
    if (recorded) return [];
    return [
      `Could not reach Cloudflare to resolve SECRETS_STORE_ID, so it was not recorded. Run pithy add secrets again, or set SECRETS_STORE_ID in ${cloudflareConfigPath(paths)}.`,
    ];
  }

  if (stores.length === 0) {
    if (recorded) return [];
    return [
      "This account has no Secrets Store yet, so SECRETS_STORE_ID was not recorded. Create one in the Cloudflare dashboard (Secrets Store), then run pithy add secrets again.",
    ];
  }

  // Named, never picked. The account is supposed to have one; two means somebody made a second, and
  // which of them holds the live secrets is a question only they can answer.
  if (stores.length > 1) {
    const named = stores.map((store) => `${store.name} (${store.id})`).join(", ");
    return [
      `This account has more than one Secrets Store — ${named} — so SECRETS_STORE_ID was not recorded. Set the one you mean in ${cloudflareConfigPath(paths)}.`,
    ];
  }

  const store = stores[0];
  if (store === undefined) return [];
  if (recorded) {
    if (recorded === store.id) return [];
    // Reported, never corrected. The recorded id may be the deliberate one, and replacing it would point
    // every later `pithy secrets set` at another store without anyone asking for that.
    return [
      `SECRETS_STORE_ID is recorded as ${recorded}, and this account's only Secrets Store is ${store.name} (${store.id}). Nothing was changed — fix it in ${cloudflareConfigPath(paths)} if the recorded one is wrong.`,
    ];
  }

  await writeCloudflareConfig({ SECRETS_STORE_ID: store.id }, paths);
  return [`Recorded SECRETS_STORE_ID (${store.name}) in ${cloudflareConfigPath(paths)}. Nothing resolves it again.`];
}

/** The account's stores, or `null` when the account could not be asked. Never throws. */
async function listStoresOrNull(
  options: EnsureSecretsStoreIdOptions,
  credentials: { accountId: string; apiToken: string },
): Promise<CfSecretsStore[] | null> {
  const list = options.listStores ?? ((creds) => new CloudflareClients(creds).secretsStores().listStores());
  return list(credentials).catch(() => null);
}

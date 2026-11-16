// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { cloudflareClients } from "../cloudflare/clients";
import { type CloudflareAccountSelection, cloudflareEnv } from "../cloudflare/config";
import type { ReadWorkerVars, WriteWorkerVar } from "../provision/deployStamp";

/** The account pair a project resolves to, or `undefined` when either half is missing. */
export function accountCredentials(
  account: CloudflareAccountSelection | null,
): { accountId: string; apiToken: string } | undefined {
  const vars = cloudflareEnv({ account });
  return vars.CLOUDFLARE_ACCOUNT_ID && vars.CLOUDFLARE_API_TOKEN
    ? { accountId: vars.CLOUDFLARE_ACCOUNT_ID, apiToken: vars.CLOUDFLARE_API_TOKEN }
    : undefined;
}

/** The stamp reader over the account's Workers REST client, loaded only once a run needs it. */
export async function workersVarsReader(credentials: { accountId: string; apiToken: string }): Promise<ReadWorkerVars> {
  const cf = await cloudflareClients(credentials);
  return (script) => cf.workers().getWorkerVars(script);
}

/** The stamp writer over the account's Workers REST client: one var set, every other binding inherited. */
export async function workersVarWriter(credentials: { accountId: string; apiToken: string }): Promise<WriteWorkerVar> {
  const cf = await cloudflareClients(credentials);
  return (script, name, value) => cf.workers().setWorkerVar(script, name, value);
}

/**
 * The stamp reader for a project's account, or `undefined` when it has no pair. No reader is doubt, which
 * deploys: wrangler still authenticates on its own login.
 */
export async function accountVarsReader(
  account: CloudflareAccountSelection | null,
): Promise<ReadWorkerVars | undefined> {
  const credentials = accountCredentials(account);
  return credentials ? workersVarsReader(credentials) : undefined;
}

/**
 * The stamp writer for a project's account, or `undefined` when it has no pair. No writer records no stamp, so
 * the next run deploys again.
 */
export async function accountVarWriter(
  account: CloudflareAccountSelection | null,
): Promise<WriteWorkerVar | undefined> {
  const credentials = accountCredentials(account);
  return credentials ? workersVarWriter(credentials) : undefined;
}

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type CliAuditEmit, createRemoteCliAudit, isRemoteEnv } from "../audit/cliAudit";
import { cloudflareClients } from "../cloudflare/clients";
import { type CloudflareAccountSelection, cloudflareEnv } from "../cloudflare/config";
import { resolveWorkerScopes } from "../migrations/run";

/**
 * The audit emitter for `pithy backup` and `pithy restore`, or a no-op where there is nothing to record (#848).
 *
 * Data-plane, like `pithy seed`: a `dev` run reads and writes local Miniflare only, so it is not audited, and
 * is asked before any credential is read. Off `dev`, a backup takes every row out of the account and a restore
 * loads every credential row back, so each leaves a record of who did it.
 */
export async function backupRestoreAudit(options: {
  /** The project root. */
  projectDir: string;
  /** The environment acted on. */
  env: string;
  /** The account the project names, or `null`. */
  account: CloudflareAccountSelection | null;
  /** The command's `--worker`, when one narrows the run. */
  worker?: string;
}): Promise<CliAuditEmit> {
  if (!isRemoteEnv(options.env)) return async () => {};
  const vars = cloudflareEnv({ account: options.account });
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  if (!accountId || !apiToken) return async () => {};
  const workers = await resolveWorkerScopes({
    projectDir: options.projectDir,
    env: options.env,
    ...(options.worker !== undefined ? { worker: options.worker } : {}),
  });
  return createRemoteCliAudit({
    projectDir: options.projectDir,
    env: options.env,
    actedOn: options.env,
    capabilities: workers.flatMap((worker) => worker.capabilities),
    clients: await cloudflareClients({ accountId, apiToken }),
    apiToken,
    ...(options.worker !== undefined ? { worker: options.worker } : {}),
  });
}

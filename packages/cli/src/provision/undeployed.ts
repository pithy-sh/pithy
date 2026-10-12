// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ConfirmedAccount } from "../cloudflare/accountAnswer";
import { cloudflareClients } from "../cloudflare/clients";
import { type CloudflareAccountSelection, cloudflareAccountConfirmation, cloudflareEnv } from "../cloudflare/config";
import { type NextStep, provisionNext } from "../terminal/nextSteps";
import { cloudflareWorkerScripts, type WorkerScripts } from "./resources";

/**
 * The script names of `workers` no deploy has uploaded to the account, in order — the condition behind
 * `pithy provision`'s `next` (#697). Provisioning names each Worker's script and creates what it binds; the
 * deploy is what makes it answer, so a script that is not there is a deploy still owed.
 *
 * **`undefined` when nobody could say.** No credentials to ask with, or an account `exists` refuses — it
 * refuses an unconfirmed one rather than answering, because an empty listing from an account nothing claims
 * is not an absence. The provisioning has already succeeded by then, so the question costs the run nothing
 * but the follow-up it could not vouch for.
 */
export async function undeployedWorkers(
  workers: readonly { name: string }[],
  scripts: WorkerScripts | null,
): Promise<string[] | undefined> {
  if (scripts === null) return undefined;
  try {
    const deployed = await Promise.all(workers.map((worker) => scripts.exists(worker.name)));
    return workers.filter((_, index) => !deployed[index]).map((worker) => worker.name);
  } catch {
    return undefined;
  }
}

/**
 * What a provisioning run that succeeded leaves required: the deploy, for Workers the report's environment
 * names and no deploy has uploaded (#697) — `pithy deploy --env feature` for a feature's. Asked after the run,
 * never before it, and never at the cost of it: no credentials (`buildScripts` answers `null`), clients that
 * would not build, or an account that refuses each leave `next` absent rather than failing what succeeded.
 */
export async function provisionFollowUp(
  report: { env: string; workers: readonly { name: string }[] },
  buildScripts: () => Promise<WorkerScripts | null>,
): Promise<NextStep[] | undefined> {
  let scripts: WorkerScripts | null;
  try {
    scripts = await buildScripts();
  } catch {
    return undefined;
  }
  return provisionNext({ env: report.env, undeployed: await undeployedWorkers(report.workers, scripts) });
}

/** Reach the account's Worker scripts with a credential pair and what vouches for it. */
export type ConnectWorkerScripts = (account: ConfirmedAccount & { apiToken: string }) => Promise<WorkerScripts>;

/** The real {@link ConnectWorkerScripts}: the account's Workers manager. */
const connectCloudflare: ConnectWorkerScripts = async ({ accountId, apiToken, confirmation }) =>
  cloudflareWorkerScripts(await cloudflareClients({ accountId, apiToken }), { accountId, confirmation });

/**
 * The account's Worker scripts, asked only whether one is deployed, or `null` when either credential is
 * absent: no pair, no question, and no `next`. What vouches for the account travels with the id (#378), as it
 * does for the provisioners, so `exists` refuses an account nothing claims rather than reading its empty
 * listing as an absence. `connect` is the seam; it defaults to the account's Workers manager.
 */
export async function accountWorkerScripts(
  account: CloudflareAccountSelection | null,
  connect: ConnectWorkerScripts = connectCloudflare,
): Promise<WorkerScripts | null> {
  const vars = cloudflareEnv({ account });
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  if (!accountId || !apiToken) return null;
  return connect({ accountId, apiToken, confirmation: cloudflareAccountConfirmation({ account }) });
}

/**
 * The `next` entry of a provisioning run's report, spread into it at both call sites: `{ next }` under
 * `--json` when a deploy is owed, `{}` otherwise. Only `--json` carries `next`, so a text run asks the account
 * nothing. `buildScripts` defaults to {@link accountWorkerScripts} for `account`.
 */
export async function provisionNextEntry(
  report: { env: string; workers: readonly { name: string }[] },
  options: {
    json: boolean;
    account: CloudflareAccountSelection | null;
    buildScripts?: () => Promise<WorkerScripts | null>;
  },
): Promise<{ next?: NextStep[] }> {
  if (!options.json) return {};
  const next = await provisionFollowUp(report, options.buildScripts ?? (() => accountWorkerScripts(options.account)));
  return next === undefined ? {} : { next };
}

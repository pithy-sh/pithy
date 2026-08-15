// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { defineCommand } from "citty";
import { createCliAudit } from "../audit/cliAudit";
import { type CloudflareAccountSelection, cloudflareEnv } from "../cloudflare/config";
import { readProjectLedger } from "../migrations/run";
import { projectCloudflareAccount } from "../project/config";
import { deployProject, deployVerificationFailed, pendingWarning, summarizeDeploy } from "../project/deploy";
import { assertOriginsDeclared } from "../project/domains";
import { optionalEnvArg, requireEnvironment } from "../project/environment";
import { projectCapabilities, resolveWorkers } from "../project/workerScope";
import { assertWorkflowsBound } from "../project/workflows";
import { assertEnvironmentProvisioned } from "../provision/unprovisioned";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";

/**
 * How many migrations are unapplied for the target env — best-effort, never blocking. Deploy and
 * migrate are orthogonal (deploy never migrates), so a config that can't load or a database it can't
 * reach yields `undefined` (no warning) rather than failing the deploy.
 *
 * Deploy ships every Worker, so the count does too — it fans out over `apps/*` exactly as `pithy migrate`
 * would. The warning is about the project's schema being behind, and a table any Worker owns is one this
 * deploy's code may read.
 *
 * **Best-effort is not unattributed.** The count reaches a remote D1 for any `--env`, so it takes the
 * same account the deploy beside it does. Omitting it resolved `<config>/cloudflare.json` while the
 * deploy resolved the project's named account — one command, one run, two tenants, and a number about
 * somebody else's schema printed as though it were this project's (#206, #226).
 */
async function pendingFor(
  projectDir: string,
  env: string,
  account: CloudflareAccountSelection | null,
): Promise<number | undefined> {
  try {
    // Only the pending half here. A drifted ledger is a fault `pithy doctor` names and `pithy migrate`
    // refuses on, and deploy never migrates — it reports how far the schema is behind, which stays a
    // truthful number either way.
    const ledger = await readProjectLedger({ projectDir, env, account });
    // A partial read still warns, and the number it warns with is the one it established (#371). A sum
    // over the databases that answered can only understate how far behind the project is, so it never
    // raises a false alarm — and this line is warn-only. Which database went unread is `pithy doctor`'s
    // sentence to say, in the report whose job is naming faults.
    if (ledger.state === "partial") return ledger.counted.pending;
    return ledger.state === "read" ? ledger.pending : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The audit emitter for `pithy deploy`. Shipping code to an environment is exactly the kind of action
 * an audit trail exists for, so every worker deploy — success or failure — is recorded when the project
 * has audit wired. A bare `pithy deploy` (no `--env`) still targets the project's own app database, the
 * same one `dev` reads (see `resolveAuditDatabaseId`), so the fallback lines up with the real target.
 */
async function buildAudit(projectDir: string, env: string, account: CloudflareAccountSelection | null) {
  const vars = cloudflareEnv({ account });
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  if (!accountId || !apiToken) return async () => {};
  // `audit` composed by any Worker means the project has a trail; deploy spans them all.
  const capabilities = await resolveWorkers({ projectDir })
    .then(projectCapabilities)
    .catch(() => []);
  return createCliAudit({
    projectDir,
    env,
    // Here `env` really is the environment acted on, so it is also the recorded origin.
    actedOn: env,
    capabilities,
    clients: new CloudflareClients({ accountId, apiToken }),
    apiToken,
  });
}

export default defineCommand({
  meta: { name: "deploy", description: "Deploy to Cloudflare Workers" },
  args: {
    env: optionalEnvArg("Target environment (omit for each worker's top-level config)"),
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      // Optional here, and only here: a bare `pithy deploy` ships each worker's top-level stanza, which
      // is not an environment at all. A value that *is* given is held to the same rule as everywhere else.
      const env = args.env === undefined ? undefined : requireEnvironment(args.env);
      const projectDir = process.cwd();

      // The migration warning only makes sense against a concrete remote target. A bare `pithy deploy`
      // ships each worker's top-level config, whose deployed schema is not the local dev D1 — so skip the
      // check (and its REST round trip) unless an `--env` names the environment being deployed.
      // The account first, before anything resolves a credential. It is read from the project's own
      // config and passed to every step below, rather than left to whatever a later load happens to
      // publish — a deploy that authenticates against the wrong tenant succeeds, and says nothing.
      // Refuse before anything is built or spawned. A binding with no id fails *inside* wrangler, on a
      // field the adopter never wrote, after `init`, `add`, `migrate` and `dev` have all succeeded —
      // and with no hint that provisioning was a step they had missed (#240). Only for a named `--env`:
      // a bare deploy ships the top-level stanza, whose ids `pithy dev` resolves from Miniflare.
      if (env) await assertEnvironmentProvisioned(projectDir, env);
      // And the other half of "is this environment ready to be real": does its config name every origin
      // it will answer on (#253). Refused here for the same reason the binding check is — deploy knows
      // the environment and the config, and this is the last moment before a staging Worker starts
      // emailing real users magic links into production. Beside it rather than inside it because the two
      // are different questions with different fixes; `assertOriginsDeclared` exempts a feature
      // environment itself, which has no declared domain by design.
      if (env) await assertOriginsDeclared(projectDir, env);
      // And the third half of it, on the same evidence and at the same moment: does this environment's
      // stanza bind what its Workers' app capabilities declare (#267)? `reconcileAppWorkflows` writes
      // that table and `pithy worker sync` is its only caller, so an adopter who declared a job and
      // never ran it shipped a Worker with no `workflows` entry and no `triggers.crons` — the binding
      // fails on the first request, and the cron simply never fires and says nothing at all. Beside the
      // origins gate rather than inside it for the same reason that one is beside the binding gate: a
      // different question with a different fix, and a feature environment is exempt from this one too.
      if (env) await assertWorkflowsBound(projectDir, env);

      const account = await projectCloudflareAccount(projectDir);
      // **The account is settled here, before anything best-effort runs (#236).** `pendingFor` swallows
      // every failure on purpose — a database it cannot reach costs a warning line, not the deploy — and
      // a pin the credentials contradict is not a reachability failure. Swallowed, it becomes
      // `pendingMigrations: null`: an absence that reads as a fact. `cloudflareEnv` refuses it in the one
      // sentence `pithy doctor` already reads out. A *missing* pair still passes, because `wrangler
      // deploy` authenticates on its own OAuth login and always could.
      cloudflareEnv({ account });
      const pending = env ? await pendingFor(projectDir, env, account) : undefined;
      const audit = await buildAudit(projectDir, env ?? "dev", account);
      const deploys = await deployProject({ projectDir, account, env, audit });
      // A deploy that shipped but is not the thing answering at the declared address is a failure too,
      // and it fails the pipeline rather than printing a line nobody reads. Two shapes count: a
      // *consistent* mismatch, and nothing answering at all (#264). A gradual rollout and a Worker that
      // answered without a version are both inconclusive, and failing on either would train everyone to
      // ignore the check.
      const failed = deploys.some((deploy) => !deploy.ok) || deployVerificationFailed(deploys);

      if (args.json) {
        process.stdout.write(
          `${formatJsonLine({
            command: "deploy",
            env: env ?? null,
            pendingMigrations: pending ?? null,
            workers: deploys,
          })}\n`,
        );
        if (failed) process.exitCode = 1;
        return;
      }

      const warning = env ? pendingWarning(pending, env) : undefined;
      if (warning) process.stdout.write(`${warning}\n`);
      for (const deploy of deploys) process.stdout.write(`${summarizeDeploy(deploy)}\n`);
      if (failed) {
        process.exitCode = 1; // The per-worker failure lines are the report; exit non-zero for CI.
        return;
      }
      process.stdout.write(`${formatDone()}\n`);
    }),
});

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { TESTERS_CAPABILITY } from "../workflows/specs";

/**
 * The provisioning orchestration for the testers capability — the live counterpart to
 * `pithy add testers`'s config wiring.
 *
 * The split is the same one every capability makes, and worth restating because the two commands look
 * like one. `pithy add` writes *bindings*: it installs the package, adds `testers()` to
 * `pithy.config.ts`, and puts a `DB` entry in `wrangler.jsonc`. It touches no Cloudflare account, so
 * adding a capability stays something you can do offline, in CI, or without credentials. This command
 * stands up the one thing those bindings point at: the prebuilt worker that hosts the daily pass.
 *
 * The `TESTERS_DAILY` Workflow binding belongs to this side of the split for a mechanical reason.
 * Wrangler requires a `name` and a `class_name` on every `workflows` entry, and the deployed name is
 * per environment — so `add` writes none, because a partial entry stops wrangler loading the config at
 * all, and the CLI writes the complete entry here once the host exists.
 *
 * **This provisioner is unusually small, and the reason is worth stating.** There is no bucket to
 * create, no index, and — since the confirmation token became a random value on the tester's own row
 * rather than a signature — no secret to write and no master key to bind. What is left is a template,
 * a deploy, and a binding. A capability that needs less provisioning is a capability an adopter is more
 * likely to actually finish setting up.
 *
 * The live Cloudflare/wrangler steps sit behind the {@link TestersProvisioner} seam, so the
 * orchestration — order, idempotency, per-environment fan-out — is unit-tested with a fake that records
 * its call order, and no account. **Every step is idempotent**: the deploy overwrites, and the binding
 * write is a find-or-append. Re-running is a no-op.
 *
 * **What it deliberately does not do.** It does not run the pass. A provision that also fired the daily
 * job would mail an adopter's testers as a side effect of a deployment command, which is the kind of
 * surprise that costs a sending domain its reputation. `pithy testers run` is the explicit way.
 */

/**
 * The deployed daily-pass worker name for a project's environment — also its resolved config's basename.
 *
 * Through core's naming facade under the **`worker`** namespace: the kind of thing carries the cap, so
 * this cannot be measured against some other namespace's number, and the environment is validated here
 * rather than at the deploy that would have used it.
 */
export function testersWorkerName(project: string, env: ManagedEnvironment): string {
  return resourceNames(project).env(env).worker(TESTERS_CAPABILITY);
}

/**
 * The live Cloudflare/wrangler seam. Each step must be idempotent.
 *
 * Narrow on purpose: everything a fake needs to stand in for is an account check and a deploy, which is
 * what makes the orchestration testable without a Cloudflare account.
 */
export interface TestersProvisioner {
  /** Fail before the first deploy if the account cannot host a Workflow at all. */
  preflight(): Promise<void>;
  /** Resolve the committed template for this environment and `wrangler deploy` it. */
  deployWorker(env: ManagedEnvironment): Promise<void>;
}

/** The live seam for taking a deployed host back down. */
export interface TestersDeprovisioner {
  /** Delete this environment's daily-pass worker. Absent is success — teardown is idempotent. */
  deleteWorker(env: ManagedEnvironment): Promise<void>;
}

/** What one provisioning run did, per environment, for the command to report. */
export interface TestersProvisionResult {
  readonly env: ManagedEnvironment;
  readonly worker: string;
}

/**
 * Provision the daily-pass host across every managed environment.
 *
 * Preflight runs once, before any deploy. Failing there means failing before one environment is half
 * provisioned rather than part way through the fan-out — the state that is hardest to reason about and
 * hardest to recover from.
 */
export async function provisionTesters(
  provisioner: TestersProvisioner,
  project: string,
  environments: readonly ManagedEnvironment[],
): Promise<TestersProvisionResult[]> {
  await provisioner.preflight();

  const results: TestersProvisionResult[] = [];
  for (const env of environments) {
    await provisioner.deployWorker(env);
    results.push({ env, worker: testersWorkerName(project, env) });
  }
  return results;
}

/** Take every environment's host back down. Idempotent: a worker that is already gone is success. */
export async function deprovisionTesters(
  deprovisioner: TestersDeprovisioner,
  project: string,
  environments: readonly ManagedEnvironment[],
): Promise<TestersProvisionResult[]> {
  const results: TestersProvisionResult[] = [];
  for (const env of environments) {
    await deprovisioner.deleteWorker(env);
    results.push({ env, worker: testersWorkerName(project, env) });
  }
  return results;
}

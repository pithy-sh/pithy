// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { DeclaredEnvironments } from "@pithy-sh/core/src/naming/environment";
import { GLOBAL_SCOPE } from "@pithy-sh/core/src/naming/environment";
import { bindingResourceName, type ProjectGlobalNaming } from "@pithy-sh/core/src/naming/provisionScope";
import { resourceName } from "@pithy-sh/core/src/naming/resource";
import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import { type ManagedEnvironment, managedEnvironments } from "@pithy-sh/secrets/src/scope";

/**
 * The provisioning orchestration for the email capability — the live counterpart to `pithy add email`'s
 * config wiring. It stands up the durable infrastructure the rest of the capability assumes: the
 * suppression database (one per **project**, bound by every one of that project's environments) and the
 * per-environment prebuilt email worker that hosts the send + scheduler Workflows and the every-minute
 * cron.
 *
 * Unlike `@pithy-sh/secrets`, the email worker needs **no minted CF API token** — it sends through the
 * Cloudflare Email Service `send_email` binding and reads its signing key through the `SECRETS` bindings,
 * neither of which uses an API token. So provisioning here is purely: create + migrate the suppression
 * DB, then deploy each environment's worker.
 *
 * The live Cloudflare/wrangler steps are behind the {@link EmailProvisioner} seam, so the orchestration
 * (order, idempotency contract, per-env fan-out) is unit-tested without touching Cloudflare; the real
 * seam implementation is the live-CF glue, exercised by the integration suite. Every step is idempotent —
 * re-running provisioning is a no-op.
 *
 * **Operator prerequisites (out of band, like the secrets store):** the sending domain must be onboarded
 * onto Cloudflare Email Service, one Email Routing rule must point bounce/complaint mail at the production
 * app worker, and the link-signing key must exist (`pithy secrets create email-link-signing-key`). These
 * are one-time account/DNS actions provisioning does not own.
 */

/** The capability segment every email-owned name carries — the migration namespace and error domain too. */
export const EMAIL_CAPABILITY = "email";

/** The D1 binding the suppression database is bound to, in every Worker and every environment. */
export const EMAIL_SUPPRESSIONS_BINDING = "EMAIL_SUPPRESSIONS";

/**
 * What `packages/email/pithy.manifest.json` declares about naming {@link EMAIL_SUPPRESSIONS_BINDING} —
 * restated here because a bundled Worker package cannot read its own manifest, and **pinned to it by
 * `cli/src/ci/bindingResourceNames.test.ts`**, which fails the moment the two answers differ.
 *
 * No `resource`: `email-suppressions` is the kebabbed binding, which is what the composer already uses.
 */
const EMAIL_SUPPRESSIONS_NAMING: ProjectGlobalNaming = { scope: GLOBAL_SCOPE };

/**
 * The shared, durable suppression database — **one per project, shared across that project's
 * environments**: `<project>-global-email-suppressions`.
 *
 * The sharing across environments is deliberate and load-bearing. "Do not email this person again" is
 * not an environment-local fact; an address that hard-bounced in production must not be retried from
 * staging, or the sending domain's reputation pays for the distinction. `global` sits in the
 * environment slot to say so out loud rather than by omission.
 *
 * The sharing across **projects** was not deliberate — it was the absence of a project segment. D1's
 * namespace is account-wide and provisioning reuses a database it finds by name, so a fixed
 * `pithy-email-suppressions` meant a second, unrelated Pithy product in the same account silently
 * inherited the first's opt-out list: one product's unsubscribe suppressing another product's
 * transactional mail, with no row anywhere recording why. The project segment gives the scope a
 * definition instead of an accident.
 *
 * Composed through core's naming facade under the **`d1`** namespace, so the name is measured against
 * a D1 database name's limit rather than the single 63 the generic composer defaults to.
 *
 * **Through {@link bindingResourceName}, the same expression `pithy add` and `pithy provision` compose
 * with — because until #513 it was a *different* expression, and that was the defect.** This function
 * said `<project>-global-email-suppressions` while the two writers said `<project>-<env>-email-
 * suppressions`, so `pithy add email` wrote three per-environment databases into `wrangler.jsonc` and
 * `pithy email provision` created the one this names. The app Worker and the email Worker then read
 * different suppression lists, and an unsubscribe recorded on either was invisible to the other. One
 * expression, driven by one declaration, is what makes that unexpressible rather than merely fixed.
 *
 * The output is byte-identical to what it always was: `kebab("EMAIL_SUPPRESSIONS")` is
 * `email-suppressions`, and the composer's `global` branch is the facade call this used to make directly.
 */
export function suppressionDatabaseName(project: string): string {
  return bindingResourceName(project, EMAIL_SUPPRESSIONS_BINDING, "d1", EMAIL_SUPPRESSIONS_NAMING);
}

/**
 * The name of the inbound Email Routing rule that delivers bounce and complaint mail to the app worker.
 *
 * `global` in the environment slot because there is one rule per zone — the environments are separated
 * by which app Worker the rule points at, not by the rule. Project-scoped and distinct from
 * `@pithy-sh/support`'s `<project>-global-support-inbound`: `ensureWorkerRoute` keys idempotency on the
 * rule *name*, so two projects sharing a zone under one unscoped name would each read the other's rule
 * as their own, and one project's bounces would be delivered to the other's Worker.
 *
 * **The one name here still on the generic composer**, because an Email Routing rule is not a namespace
 * `@pithy-sh/core/src/naming/limits` carries a verified Cloudflare cap for. The facade's whole point is
 * that a kind of thing carries its own number; inventing one for this kind would be the opposite. So it
 * takes the conservative default until that namespace lands.
 */
export function bounceRoutingRuleName(project: string): string {
  return resourceName({ project, env: GLOBAL_SCOPE, thing: `${EMAIL_CAPABILITY}-bounce` });
}

/**
 * The deployed Worker name for a project's environment — also its resolved config basename. Composed
 * through core's naming facade under the **`worker`** namespace (63, the workers.dev cap), which
 * `resolveEmailConfig` also stamps onto the config: one source, so the name the CLI audits and deletes
 * under cannot drift from the name it deploys under. The environment is validated on the way through,
 * so a stale `production` fails here rather than deploying a second host beside the real one.
 */
export function emailWorkerName(project: string, env: ManagedEnvironment): string {
  return resourceNames(project).env(env).worker(EMAIL_CAPABILITY);
}

/** The live Cloudflare/wrangler seam. Each step must be idempotent. */
export interface EmailProvisioner {
  /**
   * Verify account prerequisites before any resource is created — most importantly a registered
   * `workers.dev` subdomain, which Cloudflare requires to deploy the Workflow-hosting email worker.
   * Throws a clear, actionable error so provisioning fails fast and clean rather than mid-deploy.
   */
  preflight(): Promise<void>;
  /** Create (or reuse) the project's suppression D1; returns its id. Idempotent. Runs once, before any env. */
  ensureSuppressionDatabase(): Promise<{ databaseId: string }>;
  /** Run the `email_0001_suppressions` migration against the suppression D1. Idempotent (applied ones skip). */
  migrateSuppression(databaseId: string): Promise<void>;
  /** Deploy the prebuilt email worker for this environment, wired to the suppression DB and the env's own resources. */
  deployWorker(env: ManagedEnvironment, suppressionDatabaseId: string): Promise<void>;
  /**
   * Ensure the inbound Email Routing rule that points bounce/complaint mail at the production app worker
   * (one per domain). Idempotent. Returns `skipped: true` when no routing config is supplied — the
   * routing target and inbound address are an operator choice (and must not disturb the apex MX), so a
   * project that hasn't decided yet provisions everything else and adds the rule later.
   */
  ensureRoutingRule(): Promise<{ created: boolean; skipped: boolean }>;
}

/** What provisioning produced. */
export interface EmailProvisionResult {
  suppressionDatabaseId: string;
  environments: ManagedEnvironment[];
  /** Whether the inbound routing rule was created, already present, or skipped (not configured). */
  routing: { created: boolean; skipped: boolean };
}

/**
 * Provision the email infrastructure: create + migrate the shared suppression DB once, then deploy the
 * email worker for every environment given. The order matters — the suppression DB exists and is
 * migrated before any worker that binds it is deployed. Idempotent end to end (each step is).
 *
 * `environments` is **what the caller determined it can act on**, which the CLI narrows from the project's
 * declaration (#241) to the environments whose app database exists (pithy-sh/pithy#512). Nothing is
 * skipped here and nothing decides here: an environment reaching this list is provisioned, and one that
 * did not was already reported to the operator by name, with why and with the command that fixes it.
 *
 * The suppression database is created **whatever the list holds, including nothing**. It is one per
 * project, shared across every environment, and making it wait for the last environment to be provisioned
 * is exactly the ordering this change exists to undo.
 */
export async function provisionEmail(
  provisioner: EmailProvisioner,
  environments: DeclaredEnvironments | readonly string[],
): Promise<EmailProvisionResult> {
  await provisioner.preflight();
  const { databaseId } = await provisioner.ensureSuppressionDatabase();
  await provisioner.migrateSuppression(databaseId);
  const deployed = managedEnvironments(environments);
  for (const env of deployed) {
    await provisioner.deployWorker(env, databaseId);
  }
  // One inbound routing rule per domain (production app worker), after the workers are up — and only when
  // at least one is. A rule created over an empty run starts delivering real bounce mail to a handler that
  // was never deployed, which is the window this ordering exists to close.
  const routing =
    deployed.length > 0 ? await provisioner.ensureRoutingRule() : { created: false, skipped: true as const };
  return { suppressionDatabaseId: databaseId, environments: deployed, routing };
}

/** The teardown seam — the inverse of {@link EmailProvisioner}. Every step idempotent (a missing resource is a no-op). */
export interface EmailDeprovisioner {
  /** Delete the env's email worker. Idempotent (a missing worker is a no-op). */
  deleteWorker(env: ManagedEnvironment): Promise<void>;
  /**
   * Delete the shared suppression D1. **Destructive** — the global suppression list is lost, so every
   * environment forgets who unsubscribed or hard-bounced — so the orchestration only calls it when
   * explicitly asked. Idempotent.
   */
  deleteSuppressionDatabase(): Promise<void>;
}

/** Teardown options. By default the suppression DB is **kept** — losing the global opt-out list is harmful. */
export interface EmailDeprovisionOptions {
  /** Also delete the shared suppression database. Off by default; only a full destroy sets it. */
  deleteSuppression?: boolean;
}

/**
 * Tear down the email infrastructure, reversing {@link provisionEmail}: delete every environment's worker
 * first (they bind the suppression DB), then — only when `deleteSuppression` is set — the shared
 * suppression DB. The suppression list is preserved unless explicitly requested. Idempotent end to end.
 *
 * `environments` is the project's declaration from the root `pithy.config.ts` (#241). Every declared
 * environment is provisioned; an environment this skipped would be one the project deploys to with no
 * resources behind it — the silence the closed `ManagedEnvironment` enum used to produce.
 */
export async function deprovisionEmail(
  deprovisioner: EmailDeprovisioner,
  environments: DeclaredEnvironments | readonly string[],
  options: EmailDeprovisionOptions = {},
): Promise<void> {
  for (const env of managedEnvironments(environments)) {
    await deprovisioner.deleteWorker(env);
  }
  if (options.deleteSuppression) await deprovisioner.deleteSuppressionDatabase();
}

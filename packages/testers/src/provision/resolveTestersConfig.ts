// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { hostWorkflowsFor, resolveWorkflowHost, type WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { suppressionDatabaseName } from "@pithy-sh/email/src/provision/provisionEmail";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import type { TestersConfig } from "../config/config";
import { TESTERS_CAPABILITY, testersWorkflowRegistry } from "../workflows/specs";

/**
 * Resolve the daily-pass worker's committed `wrangler.jsonc` template into one environment's standalone
 * config. Every per-environment decision lives here; everything static — the compatibility date, the
 * binding names — stays as the template committed it.
 *
 * Thin over core's {@link resolveWorkflowHost}, which owns the mechanics. What this file adds is the
 * one thing the generic resolver deliberately does not do: it **rewrites `workflows` and
 * `triggers.crons` from the capability's own specs** rather than from the template's block. The
 * template carries both so it reads as a complete, deployable config, but `workflows/specs.ts` is the
 * single source of the binding name, the class name, and the schedule — so moving the pass off 05:00
 * is a one-line spec edit, not a spec edit plus a JSONC edit that nothing checks agree.
 *
 * Pure: the caller parses the template and writes the result.
 */

/** The sending identity the host needs to enqueue mail, copied from the email capability's config. */
export interface TestersEmailIdentity {
  /** The from address. Must be on a domain onboarded to Cloudflare Email Service. */
  readonly fromAddress: string;
  /** The from display name recipients see. */
  readonly fromName: string;
  /** The resolved email theme, serialized into the host's `EMAIL_THEME` var. */
  readonly theme: unknown;
}

/** The resolved ids and per-env values for one environment's daily-pass deploy. */
export interface TestersConfigParams {
  /**
   * The project name — the `<project>` segment the deployed host, its daily Workflow, and the
   * suppression database name all lead with. The root `pithy.config.ts` `name`, resolved by
   * `requireProjectName` and never guessed.
   */
  readonly project: string;
  /** The target environment. */
  readonly env: ManagedEnvironment;
  /** The app database id — where the `pithy_testers_*`, `pithy_auth_*` and `pithy_email_jobs` tables live. */
  readonly appDatabaseId: string;
  /**
   * The project's email-suppression database id.
   *
   * Shared across environments rather than per environment, matching how `@pithy-sh/email` provisions
   * it: an unsubscribe in prod must stop staging too, so every environment's host binds the same
   * database. Shared across *projects* it is not — the name carries the project, so one product's
   * opt-out list can no longer suppress another's transactional mail.
   */
  readonly suppressionDatabaseId: string;
  /** The app's resolved testers config — serialized into the host's `TESTERS_CONFIG` var. */
  readonly testersConfig: TestersConfig;
  /**
   * The sending identity, or undefined when the project composes no email capability.
   *
   * Undefined is a legitimate state rather than an error: the pass still advances roster state and
   * writes its snapshot, it simply sends nothing. A default address would be worse than an absent one —
   * mail from a domain the adopter's DKIM does not cover trains recipients' providers to distrust the
   * real domain, which is the opposite of what this capability is for.
   */
  readonly email: TestersEmailIdentity | undefined;
}

/** Fill the template for one environment. */
export function resolveTestersConfig(
  template: WorkflowHostTemplate,
  params: TestersConfigParams,
): WorkflowHostTemplate {
  const { project, env, appDatabaseId, suppressionDatabaseId, testersConfig, email } = params;

  // Derived before the resolve: `resolveWorkflowHost` refuses a template that declares `workflows`
  // without them, because the only name it could invent unaided is one a second project would overwrite.
  const derived = hostWorkflowsFor(testersWorkflowRegistry, { project, capability: TESTERS_CAPABILITY, env });

  const resolved = resolveWorkflowHost(template, {
    project,
    capability: TESTERS_CAPABILITY,
    env,
    databaseIds: { DB: appDatabaseId, EMAIL_SUPPRESSIONS: suppressionDatabaseId },
    // The suppression database is email's, and its name now carries the project. Left alone, the
    // template would print `pithy-email-suppressions` — a name no account holds.
    databaseNames: { EMAIL_SUPPRESSIONS: suppressionDatabaseName(project) },
    workflows: derived.workflows,
    vars: {
      TESTERS_CONFIG: JSON.stringify(testersConfig),
      // Only set when there is an identity to set. The removal below is the other half — see it for why
      // omitting the key is not the same as not writing one.
      ...(email
        ? {
            EMAIL_FROM_ADDRESS: email.fromAddress,
            EMAIL_FROM_NAME: email.fromName,
            EMAIL_THEME: JSON.stringify(email.theme),
          }
        : {}),
    },
  });

  // The template declares the three `EMAIL_*` vars as `<filled-at-provision>` so it reads as a complete
  // config, and `resolveWorkflowHost` merges rather than replaces — so *not writing* them leaves the
  // placeholders in place rather than leaving them absent. The worker's `if (!env.EMAIL_FROM_ADDRESS)`
  // guard reads a placeholder as an identity, and the failure lands one step later, inside a
  // `JSON.parse` of `EMAIL_THEME`, in a catch that swallows it. A project that composes no email
  // capability would deploy a host that looks configured to send and silently never does.
  if (!email) {
    for (const key of ["EMAIL_FROM_ADDRESS", "EMAIL_FROM_NAME", "EMAIL_THEME"]) delete resolved.vars?.[key];
  }

  // The configured hour, applied to the schedule the spec declares. The spec owns *that there is a
  // daily cron and when it sits by default*; the adopter owns which hour it fires, and until this line
  // existed `snapshotHourUtc` was a fully described, bounded, defaulted knob that nothing read — so
  // setting it to 9 because 05:00 collided with their own nightly job changed nothing, silently.
  const crons = derived.crons.map((cron) => {
    const fields = cron.split(" ");
    fields[1] = String(testersConfig.snapshotHourUtc);
    return fields.join(" ");
  });
  // Only declare a cron block when a spec actually carries one. An empty `crons` array is a declaration
  // wrangler honors, and a worker advertising a schedule it does not have is a deployment nobody can
  // reason about.
  resolved.triggers = crons.length > 0 ? { crons } : undefined;

  return resolved;
}

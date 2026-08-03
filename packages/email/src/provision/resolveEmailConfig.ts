// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type {
  HostD1Binding,
  HostSecretsStoreBinding,
  HostSendEmailBinding,
  HostWorkflowBinding,
  WorkflowHostTemplate,
} from "@pithy-sh/core/src/workflow/host";
import { hostWorkflowsFor, resolveWorkflowHost } from "@pithy-sh/core/src/workflow/host";
import { workflowKey } from "@pithy-sh/core/src/workflow/naming";
import type { WorkflowRegistry } from "@pithy-sh/core/src/workflow/spec";
import { masterKeySecretName } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { z } from "zod";
import type { EmailTheme } from "../templates/theme";
import { EMAIL_CAPABILITY, suppressionDatabaseName } from "./provisionEmail";

/**
 * The email worker's `wrangler.jsonc` template shape. Email invented the prebuilt-host convention;
 * `@pithy-sh/core`'s {@link WorkflowHostTemplate} is the generalization of it, so this is now that
 * contract with the fields email's committed template always carries narrowed to required. The
 * committed template (`src/workflows/wrangler.jsonc`) stays the source of truth for the static fields
 * (compatibility date, the every-minute cron, class names, the `send_email` binding, theme vars).
 */
export interface EmailWorkerWranglerTemplate extends WorkflowHostTemplate {
  compatibility_date: string;
  compatibility_flags: string[];
  workers_dev: boolean;
  d1_databases: HostD1Binding[];
  send_email: HostSendEmailBinding[];
  secrets_store_secrets: HostSecretsStoreBinding[];
  workflows: HostWorkflowBinding[];
  triggers: { crons: string[] };
  vars: Record<string, string>;
}

/**
 * The two durable jobs email's host runs, as a {@link WorkflowRegistry} — the shape
 * {@link hostWorkflowsFor} derives project-scoped Workflow names from.
 *
 * Email declares these jobs on its `Capability` (`capability.ts`) rather than in a `workflows/specs.ts`
 * the way every later capability does — it predates that convention. The host resolver needs a registry
 * and cannot reach into a capability instance (building one requires an adopter's config), so the two
 * jobs are mirrored here, and `resolveEmailConfig.test.ts` asserts the bindings and class names match
 * the committed template byte for byte. `params` is unused on this path: the registry field exists for
 * the dispatcher, and the host only ever reads `binding`, `className`, and `schedule`.
 */
const EMAIL_HOST_JOBS = {
  send: { binding: "EMAIL_SENDER", className: "EmailSendWorkflow" },
  schedule: { binding: "EMAIL_SCHEDULER", className: "EmailSchedulerWorkflow", schedule: "* * * * *" },
} as const;

/** The registry the host resolver derives its `workflows` array from. */
export const emailWorkflowRegistry: WorkflowRegistry = Object.fromEntries(
  Object.entries(EMAIL_HOST_JOBS).map(([job, spec]) => {
    const key = workflowKey(EMAIL_CAPABILITY, job);
    return [key, { key, capability: EMAIL_CAPABILITY, job, spec: { ...spec, params: z.unknown() } }];
  }),
);

/** The resolved resource ids + per-env values for one environment's email-worker deploy. */
export interface EmailConfigParams {
  /**
   * The project name — the `<project>` segment the worker, both Workflows, and the suppression
   * database name lead with. The root `pithy.config.ts` `name`, resolved by `requireProjectName` and
   * never guessed: Worker script and Workflow names are account-scoped, so a wrong value here
   * overwrites another project's running email host.
   */
  project: string;
  env: ManagedEnvironment;
  /** The app database id for this environment — where jobs/events live. */
  appDatabaseId: string;
  /** The shared suppression database id (same in every environment). */
  suppressionDatabaseId: string;
  /** This environment's secrets database id (`<project>-<env>-secrets`) — holds the signing key. */
  secretsDatabaseId: string;
  /** The CF Secrets Store id holding the per-env master key. */
  storeId: string;
  /** The app worker's public base URL for this environment — callback links are built against it. */
  baseUrl: string;
  /** The resolved brand theme — serialized into the worker's `EMAIL_THEME` var. */
  theme: EmailTheme;
  // No `schedulerEnabled`. `EmailConfig.schedulerEnabled` is parsed and exposed but never arrives
  // here, so the template's hardcoded SCHEDULER_ENABLED="true" always wins — a known defect, filed
  // rather than fixed, because closing it changes this signature and the provisioner's option bag,
  // both of which are pinned by tests.
}

/**
 * Resolve the email-worker `wrangler.jsonc` template into one environment's standalone config — no
 * `[env.*]` stanzas (staging and prod are genuinely separate workers, per CLAUDE.md).
 *
 * The mechanics are `@pithy-sh/core`'s {@link resolveWorkflowHost}: this is the email-shaped face of
 * it, mapping email's seven inputs onto the generic host params. What stays here is the part that is
 * genuinely email's — which binding takes which database id, and the `@pithy-sh/secrets` import that
 * names the env-scoped master key. Core must never depend on `@pithy-sh/secrets`, so the resolved
 * string is passed in rather than the naming rule being hoisted.
 *
 * Only `EMAIL_SUPPRESSIONS`'s `database_name` is rewritten. That database is email's own, and its name
 * now carries the project — leaving the template's `pithy-email-suppressions` in place would print a
 * name no account holds. `pithy-app` and `pithy-secrets` are owned elsewhere and pass through
 * untouched; only their ids differ per environment.
 */
export function resolveEmailConfig(
  template: EmailWorkerWranglerTemplate,
  params: EmailConfigParams,
): EmailWorkerWranglerTemplate {
  const { project, env, appDatabaseId, suppressionDatabaseId, secretsDatabaseId, storeId, baseUrl, theme } = params;
  const resolved = resolveWorkflowHost(template, {
    project,
    capability: EMAIL_CAPABILITY,
    env,
    databaseIds: {
      DB: appDatabaseId,
      EMAIL_SUPPRESSIONS: suppressionDatabaseId,
      SECRETS: secretsDatabaseId,
    },
    databaseNames: { EMAIL_SUPPRESSIONS: suppressionDatabaseName(project) },
    secretsStoreId: storeId,
    // The master key entry is project- and env-scoped, matching what the secrets manager wrote.
    masterKeySecretName: masterKeySecretName(project, env),
    vars: { EMAIL_THEME: JSON.stringify(theme), BASE_URL: baseUrl },
    // Both Workflows, derived from the registry. A Workflow name is account-scoped, so the deployed
    // name has to carry the project — the template's `pithy-email-send` cannot be suffixed into one.
    workflows: hostWorkflowsFor(emailWorkflowRegistry, { project, capability: EMAIL_CAPABILITY, env }).workflows,
  });
  // The resolver fills fields; it never drops one. So every field this template narrows to required
  // survives — knowledge the generic return type cannot express, restored here.
  return resolved as EmailWorkerWranglerTemplate;
}

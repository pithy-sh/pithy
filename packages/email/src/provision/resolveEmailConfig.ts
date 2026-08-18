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
import type { EmailTheme } from "../templates/theme";
import { EmailScheduleParams, EmailSendParams } from "../workflows/params";
import { type DevMailDelivery, emailRemoteBindings } from "./devDelivery";
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
 * the committed template byte for byte.
 *
 * **`params` is no longer a placeholder** (pithy-sh/pithy#410). The host mounts the shared dispatch
 * route, and that route validates an arriving loopback payload against the declaring spec's own
 * schema before it starts anything — so the registry's `params` is the request contract of a real
 * HTTP surface. Both sides therefore read the one schema out of `workflows/params.ts`; a `z.unknown()`
 * here would let a malformed dispatch through to fail inside a durable instance instead.
 */
const EMAIL_HOST_JOBS = {
  send: { binding: "EMAIL_SENDER", className: "EmailSendWorkflow", params: EmailSendParams },
  schedule: {
    binding: "EMAIL_SCHEDULER",
    className: "EmailSchedulerWorkflow",
    params: EmailScheduleParams,
    schedule: "* * * * *",
  },
} as const;

/** The registry the host resolver derives its `workflows` array from, and the host's app dispatches on. */
export const emailWorkflowRegistry: WorkflowRegistry = Object.fromEntries(
  Object.entries(EMAIL_HOST_JOBS).map(([job, spec]) => {
    const key = workflowKey(EMAIL_CAPABILITY, job);
    return [key, { key, capability: EMAIL_CAPABILITY, job, spec }];
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
  /**
   * The environment being resolved. `dev` as well as a deployed one: `pithy dev` resolves this same
   * template into the local host config it runs, which is what {@link EmailConfigParams.devDelivery}
   * governs.
   */
  env: ManagedEnvironment | "dev";
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
  /**
   * What the host's `send_email` binding does under `pithy dev` — the adopter's `email({ devDelivery })`.
   * Defaults to `remote`, which sends real mail from the developer's machine. Ignored outside `dev`.
   */
  devDelivery?: DevMailDelivery;
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
 * `send_email`'s `remote` flag is the one thing here that is a *decision* rather than a fill: real
 * delivery is the default in every environment, and `dev` alone may choose the local simulator
 * instead (`devDelivery.ts`).
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
    // The `send_email` binding's `remote` flag, which the committed template deliberately no longer
    // carries: the resolver only ever *adds* `remote`, so a hardcoded `true` could never be turned
    // off and the documented simulator flag would have had nothing to act on. See `devDelivery.ts`.
    remoteBindings: emailRemoteBindings(env, params.devDelivery ?? "remote"),
    // Both Workflows, derived from the registry. A Workflow name is account-scoped, so the deployed
    // name has to carry the project — the template's `pithy-email-send` cannot be suffixed into one.
    workflows: hostWorkflowsFor(emailWorkflowRegistry, { project, capability: EMAIL_CAPABILITY, env }).workflows,
  });
  // The resolver fills fields; it never drops one. So every field this template narrows to required
  // survives — knowledge the generic return type cannot express, restored here.
  return resolved as EmailWorkerWranglerTemplate;
}
